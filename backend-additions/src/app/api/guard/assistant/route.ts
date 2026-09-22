import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import mongoose from 'mongoose';
import { connectToDatabase } from '@/lib/db';
import { APGuard } from '@/lib/models/APGuard';
import { AgencyRoster } from '@/lib/models/AgencyRoster';
import { GuardPayslip } from '@/lib/models/GuardPayslip';
import { addDays, istDateKey } from '@/lib/guardRoster';
import { leaveBalance } from '@/lib/guardLeave';

export const dynamic = 'force-dynamic';

/**
 * Guard assistant (PRD 18.14 / §25, §41, SUR-GAP-037).
 *
 *   POST { guardId, message, lang, history?: [{ role, text }] } → { reply, source }
 *
 * Limited to the two classes the PRD allows a guard-facing assistant: **read-only** (what is my
 * shift, how many leave days do I have) and **recommendation** (where in the app to do something).
 * It never performs an action — marking attendance, applying for leave or raising an SOS stay in
 * the screens built for them, with their own evidence and checks.
 *
 * Common questions are answered from the guard's own data with no model call. Anything else goes
 * to Claude when ANTHROPIC_API_KEY is configured, with the same read-only context; without a key
 * the assistant says what it can help with.
 */

const MODEL = 'claude-opus-5';
const HOURLY_LIMIT = 30;
const calls: Record<string, number[]> = ((globalThis as any).__guardAssistantCalls ??= {});

type Lang = 'hi' | 'en' | string;

const say = (lang: Lang, hi: string, en: string) => (lang === 'hi' ? hi : en);

function rupees(paise: number) {
  return `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
}

type Ctx = {
  today: string;
  guard: { name: string; agency: string; type: string; city: string } | null;
  shifts: { date: string; timing: string; site: string; shiftType: string; status: string; checkedInAt: string }[];
  leave: { type: string; left: number | null; used: number }[];
  lastPayslip: { period: string; net: string; status: string; reference: string } | null;
};

async function guardContext(guardId: string): Promise<Ctx> {
  const today = istDateKey();
  const [guard, rosters, balance, payslip]: any[] = await Promise.all([
    APGuard.findById(guardId).select('name agencyName type city').lean(),
    AgencyRoster.find({
      'assignedGuards.guardId': new mongoose.Types.ObjectId(guardId),
      date: { $in: [today, addDays(today, 1)] },
    })
      .select('date timing siteName shiftType assignedGuards.$')
      .sort({ date: 1 })
      .lean()
      .catch(() => []),
    leaveBalance(guardId).catch(() => []),
    GuardPayslip.findOne({ guardId, status: { $ne: 'Draft' } }).sort({ period: -1 }).lean().catch(() => null),
  ]);
  return {
    today,
    guard: guard ? { name: guard.name, agency: guard.agencyName, type: guard.type, city: guard.city } : null,
    shifts: rosters.map((r: any) => ({
      date: r.date,
      timing: r.timing,
      site: r.siteName,
      shiftType: r.shiftType,
      status: r.assignedGuards?.[0]?.status ?? '',
      checkedInAt: r.assignedGuards?.[0]?.checkInTime ?? '',
    })),
    leave: balance.map((b: any) => ({ type: b.type, left: b.left, used: b.used })),
    lastPayslip: payslip
      ? { period: payslip.period, net: rupees(payslip.netPaise), status: payslip.status, reference: payslip.referenceNo || '' }
      : null,
  };
}

/** Answers that need no model: the guard's own facts, in their language. */
function ruleAnswer(text: string, lang: Lang, ctx: Ctx): string | null {
  const q = text.toLowerCase();
  const has = (...words: string[]) => words.some((w) => q.includes(w));

  if (has('sos', 'emergency', 'danger', 'attack', 'bachao', 'khatra', 'khatre', 'खतरा', 'इमरजेंसी', 'मदद चाहिए', 'बचाओ')) {
    return say(
      lang,
      'खतरे में हों तो लाल SOS बटन को 2 सेकंड दबाकर रखें — आपकी लोकेशन सुपरवाइज़र और कंट्रोल रूम को तुरंत जाती है। जान का खतरा हो तो 112 पर कॉल करें।',
      'If you are in danger, press and hold the red SOS button for 2 seconds — your location goes to your supervisor and the control room at once. If life is at risk, call 112.'
    );
  }

  if (has('shift', 'duty', 'dyuti', 'roster', 'timing', 'ड्यूटी', 'शिफ्ट', 'रोस्टर', 'कब है')) {
    if (ctx.shifts.length === 0) {
      return say(lang, 'आज और कल के लिए आपकी कोई ड्यूटी नहीं है।', 'You have no duty today or tomorrow.');
    }
    return ctx.shifts
      .map((s) => {
        const when = s.date === ctx.today ? say(lang, 'आज', 'Today') : say(lang, 'कल', 'Tomorrow');
        const inAt = s.checkedInAt ? say(lang, ` (चेक-इन ${s.checkedInAt})`, ` (checked in ${s.checkedInAt})`) : '';
        return `${when}: ${s.site}, ${s.timing}${inAt}`;
      })
      .join('\n');
  }

  if (has('leave', 'chutti', 'chhutti', 'chuti', 'chhuti', 'holiday', 'छुट्टी', 'छुट्टियाँ', 'अवकाश')) {
    const casual = ctx.leave.find((l) => l.type === 'casual');
    const sick = ctx.leave.find((l) => l.type === 'sick');
    return say(
      lang,
      `इस साल बची छुट्टी — आकस्मिक: ${casual?.left ?? '-'} दिन, बीमारी: ${sick?.left ?? '-'} दिन। छुट्टी माँगने के लिए होम पर "छुट्टी" खोलें।`,
      `Leave left this year — casual: ${casual?.left ?? '-'} days, sick: ${sick?.left ?? '-'} days. To ask for leave, open "Leave" on the home screen.`
    );
  }

  if (has('salary', 'pay', 'payslip', 'wage', 'paisa', 'paise', 'tankha', 'tankhwah', 'tanakhwah', 'vetan', 'pagar', 'वेतन', 'सैलरी', 'तनख्वाह', 'पैसे', 'पेस्लिप')) {
    if (!ctx.lastPayslip) {
      return say(lang, 'अभी कोई पक्की पेस्लिप नहीं है। इस महीने का अनुमान "पेस्लिप" में देखें।', 'There is no finalised payslip yet. See this month\'s estimate under "Payslip".');
    }
    const p = ctx.lastPayslip;
    const paid = p.status === 'Completed';
    return say(
      lang,
      `${p.period} की पेस्लिप: ${p.net}${paid ? `, भुगतान हो चुका (UTR ${p.reference || '-'})` : ', भुगतान बाकी'}। कुछ गलत लगे तो पेस्लिप में "कुछ गलत लग रहा है" दबाएं।`,
      `Payslip for ${p.period}: ${p.net}${paid ? `, paid (UTR ${p.reference || '-'})` : ', payment pending'}. If something looks wrong, tap "Something looks wrong" on the payslip.`
    );
  }

  return null;
}

function systemPrompt(lang: Lang) {
  return [
    'You are the in-app assistant of Suraksha Guard, used by private security guards in India on their phones.',
    `Reply in ${lang === 'hi' ? 'Hindi (Devanagari script)' : lang === 'en' ? 'simple English' : `the language with code "${lang}"`}, in two to four short sentences. Many readers have limited schooling: plain words, no jargon, no markdown.`,
    'You can only explain and recommend. You cannot mark attendance, apply for leave, change details, contact anyone or raise an SOS, and you must never say you did. Point the guard to the screen that does it: Check in / Check out on the home screen, Patrol, Incident, Leave, Payslip, Documents, Help (call or raise a ticket), Profile → My details.',
    'Use only the facts in the guard context below for anything about this guard. If the answer is not there, say you do not know and suggest Help.',
    'If the guard may be in danger, tell them to hold the red SOS button for 2 seconds and to call 112 if life is at risk.',
  ].join('\n');
}

export async function POST(req: Request) {
  try {
    const b = await req.json();
    const guardId = String(b.guardId ?? '');
    const message = String(b.message ?? '').trim().slice(0, 1000);
    const lang: Lang = String(b.lang ?? 'hi');
    if (!mongoose.Types.ObjectId.isValid(guardId) || !message) {
      return NextResponse.json({ success: false, message: 'guardId and message required' }, { status: 400 });
    }

    const now = Date.now();
    const recent = (calls[guardId] ?? []).filter((t) => now - t < 3600_000);
    if (recent.length >= HOURLY_LIMIT) {
      return NextResponse.json({
        success: true,
        source: 'limit',
        reply: say(lang, 'बहुत सारे सवाल हो गए। थोड़ी देर बाद पूछें, या मदद में टिकट भेजें।', 'You have asked a lot of questions. Try again later, or raise a ticket from Help.'),
      });
    }
    calls[guardId] = [...recent, now];

    await connectToDatabase();
    const ctx = await guardContext(guardId);

    const direct = ruleAnswer(message, lang, ctx);
    if (direct) return NextResponse.json({ success: true, source: 'rules', reply: direct });

    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({
        success: true,
        source: 'rules',
        reply: say(
          lang,
          'मैं आपकी ड्यूटी, छुट्टी, वेतन और SOS के बारे में बता सकता हूँ। बाकी के लिए मदद में टिकट भेजें।',
          'I can tell you about your duty, leave, pay and SOS. For anything else, raise a ticket from Help.'
        ),
      });
    }

    const history: Anthropic.Beta.BetaMessageParam[] = (Array.isArray(b.history) ? b.history : [])
      .slice(-6)
      .filter((m: any) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.text === 'string' && m.text.trim())
      .map((m: any) => ({ role: m.role, content: String(m.text).slice(0, 1000) }));
    // The conversation must start with the guard.
    while (history.length && history[0].role !== 'user') history.shift();

    const client = new Anthropic();
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 1024, // replies are deliberately a few sentences
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' }, // short, routine chat
      system: [
        { type: 'text', text: systemPrompt(lang), cache_control: { type: 'ephemeral' } },
        { type: 'text', text: `Guard context (read-only):\n${JSON.stringify(ctx)}` },
      ],
      messages: [...history, { role: 'user', content: message }],
    });

    if (response.stop_reason === 'refusal') {
      return NextResponse.json({
        success: true,
        source: 'ai',
        reply: say(lang, 'मैं इसमें मदद नहीं कर सकता। मदद में जाकर सुपरवाइज़र से बात करें।', 'I cannot help with that. Please contact your supervisor from Help.'),
      });
    }
    const reply = response.content
      .filter((c): c is Anthropic.Beta.BetaTextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
      .trim();

    return NextResponse.json({ success: true, source: 'ai', reply: reply || say(lang, 'माफ़ कीजिए, अभी जवाब नहीं मिला।', 'Sorry, no answer right now.') });
  } catch (error: any) {
    if (error instanceof Anthropic.RateLimitError || (error instanceof Anthropic.APIError && (error.status ?? 0) >= 500)) {
      return NextResponse.json({ success: false, code: 'assistant_busy', message: 'The assistant is busy. Try again in a minute.' }, { status: 503 });
    }
    if (error instanceof Anthropic.APIError) {
      return NextResponse.json({ success: false, code: 'assistant_error', message: 'The assistant is not available right now.' }, { status: 502 });
    }
    return NextResponse.json({ success: false, message: error?.message ?? 'assistant failed' }, { status: 500 });
  }
}
