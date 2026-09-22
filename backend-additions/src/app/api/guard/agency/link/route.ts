import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/db';
import { APGuard } from '@/lib/models/APGuard';
import { GuardAppProfile } from '@/lib/models/GuardAppProfile';

/**
 * Guard-initiated agency link / transfer (PRD 17.8). One active association at a time; the prior
 * one is archived and kept in history. The guard always initiates and consents (anti-conscription).
 */
export async function POST(req: Request) {
  try {
    const { guardId, agencyId, agencyName } = await req.json();
    if (!guardId || !agencyId || !agencyName) {
      return NextResponse.json({ success: false, message: 'guardId, agencyId and agencyName are required' }, { status: 400 });
    }
    await connectToDatabase();
    const guard = await APGuard.findByIdAndUpdate(guardId, { $set: { agencyId, agencyName } }, { new: true });
    if (!guard) return NextResponse.json({ success: false, message: 'Guard not found' }, { status: 404 });

    let profile = await GuardAppProfile.findOne({ guardId });
    if (!profile) profile = await GuardAppProfile.create({ guardId });
    // Archive any currently-active association, then add the new one.
    profile.associations.forEach((a: any) => {
      if (a.status === 'Active' || a.status === 'Pending') {
        a.status = 'Archived';
        a.endedAt = new Date();
        a.endedBy = 'guard';
        a.reason = 'transfer';
      }
    });
    profile.associations.push({ agencyId, agencyName, status: 'Active', startedAt: new Date() });
    await profile.save();

    return NextResponse.json({ success: true, guard, associations: profile.associations });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const guardId = searchParams.get('guardId');
  if (!guardId) return NextResponse.json({ success: false, message: 'guardId required' }, { status: 400 });
  await connectToDatabase();
  const profile = await GuardAppProfile.findOne({ guardId }).lean();
  return NextResponse.json({ success: true, associations: (profile as any)?.associations ?? [] });
}
