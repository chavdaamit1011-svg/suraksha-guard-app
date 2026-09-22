import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectToDatabase } from '@/lib/db';
import { APGuard } from '@/lib/models/APGuard';
import { GuardAppProfile } from '@/lib/models/GuardAppProfile';
import { deviceStanding } from '@/lib/guardDevice';

export const dynamic = 'force-dynamic';

/**
 * Device binding and device-change approval (PRD 18.1 §9, 18.6, SUR-GAP-006).
 *
 * One active device per guard account. The binding exists because a guard account on two phones
 * is the cheapest attendance fraud there is: one person carries both handsets and marks two
 * people present. So a second device does not simply take over — it raises an approval task, and
 * **duty data is withheld** from the new device until an Operations Manager approves it.
 *
 *   GET   ?guardId=&deviceId=   what this device's standing is
 *   POST  { guardId, decision } approve or reject the pending change (admin-key gated)
 *
 * A guard who reinstalls on the *same* handset keeps the same Android id and is unaffected
 * (18.1 §16), which is the common case this must not punish.
 */

function authorised(req: Request): boolean {
  const expected = process.env.GUARD_ADMIN_KEY;
  if (!expected) return false;
  const given = req.headers.get('x-guard-admin-key') ?? '';
  return given.length === expected.length && given === expected;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const guardId = searchParams.get('guardId');
    const deviceId = searchParams.get('deviceId');
    if (!guardId) return NextResponse.json({ success: false, message: 'guardId required' }, { status: 400 });

    await connectToDatabase();

    // Admin listing: every guard with a change waiting on someone's approval.
    if (guardId === 'pending' && authorised(req)) {
      const profiles: any[] = await GuardAppProfile.find({ pendingDeviceId: { $ne: '' } })
        .select('guardId boundDeviceId pendingDeviceId deviceModel lastDeviceChangeAt')
        .lean();
      const guards: any[] = await APGuard.find({ _id: { $in: profiles.map((p) => p.guardId) } })
        .select('_id name phone agencyId')
        .lean()
        .catch(() => []);
      return NextResponse.json({
        success: true,
        pending: profiles.map((p) => ({
          ...p,
          guard: guards.find((g) => String(g._id) === String(p.guardId)) ?? null,
        })),
      });
    }

    const result = await deviceStanding(guardId, deviceId);
    return NextResponse.json({ success: true, ...result });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'device read failed' }, { status: 500 });
  }
}

/** Approve or reject a pending device change. Admin-key gated: this is an Operations Manager act. */
export async function POST(req: Request) {
  try {
    if (!authorised(req)) return NextResponse.json({ success: false, message: 'unauthorised' }, { status: 401 });

    const b = await req.json();
    const guardId = String(b.guardId ?? '');
    const decision = String(b.decision ?? '');
    if (!guardId || !mongoose.Types.ObjectId.isValid(guardId)) {
      return NextResponse.json({ success: false, message: 'valid guardId required' }, { status: 400 });
    }
    if (decision !== 'approve' && decision !== 'reject' && decision !== 'unbind') {
      return NextResponse.json(
        { success: false, message: 'decision must be approve, reject or unbind' },
        { status: 400 }
      );
    }

    await connectToDatabase();
    const profile: any = await GuardAppProfile.findOne({ guardId });
    if (!profile) return NextResponse.json({ success: false, message: 'profile not found' }, { status: 404 });

    if (decision === 'unbind') {
      // Support-assisted recovery: the next device to log in claims the binding.
      profile.boundDeviceId = '';
      profile.pendingDeviceId = '';
      profile.lastDeviceChangeAt = new Date();
      // Every existing login ends; the guard signs in again on whichever phone they now use.
      profile.sessionVersion = (profile.sessionVersion ?? 0) + 1;
      await profile.save();
      return NextResponse.json({ success: true, standing: 'unbound' });
    }

    if (!profile.pendingDeviceId) {
      return NextResponse.json({ success: true, message: 'no pending device change', standing: 'ok' });
    }

    if (decision === 'approve') {
      profile.boundDeviceId = profile.pendingDeviceId;
      profile.deviceModel = b.deviceModel ?? profile.deviceModel;
    }
    profile.pendingDeviceId = '';
    profile.lastDeviceChangeAt = new Date();
    await profile.save();

    // Both devices are told (PRD 18.1 §18): the new one so it can start working, the old one so a
    // guard whose account was taken over on another handset finds out.
    try {
      (globalThis as any).__io?.emit?.('new-notification', {
        kind: 'DEVICE_CHANGE',
        guardId,
        decision,
        at: new Date().toISOString(),
      });
    } catch {
      /* ignore */
    }

    return NextResponse.json({
      success: true,
      decision,
      standing: decision === 'approve' ? 'ok' : 'blocked',
      boundDeviceId: profile.boundDeviceId,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'device decision failed' }, { status: 500 });
  }
}
