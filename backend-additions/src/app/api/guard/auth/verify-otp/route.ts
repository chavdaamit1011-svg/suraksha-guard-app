import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/db';
import { GuardAppProfile } from '@/lib/models/GuardAppProfile';
import { consumeOtp, normPhone } from '@/lib/guardOtp';
import { issueSession } from '@/lib/guardSession';
import { activeGuardByPhone, guardRemoved } from '@/lib/guardAccess';

/**
 * Guard phone OTP — verify (PRD 18.1). On success: if the guard exists, evaluate device binding
 * (PRD 18.6) and return the guard, a deviceStatus and a **session token** the app sends on every
 * later request. A new device does not hard-block login; it flags a pending device change so an
 * Operations Manager can approve, per canon (never block duty).
 *
 * Only current AP/Ops guard records may sign in. Unknown/deleted accounts cannot self-register.
 */
export async function POST(req: Request) {
  try {
    const { phone, otp, deviceId, deviceModel } = await req.json();
    const key = normPhone(phone);

    // Shared with the in-app OTP checks: single use, five wrong tries burn the code, and the
    // demo code only works on a development server (see guardOtp.ts).
    const check = consumeOtp(key, String(otp ?? ''));
    if (!check.ok) {
      return NextResponse.json({ success: false, code: check.code, message: check.message }, { status: 400 });
    }

    await connectToDatabase();
    const guard = await activeGuardByPhone(key);
    if (!guard) {
      return NextResponse.json(guardRemoved, { status: 401 });
    }

    const gid = guard._id.toString();
    let profile = await GuardAppProfile.findOne({ guardId: gid });
    if (!profile) profile = await GuardAppProfile.create({ guardId: gid });

    // Device binding
    let deviceStatus: 'bound' | 'ok' | 'change_pending' = 'ok';
    if (deviceId) {
      if (!profile.boundDeviceId) {
        profile.boundDeviceId = deviceId;
        profile.deviceModel = deviceModel || '';
        deviceStatus = 'bound';
      } else if (profile.boundDeviceId === deviceId) {
        deviceStatus = 'ok';
      } else {
        profile.pendingDeviceId = deviceId;
        profile.lastDeviceChangeAt = new Date();
        deviceStatus = 'change_pending';
      }
      await profile.save();
    }

    const session = await issueSession(gid, String(deviceId ?? ''), profile.sessionVersion ?? 0);
    return NextResponse.json({
      success: true,
      verified: true,
      exists: true,
      guard,
      deviceStatus,
      sessionToken: session?.token ?? null,
      sessionExpiresAt: session?.expiresAt ?? null,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  }
}
