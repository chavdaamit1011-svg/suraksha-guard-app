import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/db';
import { GuardAttendance } from '@/lib/models/GuardAttendance';
import { GuardFieldEvent } from '@/lib/models/GuardFieldEvent';
import { APGuard } from '@/lib/models/APGuard';
import { ingestAttendance } from '@/lib/guardAttendanceIngest';
import { ingestPatrolScan, ingestWakeCheck, recordPatrolObservation } from '@/lib/guardFieldIngest';
import { validateLeave } from '@/lib/guardLeave';
import { recordDocument } from '@/lib/guardDocuments';
import { recordIncident } from '@/lib/guardIncident';

export const dynamic = 'force-dynamic';

/**
 * Bulk offline-queue flush (PRD 18.15.3 / SUR-GAP-029).
 *
 * Three properties this route has to hold:
 *  - **Per-event results.** One poison event must not sink the batch, so every event is tried
 *    independently and reported independently.
 *  - **Priority order.** P0 SOS → P1 attendance + wake acks → P2 patrol → P3 incidents → P4 the
 *    rest, regardless of the order the device sent them in. An operator should see the SOS
 *    before the leave request that happened to be queued in front of it.
 *  - **Idempotency.** Everything keys on `client_event_uuid`; a re-sent event returns the
 *    original rather than creating a second one.
 *
 * It also reports **sequence gaps**: `capture_sequence_no` is a per-device counter that never
 * resets, so a missing range means events were deleted from the queue (18.15.6).
 */

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
    const { guardId, events, device } = await req.json();
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

    // Computed before ingest so a detected gap can weigh on the events in this very batch, not
    // just be reported after the fact (PRD 18.15.6).
    const gaps = await detectSequenceGaps(guardId, events);
    const hasGap = gaps.length > 0;

    const ordered = [...events].sort(
      (a, b) =>
        (PRIORITY[a?.type] ?? 9) - (PRIORITY[b?.type] ?? 9) ||
        (a?.capture_sequence_no ?? 0) - (b?.capture_sequence_no ?? 0)
    );

    const accepted: string[] = [];
    // `retry: true` marks a refusal that is only temporary, which the device keeps pending.
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
        rosterId: p.rosterId,
        bookingId: p.bookingId,
        deviceTime: ev.device_time,
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
            const r = await ingestAttendance({
              ...common,
              eventType: ev.type,
              captureSequenceNo: ev.capture_sequence_no,
              monotonicMs: ev.monotonic_ms,
              monotonicNowMs: device?.monotonic_now_ms,
              // The uptime reading only means anything within one app process. If the event was
              // captured in an earlier process the chain is broken and the reconstruction in
              // 18.15.5 cannot be trusted — fall back to device_time with a confidence flag.
              rebooted: !!ev.process_id && !!device?.process_id && ev.process_id !== device.process_id,
              accuracyM: p.accuracy_m,
              provider: p.provider,
              isMockLocation: !!p.is_mock_location,
              geofenceResult: p.geofence_result,
              outsideReason: p.outside_reason,
              earlyOutReason: p.early_out_reason,
              deviceId: p.device_id,
              deviceModel: p.device?.model,
              osVersion: p.device?.os,
              appVersion: p.device?.appVersion,
              batteryPct: p.battery_pct,
              isCharging: p.is_charging,
              networkState: p.network_state,
              selfieMediaId: p.selfie_media_id,
              selfieUri: p.selfie_uri,
              photoHash: p.photo_hash,
              faceCheck: typeof p.face_check === 'string' ? p.face_check : undefined,
              deviceIntegrityCompromised: !!p.device_integrity_compromised,
              isRooted: !!p.is_rooted,
              isEmulator: !!p.is_emulator,
              developerMode: !!p.developer_mode,
              appTampered: !!p.app_tampered,
              sequenceGapDetected: hasGap,
            });
            results.push({
              uuid,
              ok: true,
              type: ev.type,
              detail: {
                geofenceResult: r.geofenceResult,
                distanceM: r.distanceM,
                lateByMin: r.lateByMin,
                trustScore: r.trust.eventTrustScore,
              },
            });
            break;
          }

          case 'patrol_scan': {
            const r = await ingestPatrolScan({
              ...common,
              checkpointCode: p.checkpointCode ?? p.checkpoint_code ?? '',
              scanMethod: p.method ?? p.scan_method,
              roundId: p.roundId ?? p.round_id,
              accuracyM: p.accuracy_m,
              isMockLocation: !!p.is_mock_location,
              note: p.note,
              observationType: p.observation_type,
            });
            results.push({ uuid, ok: true, type: ev.type, detail: { verified: r.verified, roundStatus: r.roundStatus } });
            break;
          }

          case 'patrol_observation': {
            const r = await recordPatrolObservation({
              guardId,
              scanUuid: p.scanUuid ?? p.scan_uuid ?? '',
              observationType: p.observation_type ?? p.observationType,
              note: p.note,
              mediaIds: common.mediaIds,
            });
            // Scans sort ahead of observations in this batch, so a miss means the scan has not
            // reached the server yet; failing lets the device retry once it has.
            if (!r.found) {
              results.push({ uuid, ok: false, retry: true, type: ev.type, error: 'scan_not_found' });
              continue; // not accepted: the device keeps it and sends it again
            }
            results.push({ uuid, ok: true, type: ev.type });
            break;
          }

          case 'document': {
            const r = await recordDocument({
              guardId,
              kind: p.kind,
              // The scan was uploaded under this id; the record must carry it to be linked.
              clientEventUuid: p.mediaUuid ?? p.media_uuid ?? uuid,
              number: p.number,
              expiresOn: p.expiresOn ?? p.expires_on,
              blurSuspected: !!(p.blurSuspected ?? p.blur_suspected),
            });
            // A malformed document can never succeed: report it as a permanent failure, which the
            // device marks failed (and shows in App health) instead of retrying it forever.
            results.push({ uuid, ok: r.ok, type: ev.type, ...(r.ok ? {} : { error: r.message }) });
            if (!r.ok) continue;
            break;
          }

          case 'wake_check': {
            const r = await ingestWakeCheck({
              ...common,
              wakeId: p.wakeId ?? p.wake_id,
              missed: !!p.missed,
              attempt: Number(p.attempt ?? 1),
              respondedMs: p.respondedMs ?? p.responded_ms,
            });
            results.push({ uuid, ok: true, type: ev.type, detail: { status: r.status } });
            break;
          }

          case 'sos': {
            await GuardFieldEvent.updateOne(
              { clientEventUuid: uuid },
              {
                $setOnInsert: {
                  clientEventUuid: uuid,
                  kind: 'sos',
                  guardId,
                  rosterId: p.rosterId ?? '',
                  bookingId: p.bookingId ?? '',
                  siteId: p.siteId ?? '',
                  siteName: p.siteName ?? '',
                  deviceTime: ev.device_time ? new Date(ev.device_time) : new Date(),
                  lat: p.lat,
                  lng: p.lng,
                  mediaIds: common.mediaIds,
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
            // Same record as the online route: agency-scoped, site named, severity mapped.
            const r = await recordIncident({
              guardId,
              key: uuid,
              type: p.type,
              severity: p.severity,
              description: p.description,
              mediaIds: common.mediaIds,
              bookingId: p.bookingId,
              rosterId: p.rosterId,
              siteId: p.siteId,
              siteName: p.siteName,
              lat: p.lat,
              lng: p.lng,
              occurredAt: p.occurredAt ?? ev.device_time,
              injuries: !!p.injuries,
              policeInformed: !!p.policeInformed,
            });
            results.push({ uuid, ok: true, type: ev.type, detail: { incidentId: r.incidentId, priority: r.priority } });
            break;
          }

          case 'leave': {
            const already: any = await GuardFieldEvent.findOne({ clientEventUuid: uuid }).lean();
            if (already) {
              results.push({ uuid, ok: true, type: ev.type, detail: { duplicate: true, status: already.status } });
              break;
            }

            const leaveType = String(p.leaveType ?? p.type ?? 'casual');
            const from = String(p.fromDate ?? p.from ?? '');
            const to = String(p.toDate ?? p.to ?? from);
            const reason = String(p.reason ?? '');
            const check = await validateLeave({
              guardId,
              type: leaveType,
              from,
              to,
              reason,
              hasVoice: common.mediaIds.length > 0 || !!p.hasVoice,
              halfDay: !!p.halfDay,
            });

            // An offline request that turns out to be invalid — most often for a day the guard
            // then worked — is recorded as rejected with the reason, so the guard is told rather
            // than the request vanishing (PRD 18.15.4). It is still "accepted" by the sync so the
            // device clears it instead of retrying forever.
            await GuardFieldEvent.updateOne(
              { clientEventUuid: uuid },
              {
                $setOnInsert: {
                  clientEventUuid: uuid,
                  kind: 'leave',
                  guardId,
                  deviceTime: ev.device_time ? new Date(ev.device_time) : new Date(),
                  serverReceivedTime: new Date(),
                  fromDate: from,
                  toDate: to,
                  reason,
                  mediaIds: common.mediaIds,
                  status: check.ok ? 'pending' : 'rejected',
                  reviewFlags: check.ok && check.retrospective ? ['retrospective_leave'] : [],
                  meta: {
                    leaveType,
                    halfDay: !!p.halfDay,
                    days: check.ok ? check.days : null,
                    retrospective: check.ok ? check.retrospective : false,
                    ...(check.ok ? {} : { decisionNote: check.message, rejectCode: check.code }),
                  },
                },
              },
              { upsert: true }
            );
            results.push({
              uuid,
              ok: true,
              type: ev.type,
              detail: check.ok ? { status: 'pending' } : { status: 'rejected', reason: check.message },
            });
            break;
          }

          case 'location': {
            if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
              await APGuard.findByIdAndUpdate(guardId, { $set: { lat: p.lat, lng: p.lng } }).catch(() => {});
            }
            results.push({ uuid, ok: true, type: ev.type });
            break;
          }

          default:
            // Unknown type: accept it so the device can drop it rather than retry forever, but
            // say so. A permanently stuck queue entry is worse than an unrecognised record.
            results.push({ uuid, ok: true, type: ev.type, error: 'unknown event type, discarded' });
        }
        accepted.push(uuid);
      } catch (e: any) {
        if (e?.code === 11000) {
          // Already ingested — still "accepted" so the app clears it.
          accepted.push(uuid);
          results.push({ uuid, ok: true, type: ev.type, detail: { duplicate: true } });
        } else {
          results.push({ uuid, ok: false, type: ev.type, error: e?.message ?? 'ingest failed' });
        }
      }
    }

    return NextResponse.json({ success: true, accepted, results, sequenceGaps: gaps });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'sync failed' }, { status: 500 });
  }
}

/**
 * Missing `capture_sequence_no` values mean events were removed from the device queue before it
 * flushed (PRD 18.15.6). We report the gap rather than act on it — the range goes to Compliance.
 */
async function detectSequenceGaps(guardId: string, events: any[]): Promise<{ from: number; to: number }[]> {
  const incoming = events.map((e) => e?.capture_sequence_no).filter((n) => Number.isFinite(n) && n > 0) as number[];
  if (incoming.length === 0) return [];

  const highest: any = await GuardAttendance.findOne({ guardId })
    .sort({ captureSequenceNo: -1 })
    .select('captureSequenceNo')
    .lean()
    .catch(() => null);

  const seen = new Set(incoming);
  const lowest = Math.min(...incoming);
  const previousMax = highest?.captureSequenceNo ?? 0;

  const gaps: { from: number; to: number }[] = [];
  // Gap between what the server last saw and the lowest number in this batch.
  if (previousMax > 0 && lowest > previousMax + 1) gaps.push({ from: previousMax + 1, to: lowest - 1 });

  // Gaps inside the batch itself.
  const sorted = [...seen].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] > sorted[i - 1] + 1) gaps.push({ from: sorted[i - 1] + 1, to: sorted[i] - 1 });
  }
  return gaps.slice(0, 20);
}
