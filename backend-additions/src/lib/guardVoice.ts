import { APGuard } from '@/lib/models/APGuard';
import { GuardWakeSchedule } from '@/lib/models/GuardWakeSchedule';

/**
 * IVR call to a guard who missed a wake check twice (PRD 18.8 §9 / SUR-GAP-016: "re-prompt → IVR
 * call + supervisor P2 → Command Center P1").
 *
 * Provider-agnostic, like the SMS sender. Configure ONE of:
 *   EXOTEL_SID + EXOTEL_API_KEY + EXOTEL_API_TOKEN + EXOTEL_CALLER_ID + EXOTEL_WAKE_FLOW_ID
 *     (an Exotel app/flow that plays the wake message; subdomain via EXOTEL_SUBDOMAIN, default api.exotel.com)
 *   TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM
 * With neither, the call is recorded as `not_configured` and the supervisor escalation still runs —
 * the ladder never stalls on a missing rung.
 *
 * At most one call per wake slot: the slot is claimed before dialling.
 */

type CallResult = { placed: boolean; provider: string; ref?: string; error?: string };

const HINDI_PROMPT =
  'सुरक्षा गार्ड ऐप। आपने जागने की जाँच का जवाब नहीं दिया। कृपया अभी ऐप खोलें और जवाब दें। आपके सुपरवाइज़र को सूचना दी गई है।';
const ENGLISH_PROMPT =
  'Suraksha Guard. You missed your wake check. Please open the app and respond now. Your supervisor has been informed.';

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function dial(phoneE164: string): Promise<CallResult> {
  const to10 = phoneE164.replace(/\D/g, '').slice(-10);
  try {
    if (
      process.env.EXOTEL_SID &&
      process.env.EXOTEL_API_KEY &&
      process.env.EXOTEL_API_TOKEN &&
      process.env.EXOTEL_CALLER_ID &&
      process.env.EXOTEL_WAKE_FLOW_ID
    ) {
      const sid = process.env.EXOTEL_SID;
      const host = process.env.EXOTEL_SUBDOMAIN || 'api.exotel.com';
      const body = new URLSearchParams({
        From: `0${to10}`,
        CallerId: process.env.EXOTEL_CALLER_ID,
        Url: `http://my.exotel.com/${sid}/exoml/start_voice/${process.env.EXOTEL_WAKE_FLOW_ID}`,
        CallType: 'trans',
      });
      const res = await fetch(`https://${host}/v1/Accounts/${sid}/Calls/connect.json`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${process.env.EXOTEL_API_KEY}:${process.env.EXOTEL_API_TOKEN}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      const j: any = await res.json().catch(() => ({}));
      return { placed: res.ok, provider: 'exotel', ref: j?.Call?.Sid, error: res.ok ? undefined : `http ${res.status}` };
    }

    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM) {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const twiml =
        `<Response><Say language="hi-IN">${xmlEscape(HINDI_PROMPT)}</Say><Pause length="1"/>` +
        `<Say language="en-IN">${xmlEscape(ENGLISH_PROMPT)}</Say></Response>`;
      const body = new URLSearchParams({ To: `+91${to10}`, From: process.env.TWILIO_FROM, Twiml: twiml });
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      const j: any = await res.json().catch(() => ({}));
      return { placed: res.ok, provider: 'twilio', ref: j?.sid, error: res.ok ? undefined : `http ${res.status}` };
    }
  } catch (e: any) {
    return { placed: false, provider: 'error', error: e?.message };
  }
  return { placed: false, provider: 'not_configured' };
}

/** Call the guard for this wake slot, once. Never throws. */
export async function callForMissedWake(wakeId: string, guardId: string): Promise<CallResult | null> {
  try {
    const claim = await GuardWakeSchedule.updateOne(
      { _id: wakeId, ivrStatus: { $in: [null, ''] } },
      { $set: { ivrStatus: 'dialling', ivrAt: new Date() } }
    );
    if ((claim as any).modifiedCount !== 1) return null; // already called

    const guard: any = await APGuard.findById(guardId).select('phone').lean();
    const result = guard?.phone ? await dial(guard.phone) : { placed: false, provider: 'no_phone' };

    await GuardWakeSchedule.updateOne(
      { _id: wakeId },
      {
        $set: {
          ivrStatus: result.placed ? 'placed' : result.provider === 'not_configured' ? 'not_configured' : 'failed',
          ivrProvider: result.provider,
          ivrRef: result.ref ?? '',
        },
      }
    );
    return result;
  } catch {
    return null;
  }
}
