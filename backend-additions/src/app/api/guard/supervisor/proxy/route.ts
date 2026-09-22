import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { connectToDatabase } from '@/lib/db';
import { GuardAttendance } from '@/lib/models/GuardAttendance';
import { GuardMedia } from '@/lib/models/GuardMedia';
import { ingestAttendance } from '@/lib/guardAttendanceIngest';
import { guardIsInScope, resolveSupervisorScope } from '@/lib/guardSupervisor';

export const dynamic = 'force-dynamic';

/**
 * Proxy attendance (PRD 18.5 §9, 18.16, SUR-GAP-034).
 *
 * A guard with a dead or broken phone still worked the shift, and the alternative to recording it
 * is not recording it — which means they are marked absent and go unpaid. So a supervisor can
 * mark them present, under three conditions the PRD sets out and this route enforces:
 *
 *  1. the supervisor supplies **their own** location and selfie, not the guard's;
 *  2. the record names both `subject_guard_id` and `actor_user_id`;
 *  3. it is **always flagged** — a proxy record is never high-confidence, however good the
 *     supervisor's own signals were, because nobody verified the guard themselves.
 *
 * "Two guards sharing one phone" is the abuse this shape is designed to make visible rather than
 * prevent: the pattern shows up as a run of proxies from one supervisor (18.5 §16).
 */
export async function POST(req: Request) {
  try {
    const b = await req.json();
    const { supervisorId, subjectGuardId, rosterId, eventType } = b as {
      supervisorId?: string;
      subjectGuardId?: string;
      rosterId?: string;
      eventType?: 'check_in' | 'check_out';
    };

    if (!supervisorId || !subjectGuardId || !eventType) {
      return NextResponse.json(
        { success: false, message: 'supervisorId, subjectGuardId and eventType are required' },
        { status: 400 }
      );
    }
    if (eventType !== 'check_in' && eventType !== 'check_out') {
      return NextResponse.json({ success: false, message: 'eventType must be check_in or check_out' }, { status: 400 });
    }
    if (!b.reason) {
      return NextResponse.json({ success: false, message: 'a reason is required for proxy attendance' }, { status: 400 });
    }

    await connectToDatabase();

    const scope = await resolveSupervisorScope(supervisorId);
    if (!scope.isSupervisor || !scope.canProxy) {
      return NextResponse.json({ success: false, message: 'not permitted' }, { status: 403 });
    }
    if (!(await guardIsInScope(scope, subjectGuardId))) {
      return NextResponse.json({ success: false, message: 'guard is not on your team' }, { status: 403 });
    }

    const clientEventUuid: string = b.clientEventUuid ?? crypto.randomUUID();

    // Runs through the ordinary ingest so a proxy event is geofenced, time-checked and scored
    // exactly like a self-captured one — the supervisor's location is the one being measured.
    const result = await ingestAttendance({
      guardId: subjectGuardId,
      clientEventUuid,
      eventType,
      rosterId,
      deviceTime: b.deviceTime ?? new Date().toISOString(),
      lat: b.lat,
      lng: b.lng,
      accuracyM: b.accuracyM,
      provider: b.provider,
      isMockLocation: !!b.isMockLocation,
      deviceId: b.deviceId,
      deviceModel: b.deviceModel,
      networkState: b.networkState,
      selfieMediaId: b.selfieMediaId,
    });

    // Then stamped as a proxy and forced down to supervisor-review confidence.
    await GuardAttendance.updateOne(
      { clientEventUuid },
      {
        $set: {
          proxyBy: supervisorId,
          confidence: 'low',
          reviewReason: String(b.reason),
          'meta.proxyBy': supervisorId,
          'meta.proxySupervisorName': scope.guard?.name ?? '',
          'meta.proxyReason': String(b.reason),
        },
        $addToSet: { reviewFlags: 'proxy_attendance' },
      }
    );

    // The supervisor's selfie belongs to the supervisor, not the guard whose shift it records.
    if (b.selfieMediaId) {
      await GuardMedia.updateOne(
        { mediaId: b.selfieMediaId },
        { $set: { clientEventUuid, kind: 'selfie' } }
      ).catch(() => {});
    }

    return NextResponse.json({
      success: true,
      clientEventUuid,
      duplicate: result.duplicate,
      geofenceResult: result.geofenceResult,
      distanceM: result.distanceM,
      flagged: true,
    });
  } catch (error: any) {
    if (error?.code === 11000) return NextResponse.json({ success: true, duplicate: true });
    return NextResponse.json({ success: false, message: error?.message ?? 'proxy failed' }, { status: 500 });
  }
}

/** Proxy records the supervisor has raised, so the pattern is visible to them too. */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const supervisorId = searchParams.get('supervisorId');
    if (!supervisorId) {
      return NextResponse.json({ success: false, message: 'supervisorId required' }, { status: 400 });
    }
    await connectToDatabase();
    const events = await GuardAttendance.find({ proxyBy: supervisorId })
      .sort({ serverReceivedTime: -1 })
      .limit(50)
      .lean();
    return NextResponse.json({ success: true, events });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'read failed' }, { status: 500 });
  }
}
