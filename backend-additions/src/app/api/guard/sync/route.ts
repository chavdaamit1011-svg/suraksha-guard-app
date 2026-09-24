import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/db';
import { GuardAttendance } from '@/lib/models/GuardAttendance';
import { GuardFieldEvent } from '@/lib/models/GuardFieldEvent';
import { APGuard } from '@/lib/models/APGuard';
import { Booking } from '@/lib/models/BookingState';

export const dynamic = 'force-dynamic';

const MAX_EVENTS = 100;

const PRIORITY: Record<string, number> = {
  sos: 0,
  check_in: 1,
  check_out: 1,
  break_start: 1,
  break_end: 1,
  wake_check: 1,
  patrol_scan: 2,
  patrol_observation: 2,
  incident: 3,
  leave: 4,
  document: 4,
  location: 4,
};

export async function POST(req: Request) {
  try {
    const { guardId, events } = await req.json();
    if (!guardId || !Array.isArray(events)) {
      return NextResponse.json({ success: false, message: 'guardId and events[] are required' }, { status: 400 });
    }
    if (events.length > MAX_EVENTS) {
      return NextResponse.json(
        { success: false, message: `batch too large (max ${MAX_EVENTS})` },
        { status: 413 }
      );
    }

    await connectToDatabase();

    const ordered = [...events].sort(
      (a, b) =>
        (PRIORITY[a?.type] ?? 9) - (PRIORITY[b?.type] ?? 9) ||
        (a?.capture_sequence_no ?? 0) - (b?.capture_sequence_no ?? 0)
    );

    const accepted: string[] = [];
    const results: { uuid: string; ok: boolean; retry?: boolean; type?: string; error?: string; detail?: any }[] = [];

    for (const ev of ordered) {
      const uuid = ev?.client_event_uuid;
      if (!uuid) {
        results.push({ uuid: '', ok: false, error: 'missing client_event_uuid' });
        continue;
      }
      const p = ev.payload ?? {};
      const common = {
        guardId,
        clientEventUuid: uuid,
        rosterId: p.rosterId || '',
        bookingId: p.bookingId || '',
        deviceTime: ev.device_time ? new Date(ev.device_time) : new Date(),
        serverReceivedTime: new Date(),
        lat: p.lat,
        lng: p.lng,
        mediaIds: p.media_ids ?? p.mediaIds ?? [],
      };

      try {
        switch (ev.type) {
          case 'check_in':
          case 'check_out':
          case 'break_start':
          case 'break_end': {
            await GuardAttendance.updateOne(
              { clientEventUuid: uuid },
              {
                $setOnInsert: {
                  clientEventUuid: uuid,
                  captureSequenceNo: ev.capture_sequence_no ?? 0,
                  guardId,
                  bookingId: common.bookingId,
                  eventType: ev.type,
                  rosterId: common.rosterId,
                  shiftDate: p.shiftDate || new Date().toISOString().split('T')[0],
                  siteId: p.siteId || '',
                  siteName: p.siteName || '',
                  deviceTime: common.deviceTime,
                  serverReceivedTime: common.serverReceivedTime,
                  monotonicMs: ev.monotonic_ms,
                  lat: p.lat,
                  lng: p.lng,
                  accuracyM: p.accuracy_m,
                  geofenceResult: p.geofence_result || 'inside',
                  distanceM: 0,
                  outsideReason: p.outside_reason || '',
                  earlyOutReason: p.early_out_reason || '',
                  isMockLocation: !!p.is_mock_location,
                  deviceId: p.device_id || '',
                  deviceModel: p.device?.model || '',
                  osVersion: p.device?.os || '',
                  appVersion: p.device?.appVersion || '',
                  provider: p.provider || 'fused',
                  batteryPct: p.battery_pct,
                  isCharging: p.is_charging,
                  networkState: p.network_state || 'offline',
                  selfieMediaId: p.selfie_media_id || '',
                  selfieUri: p.selfie_uri || '',
                  photoHash: p.photo_hash || '',
                  eventTrustScore: 100,
                  confidence: 'high',
                },
              },
              { upsert: true }
            );

            if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
              await APGuard.updateMany(
                { $or: [{ id: guardId }, { guardId }] },
                { $set: { lat: p.lat, lng: p.lng } }
              ).catch(() => {});
            }

            if (common.bookingId) {
              if (ev.type === 'check_in') {
                await Booking.updateOne(
                  { bookingId: common.bookingId, bookingStatus: { $in: ['ASSIGNED', 'EN_ROUTE', 'ARRIVED'] } },
                  { $set: { bookingStatus: 'ACTIVE', 'dutyDetails.dutyStartedAt': common.deviceTime } }
                ).catch(() => {});
              } else if (ev.type === 'check_out') {
                await Booking.updateOne(
                  { bookingId: common.bookingId, bookingStatus: 'CHECKOUT_INITIATED' },
                  { $set: { bookingStatus: 'COMPLETED', 'dutyDetails.dutyEndedAt': common.deviceTime } }
                ).catch(() => {});
              }
            }

            results.push({
              uuid,
              ok: true,
              type: ev.type,
              detail: {
                geofenceResult: p.geofence_result || 'inside',
                distanceM: 0,
                lateByMin: 0,
                trustScore: 100,
              },
            });
            break;
          }

          case 'patrol_scan': {
            await GuardFieldEvent.updateOne(
              { clientEventUuid: uuid },
              {
                $setOnInsert: {
                  ...common,
                  kind: 'patrol_scan',
                  checkpointCode: p.checkpointCode ?? p.checkpoint_code ?? '',
                  checkpointId: p.checkpointId ?? '',
                  roundId: p.roundId ?? p.round_id ?? '',
                  scanMethod: p.method ?? p.scan_method ?? 'qr',
                  status: 'recorded',
                  meta: { note: p.note, observationType: p.observation_type },
                },
              },
              { upsert: true }
            );
            results.push({ uuid, ok: true, type: ev.type, detail: { verified: true, roundStatus: 'in_progress' } });
            break;
          }

          case 'patrol_observation': {
            await GuardFieldEvent.updateOne(
              { clientEventUuid: uuid },
              {
                $setOnInsert: {
                  ...common,
                  kind: 'patrol_observation',
                  status: 'recorded',
                  meta: { scanUuid: p.scanUuid ?? p.scan_uuid, observationType: p.observation_type ?? p.observationType, note: p.note },
                },
              },
              { upsert: true }
            );
            results.push({ uuid, ok: true, type: ev.type });
            break;
          }

          case 'document': {
            await GuardFieldEvent.updateOne(
              { clientEventUuid: uuid },
              {
                $setOnInsert: {
                  ...common,
                  kind: 'document',
                  status: 'recorded',
                  meta: { kind: p.kind, number: p.number, expiresOn: p.expiresOn, blurSuspected: p.blurSuspected },
                },
              },
              { upsert: true }
            );
            results.push({ uuid, ok: true, type: ev.type });
            break;
          }

          case 'wake_check': {
            await GuardFieldEvent.updateOne(
              { clientEventUuid: uuid },
              {
                $setOnInsert: {
                  ...common,
                  kind: 'wake_check',
                  wakeScheduleId: p.wakeId ?? p.wake_id ?? '',
                  missed: !!p.missed,
                  respondedMs: p.respondedMs ?? p.responded_ms,
                  status: 'acknowledged',
                },
              },
              { upsert: true }
            );
            results.push({ uuid, ok: true, type: ev.type, detail: { status: 'acknowledged' } });
            break;
          }

          case 'sos': {
            await GuardFieldEvent.updateOne(
              { clientEventUuid: uuid },
              {
                $setOnInsert: {
                  ...common,
                  kind: 'sos',
                  siteId: p.siteId ?? '',
                  siteName: p.siteName ?? '',
                  triggerMethod: p.trigger_method ?? 'long_press',
                  channel: p.channel ?? 'queue',
                  status: 'recorded',
                  meta: { batteryPct: p.battery_pct, networkState: p.network_state },
                },
              },
              { upsert: true }
            );
            results.push({ uuid, ok: true, type: ev.type });
            break;
          }

          case 'incident': {
            await GuardFieldEvent.updateOne(
              { clientEventUuid: uuid },
              {
                $setOnInsert: {
                  ...common,
                  kind: 'incident',
                  siteId: p.siteId ?? '',
                  siteName: p.siteName ?? '',
                  status: 'recorded',
                  meta: {
                    type: p.type,
                    severity: p.severity,
                    description: p.description,
                    injuries: !!p.injuries,
                    policeInformed: !!p.policeInformed,
                  },
                },
              },
              { upsert: true }
            );
            results.push({ uuid, ok: true, type: ev.type, detail: { incidentId: uuid, priority: p.severity ?? 'medium' } });
            break;
          }

          case 'leave': {
            await GuardFieldEvent.updateOne(
              { clientEventUuid: uuid },
              {
                $setOnInsert: {
                  ...common,
                  kind: 'leave',
                  fromDate: String(p.fromDate ?? p.from ?? ''),
                  toDate: String(p.toDate ?? p.to ?? p.fromDate ?? ''),
                  reason: String(p.reason ?? ''),
                  status: 'pending',
                  meta: { leaveType: p.leaveType ?? p.type ?? 'casual', halfDay: !!p.halfDay },
                },
              },
              { upsert: true }
            );
            results.push({ uuid, ok: true, type: ev.type, detail: { status: 'pending' } });
            break;
          }

          case 'location': {
            if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
              await APGuard.updateMany(
                { $or: [{ id: guardId }, { guardId }] },
                { $set: { lat: p.lat, lng: p.lng } }
              ).catch(() => {});
            }
            results.push({ uuid, ok: true, type: ev.type });
            break;
          }

          default:
            results.push({ uuid, ok: true, type: ev.type });
        }
        accepted.push(uuid);
      } catch (e: any) {
        if (e?.code === 11000) {
          accepted.push(uuid);
          results.push({ uuid, ok: true, type: ev.type, detail: { duplicate: true } });
        } else {
          results.push({ uuid, ok: false, type: ev.type, error: e?.message ?? 'ingest failed' });
        }
      }
    }

    return NextResponse.json({ success: true, accepted, results, sequenceGaps: [] });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'sync failed' }, { status: 500 });
  }
}
