import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectToDatabase } from '@/lib/db';
import { APGuard } from '@/lib/models/APGuard';
import { GuardAppProfile } from '@/lib/models/GuardAppProfile';
import { bearer, issueSession, readRefreshable } from '@/lib/guardSession';

export const dynamic = 'force-dynamic';

/**
 * Renew a guard session (see src/lib/guardSession.ts).
 *
 *   POST  Authorization: Bearer <token up to 90 days old>  → { sessionToken, sessionExpiresAt }
 *
 * Refused when the guard logged out since (sessionVersion moved on), no longer exists, or the
 * token was issued to a device other than the one now bound.
 */
export async function POST(req: Request) {
  try {
    const old = await readRefreshable(bearer(req));
    if (!old || !mongoose.Types.ObjectId.isValid(old.g)) {
      return NextResponse.json({ success: false, code: 'session_invalid', message: 'Please sign in again.' }, { status: 401 });
    }

    await connectToDatabase();
    const [guard, profile]: any[] = await Promise.all([
      APGuard.findById(old.g).select('_id status').lean(),
      GuardAppProfile.findOne({ guardId: old.g }).select('sessionVersion boundDeviceId').lean(),
    ]);
    if (!guard) {
      return NextResponse.json({ success: false, code: 'session_invalid', message: 'Please sign in again.' }, { status: 401 });
    }
    if ((profile?.sessionVersion ?? 0) !== old.v) {
      return NextResponse.json({ success: false, code: 'session_revoked', message: 'You were signed out. Please sign in again.' }, { status: 401 });
    }
    if (old.d && profile?.boundDeviceId && profile.boundDeviceId !== old.d) {
      return NextResponse.json({ success: false, code: 'device_changed', message: 'This phone is no longer linked to your account.' }, { status: 401 });
    }

    const session = await issueSession(old.g, old.d, profile?.sessionVersion ?? 0);
    return NextResponse.json({ success: true, sessionToken: session?.token ?? null, sessionExpiresAt: session?.expiresAt ?? null });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'refresh failed' }, { status: 500 });
  }
}
