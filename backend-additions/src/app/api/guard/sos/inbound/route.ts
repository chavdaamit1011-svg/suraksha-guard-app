import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { connectToDatabase } from '@/lib/db';
import { GuardFieldEvent } from '@/lib/models/GuardFieldEvent';
import { APGuard } from '@/lib/models/APGuard';

export const dynamic = 'force-dynamic';

/**
 * Inbound SMS → SOS (PRD 18.9 §9 rung 3, §10).
 *
 * When a guard's phone has no data, the device texts the agency's SOS number with
 * `SOS|<guard_id>|<site_id>|<lat>,<lng>|<hhmmss>|<battery>`. The SMS gateway forwards that here
 * as a webhook, and it becomes a **fully valid** SOS — 18.9 §10 is explicit that an SMS-origin
 * alarm is not a lesser one.
 *
 * Deduplication matters more here than anywhere else: the same alarm will usually arrive twice,
 * once by SMS and once when the queued event syncs after the radio returns. Both converge on the
 * same `sosId`, derived from the guard and the minute the alarm was raised, so the Command
 * Center sees one incident rather than two.
 *
 * Configure the gateway to POST here with the shared secret in `x-guard-sms-key`.
 */

function authorised(req: Request): boolean {
  const expected = process.env.GUARD_SMS_WEBHOOK_KEY;
  if (!expected) return false; // unset means closed, never open
  const given = req.headers.get('x-guard-sms-key') ?? '';
  return given.length === expected.length && given === expected;
}

type Parsed = {
  guardId: string;
  siteId: string;
  lat?: number;
  lng?: number;
  hhmmss: string;
  batteryPct?: number;
};

/** Tolerant parser: a truncated or mangled SMS must still raise the alarm. */
export function parseSosSms(text: string): Parsed | null {
  const body = (text ?? '').trim();
  if (!body.toUpperCase().startsWith('SOS|')) return null;

  const [, guardId = '', siteId = '', coords = '', hhmmss = '', battery = ''] = body.split('|');
  if (!guardId) return null;

  let lat: number | undefined;
  let lng: number | undefined;
  if (coords.includes(',')) {
    const [a, b] = coords.split(',').map((n) => Number(n));
    if (Number.isFinite(a) && Number.isFinite(b)) {
      lat = a;
      lng = b;
    }
  }

  const batteryPct = Number(battery);
  return {
    guardId: guardId.trim(),
    siteId: siteId.trim(),
    lat,
    lng,
    hhmmss: hhmmss.trim(),
    batteryPct: Number.isFinite(batteryPct) ? batteryPct : undefined,
  };
}

/**
 * The id both paths agree on. The device knows its own `client_event_uuid`, but the SMS has no
 * room to carry it — so both sides derive the same key from guard + the minute of the alarm.
 * Two alarms from one guard inside the same minute are the same emergency.
 */
export function smsSosId(guardId: string, hhmmss: string, day: string): string {
  const minute = (hhmmss || '').slice(0, 4); // HHMM
  return `sms-${crypto.createHash('sha1').update(`${guardId}|${day}|${minute}`).digest('hex').slice(0, 24)}`;
}

export async function POST(req: Request) {
  try {
    if (!authorised(req)) {
      return NextResponse.json({ success: false, message: 'unauthorised' }, { status: 401 });
    }

    const b = await req.json();
    // Gateways disagree on field names; accept the common spellings rather than demanding one.
    const text: string = b.text ?? b.message ?? b.body ?? b.content ?? '';
    const from: string = b.from ?? b.sender ?? b.msisdn ?? '';

    const parsed = parseSosSms(text);
    if (!parsed) {
      return NextResponse.json({ success: false, message: 'not an SOS message', ignored: true });
    }

    await connectToDatabase();

    // Trust the sender's number over the body where we can: the guard id in the SMS is
    // self-reported, the originating MSISDN is not.
    let guardId = parsed.guardId;
    if (from) {
      const digits = from.replace(/\D/g, '').slice(-10);
      const byPhone: any = await APGuard.findOne({ phone: new RegExp(`${digits}$`) })
        .select('_id name phone')
        .lean()
        .catch(() => null);
      if (byPhone) guardId = String(byPhone._id);
    }

    const day = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const sosId = smsSosId(guardId, parsed.hhmmss, day);

    const guard: any = await APGuard.findById(guardId).lean().catch(() => null);

    const res = await GuardFieldEvent.updateOne(
      { clientEventUuid: sosId },
      {
        $setOnInsert: {
          clientEventUuid: sosId,
          kind: 'sos',
          guardId,
          siteId: parsed.siteId,
          lat: parsed.lat,
          lng: parsed.lng,
          deviceTime: new Date(),
          serverReceivedTime: new Date(),
          triggerMethod: 'long_press',
          channel: 'sms',
          status: 'pending',
          meta: {
            guardName: guard?.name,
            phone: guard?.phone ?? from,
            batteryPct: parsed.batteryPct,
            channels: ['sms'],
            rawSms: text.slice(0, 200),
          },
        },
      },
      { upsert: true }
    );

    const duplicate = (res as any).upsertedCount === 0;
    if (duplicate) {
      await GuardFieldEvent.updateOne({ clientEventUuid: sosId }, { $addToSet: { 'meta.channels': 'sms' } }).catch(
        () => {}
      );
    } else {
      try {
        (globalThis as any).__io?.emit?.('new-notification', {
          kind: 'SOS',
          sosId,
          guardId,
          guardName: guard?.name,
          phone: guard?.phone ?? from,
          lat: parsed.lat,
          lng: parsed.lng,
          batteryPct: parsed.batteryPct,
          channel: 'sms',
          at: new Date().toISOString(),
        });
      } catch {
        /* ignore */
      }
    }

    return NextResponse.json({ success: true, sosId, duplicate, guardId });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'inbound failed' }, { status: 500 });
  }
}
