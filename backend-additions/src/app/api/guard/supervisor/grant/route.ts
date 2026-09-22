import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectToDatabase } from '@/lib/db';
import { APGuard } from '@/lib/models/APGuard';
import { GuardAppProfile } from '@/lib/models/GuardAppProfile';

export const dynamic = 'force-dynamic';

/**
 * Grant or revoke field-supervisor authority (PRD 18.16 / §31).
 *
 * Verifying attendance and marking a guard present by proxy both decide whether someone gets
 * paid, so the grant is deliberate and admin-key gated rather than inferred from a job title.
 * (`resolveSupervisorScope` still falls back to the title so agencies that have not used this
 * route yet are not locked out — but an explicit grant is what should exist in production.)
 *
 *   POST   { guardId, isSupervisor, siteIds?, permissions? }
 *   GET    ?agencyId=   list who currently holds it
 */

function authorised(req: Request): boolean {
  const expected = process.env.GUARD_ADMIN_KEY;
  if (!expected) return false;
  const given = req.headers.get('x-guard-admin-key') ?? '';
  return given.length === expected.length && given === expected;
}

const PERMISSIONS = new Set(['attendance.verify', 'attendance.proxy', 'notice.broadcast']);

export async function POST(req: Request) {
  try {
    if (!authorised(req)) return NextResponse.json({ success: false, message: 'unauthorised' }, { status: 401 });

    const b = await req.json();
    const guardId = String(b.guardId ?? '');
    if (!guardId || !mongoose.Types.ObjectId.isValid(guardId)) {
      return NextResponse.json({ success: false, message: 'valid guardId required' }, { status: 400 });
    }

    const permissions: string[] = Array.isArray(b.permissions) ? b.permissions.filter((p: string) => PERMISSIONS.has(p)) : [];
    if (Array.isArray(b.permissions) && permissions.length !== b.permissions.length) {
      return NextResponse.json({ success: false, message: 'unknown permission' }, { status: 400 });
    }

    await connectToDatabase();

    const guard: any = await APGuard.findById(guardId).select('_id name type').lean();
    if (!guard) return NextResponse.json({ success: false, message: 'guard not found' }, { status: 404 });

    const profile = await GuardAppProfile.findOneAndUpdate(
      { guardId },
      {
        $set: {
          isSupervisor: b.isSupervisor !== false,
          ...(b.siteIds ? { supervisorSiteIds: (b.siteIds as string[]).map(String) } : {}),
          ...(b.permissions ? { permissions } : {}),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    return NextResponse.json({ success: true, guardId, name: guard.name, profile });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'grant failed' }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    if (!authorised(req)) return NextResponse.json({ success: false, message: 'unauthorised' }, { status: 401 });

    await connectToDatabase();
    const profiles: any[] = await GuardAppProfile.find({ isSupervisor: true })
      .select('guardId supervisorSiteIds permissions')
      .lean();

    const guards: any[] = await APGuard.find({ _id: { $in: profiles.map((p) => p.guardId) } })
      .select('_id name type agencyId')
      .lean()
      .catch(() => []);

    return NextResponse.json({
      success: true,
      supervisors: profiles.map((p) => ({
        ...p,
        guard: guards.find((g) => String(g._id) === String(p.guardId)) ?? null,
      })),
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'read failed' }, { status: 500 });
  }
}
