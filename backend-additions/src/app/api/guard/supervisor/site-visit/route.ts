import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { connectToDatabase } from '@/lib/db';
import { GuardFieldEvent } from '@/lib/models/GuardFieldEvent';
import { GuardMedia } from '@/lib/models/GuardMedia';
import { evaluateGeofence, resolveSite } from '@/lib/guardRoster';
import { resolveSupervisorScope } from '@/lib/guardSupervisor';

export const dynamic = 'force-dynamic';

/**
 * Supervisor site-visit check (PRD 18.16).
 *
 * A geo-stamped record that the supervisor was physically at a site, with a photo and notes. It
 * is the supervisor's own attendance evidence — the same accountability the guards are held to,
 * which is the only reason the guards accept being held to it.
 */
export async function POST(req: Request) {
  try {
    const b = await req.json();
    const supervisorId: string = b.supervisorId ?? '';
    if (!supervisorId) {
      return NextResponse.json({ success: false, message: 'supervisorId required' }, { status: 400 });
    }
    if (!b.siteName && !b.siteId) {
      return NextResponse.json({ success: false, message: 'siteName or siteId required' }, { status: 400 });
    }

    await connectToDatabase();

    const scope = await resolveSupervisorScope(supervisorId);
    if (!scope.isSupervisor) {
      return NextResponse.json({ success: false, message: 'not permitted' }, { status: 403 });
    }

    const resolved = await resolveSite(scope.agencyId, String(b.siteName ?? ''));
    const geo = evaluateGeofence(resolved, b.lat, b.lng);

    const clientEventUuid: string = b.clientEventUuid ?? crypto.randomUUID();
    const mediaIds: string[] = b.mediaIds ?? [];

    await GuardFieldEvent.updateOne(
      { clientEventUuid },
      {
        $setOnInsert: {
          clientEventUuid,
          kind: 'site_visit',
          guardId: supervisorId,
          siteId: resolved.siteId || String(b.siteId ?? ''),
          siteName: resolved.siteName || String(b.siteName ?? ''),
          deviceTime: b.at ? new Date(b.at) : new Date(),
          serverReceivedTime: new Date(),
          lat: b.lat,
          lng: b.lng,
          distanceM: geo.distanceM,
          mediaIds,
          reason: String(b.notes ?? ''),
          status: 'recorded',
          meta: {
            supervisorName: scope.guard?.name ?? '',
            geofenceResult: geo.geofenceResult,
            guardsSeen: b.guardsSeen ?? [],
          },
        },
      },
      { upsert: true }
    );

    if (mediaIds.length) {
      await GuardMedia.updateMany(
        { mediaId: { $in: mediaIds }, clientEventUuid: '' },
        { $set: { clientEventUuid } }
      ).catch(() => {});
    }

    return NextResponse.json({
      success: true,
      clientEventUuid,
      geofenceResult: geo.geofenceResult,
      distanceM: geo.distanceM,
    });
  } catch (error: any) {
    if (error?.code === 11000) return NextResponse.json({ success: true, duplicate: true });
    return NextResponse.json({ success: false, message: error?.message ?? 'site visit failed' }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const supervisorId = searchParams.get('supervisorId');
    if (!supervisorId) {
      return NextResponse.json({ success: false, message: 'supervisorId required' }, { status: 400 });
    }
    await connectToDatabase();
    const visits = await GuardFieldEvent.find({ guardId: supervisorId, kind: 'site_visit' })
      .sort({ serverReceivedTime: -1 })
      .limit(50)
      .lean();
    return NextResponse.json({ success: true, visits });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'read failed' }, { status: 500 });
  }
}
