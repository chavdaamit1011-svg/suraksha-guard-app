/**
 * One-time-code check shared by login and by sensitive in-app actions (PRD 18.11: a bank or UPI
 * change needs the guard to re-verify with an OTP).
 *
 * Uses the same per-process store as `/api/guard/auth/send-otp`, so the app requests a code the
 * usual way and presents it here. A code is consumed on success and cannot be replayed.
 */
type Rec = { code: string; expiresAt: number; fails?: number };

const MAX_FAILS = 5;

function otpStore(): Record<string, Rec> {
  return ((globalThis as any).__guardOtp ??= {});
}

export function normPhone(phone: string): string {
  return `+91${String(phone || '').replace(/\D/g, '').slice(-10)}`;
}

function smsGatewayConfigured(): boolean {
  return !!(process.env.MSG91_AUTHKEY || process.env.FAST2SMS_API_KEY || process.env.TWILIO_ACCOUNT_SID);
}

/**
 * Test conveniences (echoing the OTP, the demo code 123456) are only allowed on a development
 * server or with GUARD_OTP_DEV_ECHO=1. On a production server a missing gateway means nobody can
 * sign in — which is the safe failure — instead of everybody being able to.
 */
export function otpDevEcho(): boolean {
  if (process.env.GUARD_OTP_DEV_ECHO === '0') return false;
  if (!smsGatewayConfigured()) return true;
  return process.env.GUARD_OTP_DEV_ECHO === '1' || process.env.NODE_ENV !== 'production';
}

export type OtpCheck = { ok: true } | { ok: false; code: 'otp_expired' | 'otp_invalid'; message: string };

export function consumeOtp(phone: string, otp: string): OtpCheck {
  const key = normPhone(phone);
  const store = otpStore();
  const rec = store[key];

  // Same development allowance as login: the demo code works only while no SMS gateway exists.
  if (String(otp) === '123456' && !smsGatewayConfigured() && otpDevEcho()) {
    delete store[key];
    return { ok: true };
  }
  if (!rec || Date.now() > rec.expiresAt) {
    return { ok: false, code: 'otp_expired', message: 'OTP expired. Request a new one.' };
  }
  if (String(otp) !== rec.code) {
    // Five wrong tries burn the code, so a 6-digit OTP cannot be walked.
    rec.fails = (rec.fails ?? 0) + 1;
    if (rec.fails >= MAX_FAILS) delete store[key];
    return { ok: false, code: 'otp_invalid', message: 'Invalid OTP.' };
  }
  delete store[key];
  return { ok: true };
}
