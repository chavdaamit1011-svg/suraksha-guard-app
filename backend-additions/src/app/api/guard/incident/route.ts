import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { connectToDatabase } from '@/lib/db';
import { Incident } from '@/lib/models/Incident';
import { recordIncident } from '@/lib/guardIncident';

export const dynamic = 'force-dynamic';

/**
 * Guard-reported incidents (PRD 18.10, SUR-GAP-019).
 *
 * Writes to the shared `Incident` model so ops and the agency portal see guard reports in the
 * same queue as everything else — a separate collection would mean a separate inbox nobody
 * watches. The offline path is `/api/guard/sync`; both go through `recordIncident`.
 *
 * Two behaviours matter beyond storing the row:
 *
 *  - **Emergency severity raises an SOS-class alert** into the Command Center queue (18.10 §9).
 *    It is not an SOS — the guard is reporting, not calling for help for themselves — but it
 *    cannot sit in a list waiting for someone to refresh.
 *  - **Media trails the metadata**, and for an Emergency the app sends a small thumbnail before
 *    the full image, "so the operator sees *something* fast" (18.10 §10).
 */
export async function POST(req: Request) {
  try {
    const b = await req.json();
    const guardId = String(b.guardId ?? '');
    if (!guardId) {
      return NextResponse.json({ success: false, message: 'guardId required' }, { status: 400 });
    }

    // PRD 18.10 §8: at least one of voice / photo / text.
    const mediaIds: string[] = Array.isArray(b.mediaIds) ? b.mediaIds : [];
    const description = String(b.description ?? '').trim();
    if (!description && mediaIds.length === 0 && !Number(b.mediaCount ?? b.media_count ?? 0)) {
      return NextResponse.json(
        { success: false, message: 'a description, a photo or a voice note is required' },
        { status: 400 }
      );
    }

    await connectToDatabase();
    const key: string = b.clientEventUuid ?? crypto.randomUUID();
    const r = await recordIncident({ ...b, guardId, key, description, mediaIds });

    return NextResponse.json({
      success: true,
      duplicate: r.duplicate,
      incidentKey: key,
      incidentId: r.incidentId,
      priority: r.priority,
      severity: r.severity,
      escalated: r.escalated,
    });
  } catch (error: any) {
    if (error?.code === 11000) return NextResponse.json({ success: true, duplicate: true });
    return NextResponse.json({ success: false, message: error?.message ?? 'incident failed' }, { status: 500 });
  }
}

/** The guard's own incidents (PRD 18.10 GAP-S-049). Self-scoped. */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const guardId = searchParams.get('guardId');
    if (!guardId) return NextResponse.json({ success: false, message: 'guardId required' }, { status: 400 });

    await connectToDatabase();
    const incidents = await Incident.find({ reportedBy: guardId })
      .sort({ createdAt: -1 })
      .limit(40)
      .select(
        'incidentId bookingIncidentKey title category site severity priority status description occurredAt createdAt mediaIds thumbnailMediaId injuriesFlag policeInformedFlag'
      )
      .lean();

    return NextResponse.json({ success: true, incidents });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'read failed' }, { status: 500 });
  }
}
