import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/db';
import { GuardAttendance } from '@/lib/models/GuardAttendance';
import { ingestAttendance, type AttendanceInput } from '@/lib/guardAttendanceIngest';

export const dynamic = 'force-dynamic';

/**
 * Online path for a single attendance event (PRD 18.5). The offline path is /api/guard/sync;
 * both call the same ingest so the verdict does not depend on whether there was a signal.
 * Idempotent on clientEventUuid.
 */
export async function POST(req: Request) {
  try {
    const b = await req.json();
    if (!b.guardId || !b.clientEventUuid || !b.eventType) {
      return NextResponse.json(
        { success: false, message: 'guardId, clientEventUuid and eventType required' },
        { status: 400 }
      );
    }
    await connectToDatabase();
    const result = await ingestAttendance(b as AttendanceInput);

    return NextResponse.json({
      success: true,
      duplicate: result.duplicate,
      rosterId: result.rosterId,
      geofenceResult: result.geofenceResult,
      distanceM: result.distanceM,
      lateByMin: result.lateByMin,
      estimatedTrueTime: result.estimatedTrueTime,
      trust: result.trust,
    });
  } catch (error: any) {
    if (error?.code === 11000) return NextResponse.json({ success: true, duplicate: true });
    return NextResponse.json({ success: false, message: error?.message ?? 'attendance failed' }, { status: 500 });
  }
}

/** The guard's own attendance history (PRD 18.5 GAP-S-024). Self-scoped only. */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const guardId = searchParams.get('guardId');
    if (!guardId) return NextResponse.json({ success: false, message: 'guardId required' }, { status: 400 });
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '60', 10) || 60, 200);

    await connectToDatabase();
    const events = await GuardAttendance.find({ guardId })
      .sort({ serverReceivedTime: -1 })
      .limit(limit)
      .lean();

    return NextResponse.json({ success: true, events });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'history failed' }, { status: 500 });
  }
}
