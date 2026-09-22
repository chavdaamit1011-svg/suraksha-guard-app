import { NextResponse } from 'next/server';
import { sendSms } from '@/lib/guardSms';
import { otpDevEcho } from '@/lib/guardOtp';
import { activeGuardByPhone, guardRemoved } from '@/lib/guardAccess';

/**
 * Guard phone OTP — send (PRD 18.1). 6-digit, 2-min expiry, 30-second resend cooldown,
 * 5 sends per number per 15 min. In-memory per-process store (pm2 fork, single instance),
 * mirroring the existing email OTP route. Real SMS goes out when a gateway env is configured;
 * otherwise the code is returned in the response for development only.
 */
const OTP_EXPIRY_MS = 120_000;
const RESEND_COOLDOWN_MS = 30_000;
const WINDOW_MS = 15 * 60_000;
const MAX_PER_WINDOW = 5;

type Rec = { code: string; expiresAt: number; resendAt: number; sends: number[]; };
const store: Record<string, Rec> = ((globalThis as any).__guardOtp ??= {});

function norm(phone: string) {
  return `+91${String(phone || '').replace(/\D/g, '').slice(-10)}`;
}

export async function POST(req: Request) {
  try {
    const { phone, appHash } = await req.json();
    // SMS Retriever (PRD 18.1): the message must end with the app's 11-character hash for the
    // phone to hand it to the app. The app reports its own hash; GUARD_SMS_APP_HASH overrides.
    const hash = String(process.env.GUARD_SMS_APP_HASH || appHash || '');
    const hashLine = /^[A-Za-z0-9+/]{11}$/.test(hash) ? `\n\n${hash}` : '';
    const key = norm(phone);
    if (key.length !== 13) {
      return NextResponse.json({ success: false, message: 'A valid 10-digit phone is required.' }, { status: 400 });
    }
    const now = Date.now();
    if (!await activeGuardByPhone(key)) return NextResponse.json(guardRemoved, { status: 401 });
    const rec = store[key] ?? { code: '', expiresAt: 0, resendAt: 0, sends: [] };
    rec.sends = rec.sends.filter((t) => now - t < WINDOW_MS);
    if (rec.sends.length >= MAX_PER_WINDOW) {
      return NextResponse.json({ success: false, message: 'Too many attempts. Try again later.' }, { status: 429 });
    }
    if (now < rec.resendAt) {
      return NextResponse.json({ success: false, message: 'Please wait before requesting another OTP.', resendAvailableAt: rec.resendAt }, { status: 429 });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    rec.code = code;
    rec.expiresAt = now + OTP_EXPIRY_MS;
    rec.resendAt = now + RESEND_COOLDOWN_MS;
    rec.sends.push(now);
    store[key] = rec;

    const sms = await sendSms(key, `${code} is your Suraksha Guard verification code. Valid 2 minutes.${hashLine}`);

    return NextResponse.json({
      success: true,
      message: sms.delivered ? 'OTP sent' : 'OTP generated (SMS provider not configured)',
      delivered: sms.delivered,
      provider: sms.provider,
      expiresAt: rec.expiresAt,
      resendAvailableAt: rec.resendAt,
      // Dev fallback only. Returning the code whenever SMS failed would let anyone sign in as any
      // guard in production the moment the gateway hiccups, so it needs a non-production server
      // or an explicit opt-in.
      ...(!sms.delivered && otpDevEcho() ? { devCode: code } : {}),
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  }
}
