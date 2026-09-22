import mongoose from 'mongoose';
import { AgencyRoster } from '@/lib/models/AgencyRoster';
import { GuardAttendance } from '@/lib/models/GuardAttendance';
import { GuardMedia } from '@/lib/models/GuardMedia';
import { scoreEvent } from '@/lib/guardTrust';
import { verifyFaceForEvent } from '@/lib/guardFaceVerify';
import { readOwnMedia } from '@/lib/guardMediaStore';
import {
  dutyPolicy,
  dutyState,
  evaluateGeofence,
  haversineM,
  istDateKey,
  addDays,
  resolveSite,
  shiftWindow,
} from '@/lib/guardRoster';

/**
 * One attendance ingest path, shared by the online route (/api/guard/attendance) and the offline
 * batch flush (/api/guard/sync), so a check-in captured in a basement is scored and geofenced by
 * exactly the same code as one captured on Wi-Fi. PRD 18.5 §10.
 *
 * Two rules drive the shape of this:
 *  - The server is authoritative on geofence and on time. The client's own verdict is recorded
 *    but never believed (18.5 §10, 18.6 §14).
 *  - A failed check never blocks duty. Everything is written; a bad signal lowers the trust score
 *    and raises a review flag (18.5 §8, 18.17.1 rule 12).
 */

/** Device face-check verdicts worth a review flag; anything else the client sends is ignored. */
const FACE_CHECK_FLAGS = new Set(['no_face', 'many_faces', 'too_small', 'eyes_closed', 'turned']);

export type AttendanceInput = {
  guardId: string;
  clientEventUuid: string;
  eventType: 'check_in' | 'check_out' | 'break_start' | 'break_end';
  rosterId?: string;
  bookingId?: string;
  captureSequenceNo?: number;

  deviceTime?: string;
  /** Device uptime clock at capture, for the offline time reconstruction (18.15.5). */
  monotonicMs?: number;
  /** Device uptime clock at flush. Present only on queued events. */
  monotonicNowMs?: number;
  /** True when the device rebooted between capture and flush — breaks the monotonic chain. */
  rebooted?: boolean;

  lat?: number;
  lng?: number;
  accuracyM?: number;
  provider?: string;
  isMockLocation?: boolean;
  geofenceResult?: string; // client hint only
  outsideReason?: string;
  earlyOutReason?: string;

  deviceId?: string;
  deviceModel?: string;
  osVersion?: string;
  appVersion?: string;
  batteryPct?: number;
  isCharging?: boolean;
  networkState?: string;

  selfieMediaId?: string;
  selfieUri?: string;
  photoHash?: string;
  /** On-device face check verdict for the selfie (`ok`, `no_face`, `many_faces`, …). */
  faceCheck?: string;
  deviceIntegrityCompromised?: boolean;

  /** Client-reported device integrity hints (PRD 18.6 §9). Treated as hints, never as authority. */
  isRooted?: boolean;
  isEmulator?: boolean;
  developerMode?: boolean;
  appTampered?: boolean;
  /** A gap in the per-device capture counter, detected by the sync route. */
  sequenceGapDetected?: boolean;
};

export type AttendanceResult = {
  accepted: boolean;
  duplicate: boolean;
  geofenceResult: 'inside' | 'outside' | 'unknown';
  distanceM: number | null;
  lateByMin: number;
  trust: ReturnType<typeof scoreEvent>;
  rosterId: string;
  estimatedTrueTime: string | null;
};

/**
 * Reconstruct when an offline event actually happened (PRD 18.15.5). The device clock can be
 * wrong or deliberately set back; the monotonic uptime clock cannot be. Knowing its own receipt
 * time, the server walks the monotonic delta backwards:
 *     estimated_true_time = server_receipt_time − (monotonic_now − monotonic_at_event)
 * A reboot breaks the chain, so we fall back to device_time and mark the confidence.
 */
function reconstructTime(i: AttendanceInput, serverNow: number): { estimated: Date | null; broken: boolean } {
  if (i.rebooted) return { estimated: null, broken: true };
  if (!Number.isFinite(i.monotonicMs) || !Number.isFinite(i.monotonicNowMs)) {
    return { estimated: null, broken: false };
  }
  const elapsed = (i.monotonicNowMs as number) - (i.monotonicMs as number);
  if (elapsed < 0) return { estimated: null, broken: true }; // uptime went backwards → reboot
  return { estimated: new Date(serverNow - elapsed), broken: false };
}

/** Find the roster row an event belongs to, when the client did not name one. */
async function resolveRoster(guardId: string, rosterId: string | undefined, at: Date) {
  if (rosterId && mongoose.Types.ObjectId.isValid(rosterId)) {
    const r: any = await AgencyRoster.findById(rosterId).lean().catch(() => null);
    if (r) return r;
  }
  // Fall back to the shift whose window contains `at`, searching yesterday too so a night shift
  // rostered on the 12th still claims a 03:00 event on the 13th.
  const key = istDateKey(at);
  const candidates: any[] = await AgencyRoster.find({
    date: { $in: [addDays(key, -1), key] },
    'assignedGuards.guardId': guardId,
  })
    .lean()
    .catch(() => []);

  let best: any = null;
  let bestDist = Infinity;
  for (const r of candidates) {
    const w = shiftWindow(r.date, r.timing);
    // Distance from the shift window, zero when inside it.
    const dist =
      at < w.startAt ? w.startAt.getTime() - at.getTime() : at > w.endAt ? at.getTime() - w.endAt.getTime() : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = r;
    }
  }
  // Only claim a shift the event is plausibly part of — within 6 hours of its window.
  return bestDist <= 6 * 60 * 60 * 1000 ? best : null;
}

/**
 * Impossible travel (PRD 18.6 §9): how fast this guard would have had to move to get from their
 * previous located event to this one.
 *
 * Derived here rather than trusted from the client, because it is the one anti-spoof signal a
 * faked location cannot hide from — a device can lie about *where* it is, but not about where it
 * said it was an hour ago. Returns undefined when there is no comparable previous fix.
 */
async function impliedSpeedSincePrevious(
  guardId: string,
  lat: number | undefined,
  lng: number | undefined,
  at: Date
): Promise<number | undefined> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;

  const previous: any = await GuardAttendance.findOne({
    guardId,
    lat: { $exists: true, $ne: null },
    lng: { $exists: true, $ne: null },
    serverReceivedTime: { $lt: at },
  })
    .sort({ serverReceivedTime: -1 })
    .select('lat lng serverReceivedTime estimatedTrueTime')
    .lean()
    .catch(() => null);

  if (!previous) return undefined;

  const prevAt = new Date(previous.estimatedTrueTime ?? previous.serverReceivedTime).getTime();
  const hours = (at.getTime() - prevAt) / 3_600_000;
  // Under a minute apart, GPS jitter alone produces absurd speeds. Not a signal.
  if (hours <= 1 / 60) return undefined;

  const km = haversineM(lat as number, lng as number, previous.lat, previous.lng) / 1000;
  return Math.round(km / hours);
}

export async function ingestAttendance(i: AttendanceInput): Promise<AttendanceResult> {
  const serverNow = Date.now();
  const deviceAt = i.deviceTime ? new Date(i.deviceTime) : new Date(serverNow);
  const { estimated, broken } = reconstructTime(i, serverNow);
  const effectiveAt = estimated ?? deviceAt;

  const roster = await resolveRoster(i.guardId, i.rosterId, effectiveAt);
  const rosterId = roster ? String(roster._id) : '';

  // --- Server-authoritative geofence ---
  let geofenceResult: 'inside' | 'outside' | 'unknown' = 'unknown';
  let distanceM: number | null = null;
  let siteId = '';
  let siteName = roster?.siteName ?? '';
  let lateByMin = 0;

  if (roster) {
    const resolved = await resolveSite(roster.agencyId ?? '', roster.siteName);
    siteId = resolved.siteId;
    siteName = resolved.siteName || roster.siteName;
    const geo = evaluateGeofence(resolved, i.lat, i.lng);
    geofenceResult = geo.geofenceResult;
    distanceM = geo.distanceM;

    if (i.eventType === 'check_in') {
      const w = shiftWindow(roster.date, roster.timing);
      const p = dutyPolicy(resolved.config);
      const state = dutyState({ window: w, policy: p, checkedInAt: effectiveAt, checkedOutAt: null, now: effectiveAt });
      lateByMin = state.lateByMin;
    }
  }

  // On a good connection the app uploads the selfie before the queued record arrives, so the
  // upload could not be bound then. Pick it up now by the shared event id.
  let lateSelfie = false;
  if (!i.selfieMediaId && (i.eventType === 'check_in' || i.eventType === 'check_out')) {
    const early: any = await GuardMedia.findOne({ clientEventUuid: i.clientEventUuid, guardId: i.guardId, kind: 'selfie' })
      .select('mediaId sha256')
      .lean()
      .catch(() => null);
    if (early) {
      i = { ...i, selfieMediaId: early.mediaId, photoHash: i.photoHash || early.sha256 };
      lateSelfie = true;
    }
  }

  // Reused-media detection spans both the hash the client sent and the uploaded bytes.
  const hashSeen = i.photoHash
    ? !!(await GuardAttendance.exists({ photoHash: i.photoHash, clientEventUuid: { $ne: i.clientEventUuid } }))
    : false;
  const mediaSeen = i.selfieMediaId
    ? !!(await GuardMedia.exists({ mediaId: i.selfieMediaId, clientEventUuid: { $nin: ['', i.clientEventUuid] } }))
    : false;

  const impliedSpeedKmh = await impliedSpeedSincePrevious(i.guardId, i.lat, i.lng, effectiveAt);

  const trust = scoreEvent({
    isMockLocation: !!i.isMockLocation,
    accuracyM: i.accuracyM,
    geofenceResult,
    deviceTime: i.deviceTime,
    serverTime: serverNow,
    photoHashSeenBefore: hashSeen || mediaSeen,
    deviceIntegrityCompromised: !!i.deviceIntegrityCompromised,
    isRooted: !!i.isRooted,
    isEmulator: !!i.isEmulator,
    developerMode: !!i.developerMode,
    appTampered: !!i.appTampered,
    impliedSpeedKmh,
    sequenceGapDetected: !!i.sequenceGapDetected,
  });
  if (broken) {
    trust.timeConfidence = 'low';
    if (!trust.reviewFlags.includes('monotonic_chain_broken')) trust.reviewFlags.push('monotonic_chain_broken');
  }
  // Missing evidence is a review signal, not a rejection.
  if (!i.selfieMediaId && (i.eventType === 'check_in' || i.eventType === 'check_out')) {
    trust.reviewFlags.push('no_selfie_media');
  }
  // The phone's own face check still failed after its automatic retakes (the photo was kept so
  // duty is not blocked). A hint for the reviewer; the server-side face match decides.
  if (i.faceCheck && FACE_CHECK_FLAGS.has(i.faceCheck)) {
    trust.reviewFlags.push(`device_face_${i.faceCheck}`);
  }

  const res = await GuardAttendance.updateOne(
    { clientEventUuid: i.clientEventUuid },
    {
      $setOnInsert: {
        clientEventUuid: i.clientEventUuid,
        captureSequenceNo: i.captureSequenceNo ?? 0,
        guardId: i.guardId,
        rosterId,
        shiftDate: roster?.date ?? '',
        siteId,
        siteName,
        bookingId: i.bookingId ?? '',
        eventType: i.eventType,

        deviceTime: i.deviceTime ? new Date(i.deviceTime) : undefined,
        serverReceivedTime: new Date(serverNow),
        monotonicMs: i.monotonicMs,
        estimatedTrueTime: estimated ?? undefined,

        lat: i.lat,
        lng: i.lng,
        accuracyM: i.accuracyM,
        provider: i.provider ?? '',
        geofenceResult,
        distanceM,
        outsideReason: i.outsideReason ?? '',
        earlyOutReason: i.earlyOutReason ?? '',
        isMockLocation: !!i.isMockLocation,

        deviceId: i.deviceId ?? '',
        deviceModel: i.deviceModel ?? '',
        osVersion: i.osVersion ?? '',
        appVersion: i.appVersion ?? '',
        batteryPct: i.batteryPct,
        isCharging: i.isCharging,
        networkState: i.networkState ?? '',

        selfieMediaId: i.selfieMediaId ?? '',
        selfieUri: i.selfieUri ?? '',
        photoHash: i.photoHash ?? '',

        lateByMin,
        confidence: trust.confidence,
        eventTrustScore: trust.eventTrustScore,
        timeConfidence: trust.timeConfidence,
        reviewFlags: trust.reviewFlags,
      },
    },
    { upsert: true }
  );

  const duplicate = (res as any).upsertedCount === 0;

  // Bind the uploaded selfie to this event so evidence and metadata reconcile after sync.
  if (i.selfieMediaId && !duplicate) {
    await GuardMedia.updateOne(
      { mediaId: i.selfieMediaId, clientEventUuid: '' },
      { $set: { clientEventUuid: i.clientEventUuid, rosterId } }
    ).catch(() => {});
  }

  // Race: the upload and this record can land within milliseconds of each other, each looking
  // for the other before it is saved (seen on a real phone: 12 ms apart). Look once more now
  // that the record exists; an upload arriving after this point finds the record itself.
  if (!i.selfieMediaId && !duplicate && (i.eventType === 'check_in' || i.eventType === 'check_out')) {
    const racing: any = await GuardMedia.findOne({ clientEventUuid: i.clientEventUuid, guardId: i.guardId, kind: 'selfie' })
      .select('mediaId sha256')
      .lean()
      .catch(() => null);
    if (racing) {
      await GuardAttendance.updateOne(
        { clientEventUuid: i.clientEventUuid, selfieMediaId: { $in: ['', null] } },
        {
          $set: { selfieMediaId: racing.mediaId, ...(racing.sha256 && !i.photoHash ? { photoHash: racing.sha256 } : {}) },
          $pull: { reviewFlags: 'no_selfie_media' },
        }
      ).catch(() => {});
      i = { ...i, selfieMediaId: racing.mediaId };
      lateSelfie = true;
    }
  }

  // The selfie's own upload already tried face verification and found no record; run it now.
  if (lateSelfie && !duplicate && i.eventType === 'check_in') {
    const guardId = i.guardId;
    const uuid = i.clientEventUuid;
    const mediaId = i.selfieMediaId!;
    void readOwnMedia(mediaId, guardId)
      .then((bytes) => (bytes ? verifyFaceForEvent(guardId, uuid, bytes) : undefined))
      .catch(() => {});
  }

  // Reflect the guard's live state onto the roster row so the agency portal's Command Center and
  // the client live view see it without a separate write path.
  if (roster && !duplicate && (i.eventType === 'check_in' || i.eventType === 'check_out')) {
    const hhmm = new Date(effectiveAt.getTime() + 330 * 60_000).toISOString().slice(11, 16);
    await AgencyRoster.updateOne(
      { _id: roster._id, 'assignedGuards.guardId': i.guardId },
      {
        $set:
          i.eventType === 'check_in'
            ? { 'assignedGuards.$.status': 'On Site', 'assignedGuards.$.checkInTime': hhmm }
            : { 'assignedGuards.$.status': 'Checked Out', 'assignedGuards.$.checkOutTime': hhmm },
      }
    ).catch(() => {});
  }

  return {
    accepted: true,
    duplicate,
    geofenceResult,
    distanceM,
    lateByMin,
    trust,
    rosterId,
    estimatedTrueTime: estimated ? estimated.toISOString() : null,
  };
}
