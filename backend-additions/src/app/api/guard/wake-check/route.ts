import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { connectToDatabase } from '@/lib/db';
import { GuardWakeSchedule } from '@/lib/models/GuardWakeSchedule';
import { ingestWakeCheck } from '@/lib/guardFieldIngest';
import { callForMissedWake } from '@/lib/guardVoice';

export const dynamic = 'force-dynamic';

/**
 * Night anti-sleep wake-check acknowledgement (PRD 18.8). Online path; the offline path is
 * /api/guard/sync, and both call the same ingest. Idempotent on clientEventUuid.
 *
 * A recorded *miss* is as important as an acknowledgement: if the device was offline when the
 * prompt fired, the miss is captured locally and arrives here later, while the server's own
 * sweep (GET below) independently catches prompts that were never answered at all.
 */
export async function POST(req: Request) {
  try {
    const b = await req.json();
    if (!b.guardId) return NextResponse.json({ success: false, message: 'guardId required' }, { status: 400 });

    await connectToDatabase();
    const r = await ingestWakeCheck({
      guardId: b.guardId,
      clientEventUuid: b.clientEventUuid ?? crypto.randomUUID(),
      wakeId: b.wakeId,
      rosterId: b.rosterId,
      bookingId: b.bookingId,
      missed: !!b.missed,
      attempt: Number(b.attempt ?? 1),
      respondedMs: b.respondedMs,
      deviceTime: b.at ?? b.deviceTime,
      lat: b.lat,
      lng: b.lng,
      mediaIds: b.mediaIds ?? [],
    });

    return NextResponse.json({
      success: true,
      duplicate: r.duplicate,
      status: r.status,
      wakeId: r.wakeId,
      missCount: r.missCount,
      escalation: r.escalation,
    });
  } catch (error: any) {
    if (error?.code === 11000) return NextResponse.json({ success: true, duplicate: true });
    return NextResponse.json({ success: false, message: error?.message ?? 'wake-check failed' }, { status: 500 });
  }
}

/**
 * The guard's own wake-check compliance (PRD 18.8 GAP-S-036), and the server-side miss sweep.
 *
 * Any prompt whose acknowledgement window closed more than a grace period ago without an answer
 * is marked `missed` here — PRD 18.8 §10: the server detects the absence of an expected
 * acknowledgement independently of the device, because a dead phone cannot report its own miss.
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const guardId = searchParams.get('guardId');
    if (!guardId) return NextResponse.json({ success: false, message: 'guardId required' }, { status: 400 });

    await connectToDatabase();

    const graceMs = 5 * 60_000; // absorb a late flush from a device that just regained signal
    const now = Date.now();
    // A `reprompted` slot is still open: the device re-prompts a minute after the first miss, so
    // it gets that minute plus its own window before the server calls it.
    const stale: any[] = await GuardWakeSchedule.find({ guardId, status: { $in: ['pending', 'reprompted'] } })
      .lean()
      .catch(() => []);
    const overdue = stale.filter((s) => {
      const extra = s.status === 'reprompted' ? 60_000 + (s.ackWindowSec ?? 120) * 1000 : 0;
      return new Date(s.dueAt).getTime() + (s.ackWindowSec ?? 120) * 1000 + extra + graceMs < now;
    });
    if (overdue.length > 0) {
      // A dead phone cannot report its own miss — this is the server noticing on its behalf, and
      // it escalates exactly as a device-reported second miss would.
      await GuardWakeSchedule.updateMany(
        { _id: { $in: overdue.map((s) => s._id) } },
        { $set: { status: 'missed', escalatedAt: 'P2' }, $max: { missCount: 2 } }
      ).catch(() => {});
      for (const s of overdue) void callForMissedWake(String(s._id), guardId);
      try {
        for (const s of overdue) {
          (globalThis as any).__io?.emit?.('new-notification', {
            kind: 'WAKE_CHECK_MISSED',
            priority: 'P2',
            audience: 'supervisor',
            source: 'server_sweep',
            guardId,
            wakeId: String(s._id),
            siteName: s.siteName,
            at: new Date().toISOString(),
          });
        }
      } catch {
        /* ignore */
      }
    }

    const schedule = await GuardWakeSchedule.find({ guardId })
      .sort({ dueAt: -1 })
      .limit(60)
      .lean();

    return NextResponse.json({ success: true, schedule, sweptMissed: overdue.length });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'wake history failed' }, { status: 500 });
  }
}
