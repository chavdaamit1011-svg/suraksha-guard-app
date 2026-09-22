import { NextResponse } from 'next/server';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { connectToDatabase } from '@/lib/db';
import { APGuard } from '@/lib/models/APGuard';
import { GuardTrainingRecord } from '@/lib/models/GuardTrainingRecord';
import { CATALOGUE_VERSION, TRAINING_CATALOGUE, findModule } from '@/lib/guardTrainingCatalogue';

export const dynamic = 'force-dynamic';

/**
 * Training (PRD 18.14, SUR-GAP-024).
 *
 *   GET  ?guardId=        the catalogue with this guard's progress folded in
 *   POST { action }       lesson_done | quiz_attempt
 *
 * The catalogue is returned in full, with lesson bodies and quiz questions, so the app can cache
 * it and a guard can complete a module **offline** — PRD 18.15.2 allows training content only if
 * pre-downloaded, and downloading the whole thing is a few kilobytes of text.
 *
 * The correct answers are deliberately **not** sent to the device. The quiz is graded server-side.
 * A guard who can read the bundle should not be able to read the answer key, and a completion that
 * gates deployment to an armed post has to mean something.
 */

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const guardId = searchParams.get('guardId');

    // The catalogue alone, for a device that has not logged in yet.
    if (!guardId) {
      return NextResponse.json({
        success: true,
        version: CATALOGUE_VERSION,
        modules: TRAINING_CATALOGUE.map(stripAnswers),
      });
    }
    if (!mongoose.Types.ObjectId.isValid(guardId)) {
      return NextResponse.json({ success: false, message: 'Invalid guardId' }, { status: 400 });
    }

    await connectToDatabase();
    const records: any[] = await GuardTrainingRecord.find({ guardId }).lean().catch(() => []);

    const now = Date.now();
    const modules = TRAINING_CATALOGUE.map((m) => {
      const rec = records.find((r) => r.moduleId === m.id);
      // A completion that has lapsed reverts to Pending rather than lingering as a green tick.
      const lapsed = !!rec?.expiresOn && new Date(rec.expiresOn).getTime() < now;
      return {
        ...stripAnswers(m),
        progress: {
          status: lapsed ? 'Pending' : (rec?.status ?? 'Pending'),
          lessonsCompleted: rec?.lessonsCompleted ?? [],
          totalLessons: m.lessons.length,
          bestScorePct: rec?.bestScorePct ?? 0,
          passed: lapsed ? false : !!rec?.passed,
          attempts: (rec?.attempts ?? []).length,
          completedAt: rec?.completedAt ?? null,
          expiresOn: rec?.expiresOn ?? null,
          expired: lapsed,
          certificateId: lapsed ? '' : (rec?.certificateId ?? ''),
        },
      };
    });

    const mandatoryOutstanding = modules.filter((m) => m.mandatory && !m.progress.passed).length;

    return NextResponse.json({
      success: true,
      version: CATALOGUE_VERSION,
      modules,
      mandatoryOutstanding,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'training failed' }, { status: 500 });
  }
}

/** The catalogue as the device sees it: everything except which answer is right. */
function stripAnswers(m: (typeof TRAINING_CATALOGUE)[number]) {
  return {
    id: m.id,
    title: m.title,
    summary: m.summary,
    minutes: m.minutes,
    mandatory: m.mandatory,
    gatesPostTypes: m.gatesPostTypes,
    validityMonths: m.validityMonths,
    passMarkPct: m.passMarkPct,
    icon: m.icon,
    lessons: m.lessons,
    quiz: m.quiz.map((q) => ({
      id: q.id,
      prompt: q.prompt,
      options: q.options,
    })),
  };
}

export async function POST(req: Request) {
  try {
    const b = await req.json();
    const guardId = String(b.guardId ?? '');
    const moduleId = String(b.moduleId ?? '');
    const action = String(b.action ?? '');

    if (!guardId || !moduleId || !action) {
      return NextResponse.json(
        { success: false, message: 'guardId, moduleId and action are required' },
        { status: 400 }
      );
    }
    if (!mongoose.Types.ObjectId.isValid(guardId)) {
      return NextResponse.json({ success: false, message: 'Invalid guardId' }, { status: 400 });
    }

    const mod = findModule(moduleId);
    if (!mod) return NextResponse.json({ success: false, message: 'unknown module' }, { status: 404 });

    await connectToDatabase();

    if (action === 'lesson_done') {
      const lessonId = String(b.lessonId ?? '');
      if (!mod.lessons.some((l) => l.id === lessonId)) {
        return NextResponse.json({ success: false, message: 'unknown lesson' }, { status: 400 });
      }

      const rec: any = await GuardTrainingRecord.findOneAndUpdate(
        { guardId, moduleId },
        {
          $addToSet: { lessonsCompleted: lessonId },
          $set: {
            status: 'In Progress',
            totalLessons: mod.lessons.length,
            lastOpenedAt: new Date(),
          },
          $setOnInsert: { startedAt: new Date() },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();

      return NextResponse.json({
        success: true,
        lessonsCompleted: rec.lessonsCompleted,
        totalLessons: mod.lessons.length,
        allLessonsDone: rec.lessonsCompleted.length >= mod.lessons.length,
      });
    }

    if (action === 'quiz_attempt') {
      const answers: Record<string, string> = b.answers ?? {};
      const studySeconds = Number(b.studySeconds ?? 0);

      // Graded here, against the answers the device was never given.
      const wrong: string[] = [];
      for (const q of mod.quiz) {
        if (answers[q.id] !== q.correctOptionId) wrong.push(q.id);
      }
      const total = mod.quiz.length || 1;
      const scorePct = Math.round(((total - wrong.length) / total) * 100);
      const passed = scorePct >= mod.passMarkPct;

      const existing: any = await GuardTrainingRecord.findOne({ guardId, moduleId }).lean();
      const bestScorePct = Math.max(existing?.bestScorePct ?? 0, scorePct);

      const expiresOn =
        passed && mod.validityMonths
          ? new Date(Date.now() + mod.validityMonths * 30 * 24 * 3600_000)
          : (existing?.expiresOn ?? null);

      // Certificates are tenant-signed artefacts (PRD 18.14): the signature covers the facts, so
      // a certificate shown later can be checked rather than taken on trust.
      let certificateId: string = existing?.certificateId ?? '';
      let certificateSig: string = existing?.certificateSig ?? '';
      if (passed && !certificateId) {
        const guard: any = await APGuard.findById(guardId).select('name agencyId').lean();
        certificateId = `CERT-${moduleId.toUpperCase()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
        certificateSig = signCertificate({
          certificateId,
          guardId,
          guardName: guard?.name ?? '',
          moduleId,
          scorePct,
          issuedAt: new Date().toISOString(),
        });
      }

      await GuardTrainingRecord.updateOne(
        { guardId, moduleId },
        {
          $push: {
            attempts: { at: new Date(), scorePct, passed, wrongQuestionIds: wrong, studySeconds },
          },
          $set: {
            status: passed ? 'Completed' : 'In Progress',
            totalLessons: mod.lessons.length,
            bestScorePct,
            passed: passed || !!existing?.passed,
            ...(passed ? { completedAt: new Date(), certificateId, certificateSig, expiresOn } : {}),
            lastOpenedAt: new Date(),
          },
          $setOnInsert: { startedAt: new Date() },
        },
        { upsert: true }
      );

      return NextResponse.json({
        success: true,
        scorePct,
        passed,
        passMarkPct: mod.passMarkPct,
        // Which ones were wrong, so the guard can be shown what to look at again — but not what
        // the right answer was, so retaking still requires learning it.
        wrongQuestionIds: wrong,
        attemptsSoFar: (existing?.attempts?.length ?? 0) + 1,
        certificateId: passed ? certificateId : '',
        expiresOn: passed ? expiresOn : null,
      });
    }

    return NextResponse.json({ success: false, message: 'unknown action' }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'training write failed' }, { status: 500 });
  }
}

function signCertificate(facts: Record<string, unknown>): string {
  const secret = process.env.GUARD_CERT_SECRET || process.env.JWT_SECRET || 'suraksha-cert';
  return crypto.createHmac('sha256', secret).update(JSON.stringify(facts)).digest('hex').slice(0, 32);
}
