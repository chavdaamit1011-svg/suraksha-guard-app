import { NextResponse } from 'next/server';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { connectToDatabase } from '@/lib/db';
import { GuardFieldEvent } from '@/lib/models/GuardFieldEvent';
import { APGuard } from '@/lib/models/APGuard';
import { GuardSiteConfig } from '@/lib/models/GuardSiteConfig';

export const dynamic = 'force-dynamic';

/**
 * SOS ingest (PRD 18.9, SUR-GAP-017/018).
 *
 * Deduplication is by `sosId` so the socket, REST, SMS and offline-queue paths all converge on
 * one event rather than raising four alarms (18.9 §10). The first path to arrive creates it; the
 * rest attach their channel to the same record, which is also how we can tell afterwards how the
 * alarm actually got out — the single most useful number for tuning the ladder.
 *
 * An SOS is never deletable by a guard (18.9 §11); cancelling sets a status and a reason.
 */
export async function POST(req: Request) {
  try {
    const b = await req.json();
    if (!b.guardId) return NextResponse.json({ success: false, message: 'guardId required' }, { status: 400 });
    await connectToDatabase();

    const uuid: string = b.sosId ?? b.clientEventUuid ?? crypto.randomUUID();
    const channel: string = b.channel ?? 'rest';
    const guard: any = mongoose.Types.ObjectId.isValid(b.guardId)
      ? await APGuard.findById(b.guardId).lean().catch(() => null)
      : null;

    const res = await GuardFieldEvent.updateOne(
      { clientEventUuid: uuid },
      {
        $setOnInsert: {
          clientEventUuid: uuid,
          kind: 'sos',
          guardId: b.guardId,
          rosterId: b.rosterId ?? '',
          siteId: b.siteId ?? '',
          siteName: b.siteName ?? '',
          bookingId: b.bookingId ?? '',
          lat: b.lat,
          lng: b.lng,
          deviceTime: b.at ? new Date(b.at) : new Date(),
          serverReceivedTime: new Date(),
          triggerMethod: b.triggerMethod ?? 'long_press',
          channel,
          status: 'pending',
          meta: {
            guardName: guard?.name,
            phone: guard?.phone,
            batteryPct: b.batteryPct,
            channels: [channel],
          },
        },
      },
      { upsert: true }
    );

    const duplicate = (res as any).upsertedCount === 0;

    // A later path reaching the same alarm records its channel without disturbing the original.
    if (duplicate) {
      await GuardFieldEvent.updateOne(
        { clientEventUuid: uuid },
        { $addToSet: { 'meta.channels': channel } }
      ).catch(() => {});
    }

    // Fan out to ops in real time, but only for the first arrival — otherwise the retry burst
    // would light up the Command Center once per attempt.
    if (!duplicate) {
      try {
        (globalThis as any).__io?.emit?.('new-notification', {
          kind: 'SOS',
          sosId: uuid,
          guardId: b.guardId,
          guardName: guard?.name,
          phone: guard?.phone,
          siteName: b.siteName,
          lat: b.lat,
          lng: b.lng,
          batteryPct: b.batteryPct,
          channel,
          at: new Date().toISOString(),
        });
      } catch {
        /* the socket server may not be attached in this process */
      }
    }

    return NextResponse.json({ success: true, sosId: uuid, duplicate });
  } catch (error: any) {
    if (error?.code === 11000) return NextResponse.json({ success: true, duplicate: true });
    return NextResponse.json({ success: false, message: error?.message ?? 'sos failed' }, { status: 500 });
  }
}

/**
 * Acknowledgement polling and history.
 *
 * With `sosId`, returns just that alarm's state — the app shows the responder's name on the
 * active-SOS screen as soon as an operator picks it up (18.9 §5). Without one, returns the
 * guard's recent SOS history (GAP-S-043).
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const guardId = searchParams.get('guardId');
    const sosId = searchParams.get('sosId');
    if (!guardId) return NextResponse.json({ success: false, message: 'guardId required' }, { status: 400 });

    await connectToDatabase();

    if (sosId) {
      const ev: any = await GuardFieldEvent.findOne({ clientEventUuid: sosId, kind: 'sos', guardId }).lean();
      if (!ev) return NextResponse.json({ success: true, found: false });
      return NextResponse.json({
        success: true,
        found: true,
        sosId,
        status: ev.status,
        acknowledgedBy: ev.acknowledgedBy || null,
        channels: ev.meta?.channels ?? [],
      });
    }

    const history = await GuardFieldEvent.find({ guardId, kind: 'sos' })
      .sort({ serverReceivedTime: -1 })
      .limit(30)
      .lean();
    return NextResponse.json({ success: true, history });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'sos read failed' }, { status: 500 });
  }
}

/**
 * Guard-initiated cancel (PRD 18.9 §11). The app gates this behind the guard's PIN so an
 * attacker with a snatched phone cannot call off the alarm. The record is never removed — it is
 * closed with a reason, and an operator can still review it.
 */
export async function PATCH(req: Request) {
  try {
    const b = await req.json();
    if (!b.guardId || !b.sosId) {
      return NextResponse.json({ success: false, message: 'guardId and sosId required' }, { status: 400 });
    }
    await connectToDatabase();

    const updated = await GuardFieldEvent.findOneAndUpdate(
      { clientEventUuid: b.sosId, kind: 'sos', guardId: b.guardId },
      { $set: { status: 'cancelled', reason: b.reason ?? 'cancelled_by_guard' } },
      { new: true }
    ).lean();

    if (!updated) return NextResponse.json({ success: false, message: 'not found' }, { status: 404 });

    try {
      (globalThis as any).__io?.emit?.('new-notification', {
        kind: 'SOS_CANCELLED',
        sosId: b.sosId,
        guardId: b.guardId,
        at: new Date().toISOString(),
      });
    } catch {
      /* ignore */
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'cancel failed' }, { status: 500 });
  }
}

/** The agency SOS number a device should text when data fails, cached into the duty bundle. */
export async function OPTIONS(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const siteId = searchParams.get('siteId');
    await connectToDatabase();
    const cfg: any = siteId ? await GuardSiteConfig.findOne({ siteId }).lean() : null;
    return NextResponse.json({ success: true, sosSmsNumber: cfg?.sosSmsNumber ?? '' });
  } catch {
    return NextResponse.json({ success: true, sosSmsNumber: '' });
  }
}
