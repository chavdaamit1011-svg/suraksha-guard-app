import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { connectToDatabase } from '@/lib/db';
import { GuardFieldEvent } from '@/lib/models/GuardFieldEvent';
import { GuardMedia } from '@/lib/models/GuardMedia';
import { leaveBalance, validateLeave } from '@/lib/guardLeave';

export const dynamic = 'force-dynamic';

/**
 * Leave requests (PRD 18.12, SUR-GAP-021).
 *
 *   GET    ?guardId=                 the guard's requests + per-type balance (in days)
 *   POST   { type, from, to, ... }   request leave; validated, never silently accepted
 *   PATCH  { clientEventUuid }       withdraw a request that has not been decided yet
 *
 * Validation lives in `guardLeave.ts` so the offline sync applies the same rules.
 */
export async function POST(req: Request) {
  try {
    const b = await req.json();
    const guardId = String(b.guardId ?? '');
    if (!guardId) return NextResponse.json({ success: false, message: 'guardId required' }, { status: 400 });

    const type = String(b.type ?? 'casual');
    const from = String(b.from ?? b.fromDate ?? '');
    const to = String(b.to ?? b.toDate ?? from);
    const reason = String(b.reason ?? '').trim();
    const mediaIds: string[] = Array.isArray(b.mediaIds) ? b.mediaIds : [];

    await connectToDatabase();

    const uuid: string = b.clientEventUuid ?? crypto.randomUUID();

    // A re-sent request is answered with what was decided the first time.
    const existing: any = await GuardFieldEvent.findOne({ clientEventUuid: uuid }).lean();
    if (existing) {
      return NextResponse.json({ success: true, duplicate: true, status: existing.status });
    }

    const check = await validateLeave({
      guardId,
      type,
      from,
      to,
      reason,
      hasVoice: mediaIds.length > 0 || !!b.hasVoice,
      halfDay: !!b.halfDay,
    });
    if (!check.ok) {
      return NextResponse.json({ success: false, code: check.code, message: check.message }, { status: 422 });
    }

    await GuardFieldEvent.updateOne(
      { clientEventUuid: uuid },
      {
        $setOnInsert: {
          clientEventUuid: uuid,
          kind: 'leave',
          guardId,
          fromDate: from,
          toDate: to,
          reason,
          mediaIds,
          deviceTime: b.deviceTime ? new Date(b.deviceTime) : new Date(),
          serverReceivedTime: new Date(),
          status: 'pending',
          reviewFlags: check.retrospective ? ['retrospective_leave'] : [],
          meta: {
            leaveType: type,
            halfDay: !!b.halfDay,
            days: check.days,
            retrospective: check.retrospective,
          },
        },
      },
      { upsert: true }
    );

    if (mediaIds.length) {
      await GuardMedia.updateMany(
        { mediaId: { $in: mediaIds }, clientEventUuid: '' },
        { $set: { clientEventUuid: uuid } }
      ).catch(() => {});
    }

    try {
      (globalThis as any).__io?.emit?.('new-notification', {
        kind: 'LEAVE_REQUEST',
        guardId,
        leaveType: type,
        from,
        to,
        days: check.days,
        retrospective: check.retrospective,
        at: new Date().toISOString(),
      });
    } catch {
      /* ignore */
    }

    return NextResponse.json({
      success: true,
      clientEventUuid: uuid,
      status: 'pending',
      days: check.days,
      retrospective: check.retrospective,
    });
  } catch (error: any) {
    if (error?.code === 11000) return NextResponse.json({ success: true, duplicate: true });
    return NextResponse.json({ success: false, message: error?.message ?? 'leave failed' }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const guardId = searchParams.get('guardId');
    if (!guardId) return NextResponse.json({ success: false, message: 'guardId required' }, { status: 400 });

    await connectToDatabase();
    const [leaves, balance] = await Promise.all([
      GuardFieldEvent.find({ guardId, kind: 'leave' }).sort({ createdAt: -1 }).limit(30).lean(),
      leaveBalance(guardId),
    ]);

    return NextResponse.json({
      success: true,
      balance,
      leaves: leaves.map((l: any) => ({
        clientEventUuid: l.clientEventUuid,
        type: l.meta?.leaveType ?? 'casual',
        from: l.fromDate,
        to: l.toDate,
        days: l.meta?.days ?? null,
        halfDay: !!l.meta?.halfDay,
        reason: l.reason,
        // Older rows were written as `recorded`; to the guard that means "waiting".
        status: l.status === 'recorded' ? 'pending' : l.status,
        retrospective: !!l.meta?.retrospective,
        decisionNote: l.meta?.decisionNote ?? '',
        createdAt: l.createdAt,
      })),
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'read failed' }, { status: 500 });
  }
}

/** Withdraw a request (Pending → Cancelled). A decided request cannot be withdrawn from the app. */
export async function PATCH(req: Request) {
  try {
    const b = await req.json();
    if (!b.guardId || !b.clientEventUuid) {
      return NextResponse.json({ success: false, message: 'guardId and clientEventUuid required' }, { status: 400 });
    }
    await connectToDatabase();
    const r = await GuardFieldEvent.updateOne(
      {
        clientEventUuid: b.clientEventUuid,
        guardId: b.guardId,
        kind: 'leave',
        status: { $in: ['pending', 'recorded'] },
      },
      { $set: { status: 'cancelled' } }
    );
    if ((r as any).matchedCount === 0) {
      return NextResponse.json(
        { success: false, message: 'Only a request that is still waiting can be withdrawn.' },
        { status: 409 }
      );
    }
    return NextResponse.json({ success: true, status: 'cancelled' });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'withdraw failed' }, { status: 500 });
  }
}
