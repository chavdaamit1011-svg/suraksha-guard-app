import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { connectToDatabase } from '@/lib/db';
import { GuardFieldEvent } from '@/lib/models/GuardFieldEvent';
import { ingestPatrolScan, recordPatrolObservation } from '@/lib/guardFieldIngest';

export const dynamic = 'force-dynamic';

/**
 * Patrol checkpoint scan (PRD 18.7). Online path; the offline path is /api/guard/sync, and both
 * call the same ingest. Idempotent on clientEventUuid.
 *
 * The response tells the app what the *server* concluded — verified or flagged, which round the
 * scan joined and whether that round is now complete — because round completion is computed
 * server-side and the client's own view is advisory (18.7 §10).
 */
export async function POST(req: Request) {
  try {
    const b = await req.json();
    if (!b.guardId) return NextResponse.json({ success: false, message: 'guardId required' }, { status: 400 });

    await connectToDatabase();
    const r = await ingestPatrolScan({
      guardId: b.guardId,
      clientEventUuid: b.clientEventUuid ?? crypto.randomUUID(),
      checkpointCode: b.checkpointCode ?? '',
      scanMethod: b.method ?? b.scanMethod,
      rosterId: b.rosterId,
      roundId: b.roundId,
      bookingId: b.bookingId,
      lat: b.lat,
      lng: b.lng,
      accuracyM: b.accuracyM,
      isMockLocation: !!b.isMockLocation,
      deviceTime: b.at ?? b.deviceTime,
      mediaIds: b.mediaIds ?? [],
      note: b.note,
      observationType: b.observationType ?? b.observation_type,
    });

    return NextResponse.json({
      success: true,
      duplicate: r.duplicate,
      verified: r.verified,
      checkpointId: r.checkpointId,
      checkpointName: r.checkpointName,
      roundId: r.roundId,
      roundStatus: r.roundStatus,
      distanceM: r.distanceM,
      flags: r.flags,
    });
  } catch (error: any) {
    if (error?.code === 11000) return NextResponse.json({ success: true, duplicate: true });
    return NextResponse.json({ success: false, message: error?.message ?? 'patrol scan failed' }, { status: 500 });
  }
}

/**
 * Attach an observation to a scan already recorded (PRD 18.7 §6).
 *   { guardId, scanUuid, observationType: 'all_ok'|'issue'|'note', note?, mediaIds? }
 */
export async function PATCH(req: Request) {
  try {
    const b = await req.json();
    if (!b.guardId || !b.scanUuid) {
      return NextResponse.json({ success: false, message: 'guardId and scanUuid required' }, { status: 400 });
    }
    await connectToDatabase();
    const r = await recordPatrolObservation({
      guardId: String(b.guardId),
      scanUuid: String(b.scanUuid),
      observationType: b.observationType,
      note: b.note,
      mediaIds: Array.isArray(b.mediaIds) ? b.mediaIds : [],
    });
    if (!r.found) return NextResponse.json({ success: false, message: 'scan not found' }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'observation failed' }, { status: 500 });
  }
}

/** The guard's own scan history (PRD 18.7 GAP-S-034). */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const guardId = searchParams.get('guardId');
    if (!guardId) return NextResponse.json({ success: false, message: 'guardId required' }, { status: 400 });
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10) || 50, 200);

    await connectToDatabase();
    const scans = await GuardFieldEvent.find({ guardId, kind: 'patrol_scan' })
      .sort({ serverReceivedTime: -1 })
      .limit(limit)
      .lean();

    return NextResponse.json({ success: true, scans });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'patrol history failed' }, { status: 500 });
  }
}
