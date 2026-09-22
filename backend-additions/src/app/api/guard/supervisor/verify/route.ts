import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/db';
import { GuardAttendance } from '@/lib/models/GuardAttendance';
import { GuardFieldEvent } from '@/lib/models/GuardFieldEvent';
import { guardIsInScope, resolveSupervisorScope } from '@/lib/guardSupervisor';

export const dynamic = 'force-dynamic';

/**
 * Supervisor verification of a flagged event (PRD 18.16, SUR-GAP-034).
 *
 * The decision is **appended**, never destructive: the original capture — its coordinates, its
 * trust score, the flags that raised it — is untouched, and the supervisor's verdict sits beside
 * it with their identity and a reason (PRD 18.5 §11, §15). A supervisor can say "this is fine";
 * they cannot edit what the device recorded.
 */

const REASONS = new Set([
  'confirmed_present',
  'gps_drift',
  'site_boundary_wrong',
  'device_fault',
  'tag_damaged',
  'guard_confirmed_by_call',
  'not_at_post',
  'proven_proxy',
  'other',
]);

export async function POST(req: Request) {
  try {
    const b = await req.json();
    const { supervisorId, itemId, kind, decision, reason } = b as {
      supervisorId?: string;
      itemId?: string;
      kind?: 'attendance' | 'patrol';
      decision?: 'approved' | 'rejected';
      reason?: string;
    };

    if (!supervisorId || !itemId || !kind || !decision) {
      return NextResponse.json(
        { success: false, message: 'supervisorId, itemId, kind and decision are required' },
        { status: 400 }
      );
    }
    if (decision !== 'approved' && decision !== 'rejected') {
      return NextResponse.json({ success: false, message: 'decision must be approved or rejected' }, { status: 400 });
    }
    // Rejecting takes a reason away from a guard's pay, so it has to be justified.
    if (decision === 'rejected' && !reason) {
      return NextResponse.json({ success: false, message: 'a reason is required to reject' }, { status: 400 });
    }
    if (reason && !REASONS.has(reason)) {
      return NextResponse.json({ success: false, message: 'unknown reason code' }, { status: 400 });
    }

    await connectToDatabase();

    const scope = await resolveSupervisorScope(supervisorId);
    if (!scope.isSupervisor || !scope.canVerify) {
      return NextResponse.json({ success: false, message: 'not permitted' }, { status: 403 });
    }

    const Model = kind === 'attendance' ? GuardAttendance : GuardFieldEvent;
    const event: any = await Model.findOne({ clientEventUuid: itemId }).lean();
    if (!event) return NextResponse.json({ success: false, message: 'event not found' }, { status: 404 });

    // A supervisor may only decide on guards rostered to the sites they cover today.
    if (!(await guardIsInScope(scope, String(event.guardId)))) {
      return NextResponse.json({ success: false, message: 'guard is not on your team' }, { status: 403 });
    }

    if (event.reviewDecision) {
      return NextResponse.json({
        success: true,
        alreadyDecided: true,
        decision: event.reviewDecision,
        reviewedBy: event.reviewedBy,
      });
    }

    await Model.updateOne(
      { clientEventUuid: itemId },
      {
        $set: {
          reviewDecision: decision,
          reviewedBy: supervisorId,
          reviewedAt: new Date(),
          reviewReason: reason ?? '',
          // Approving restores the event's standing for payroll; rejecting leaves the record in
          // place but marks it, per 18.5 §11 (Rejected is a state, not a deletion).
          ...(kind === 'attendance'
            ? { confidence: decision === 'approved' ? 'high' : 'review' }
            : { status: decision === 'approved' ? 'verified' : 'rejected' }),
        },
      }
    );

    return NextResponse.json({ success: true, decision, itemId });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'verify failed' }, { status: 500 });
  }
}

/** The reason codes the app renders as chips, so the list lives in one place. */
export async function GET() {
  return NextResponse.json({
    success: true,
    approveReasons: ['confirmed_present', 'gps_drift', 'site_boundary_wrong', 'device_fault', 'tag_damaged', 'guard_confirmed_by_call'],
    rejectReasons: ['not_at_post', 'proven_proxy', 'other'],
  });
}
