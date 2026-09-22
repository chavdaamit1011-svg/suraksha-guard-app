import crypto from 'crypto';
import mongoose from 'mongoose';
import { AgencyRoster } from '@/lib/models/AgencyRoster';
import { PatrolCheckpoint, PatrolRound } from '@/lib/models/Patrol';
import { GuardFieldEvent } from '@/lib/models/GuardFieldEvent';
import { GuardMedia } from '@/lib/models/GuardMedia';
import { GuardWakeSchedule } from '@/lib/models/GuardWakeSchedule';
import { scoreEvent } from '@/lib/guardTrust';
import { callForMissedWake } from '@/lib/guardVoice';
import { addDays, evaluateGeofence, haversineM, istDateKey, resolveSite, shiftWindow } from '@/lib/guardRoster';

/**
 * Shared ingest for patrol scans and wake-check acknowledgements (PRD 18.7, 18.8), used by both
 * the online routes and the offline batch flush so an event captured in a stairwell is validated
 * identically to one captured on Wi-Fi.
 */

const PATROL_SECRET = process.env.GUARD_PATROL_SECRET || process.env.JWT_SECRET || 'suraksha-patrol';

/**
 * Checkpoint tokens are `SGP:<siteId>:<checkpointId>:<hmac>` where the hmac is keyed to a
 * per-site secret (PRD 18.7 §9) — photographing a tag and scanning the picture elsewhere fails
 * the location check even when the token itself is valid.
 *
 * A code that is not in this shape is still accepted: agencies have pre-existing printed tags
 * carrying a bare `scanCode`, and those resolve against the PatrolCheckpoint collection instead.
 */
export function verifyCheckpointToken(code: string): {
  hmacValid: boolean;
  siteId?: string;
  checkpointId?: string;
  method: 'qr_hmac' | 'plain';
} {
  const parts = (code ?? '').split(':');
  if (parts[0] === 'SGP' && parts.length === 4) {
    const [, siteId, checkpointId, hmac] = parts;
    const expected = crypto
      .createHmac('sha256', PATROL_SECRET)
      .update(`${siteId}:${checkpointId}`)
      .digest('hex')
      .slice(0, 16);
    return { hmacValid: hmac === expected, siteId, checkpointId, method: 'qr_hmac' };
  }
  return { hmacValid: false, method: 'plain' };
}

/** Locate the roster row a field event belongs to. Mirrors the attendance resolver. */
async function resolveRoster(guardId: string, rosterId: string | undefined, at: Date) {
  if (rosterId && mongoose.Types.ObjectId.isValid(rosterId)) {
    const r: any = await AgencyRoster.findById(rosterId).lean().catch(() => null);
    if (r) return r;
  }
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
    const dist =
      at < w.startAt ? w.startAt.getTime() - at.getTime() : at > w.endAt ? at.getTime() - w.endAt.getTime() : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = r;
    }
  }
  return bestDist <= 6 * 60 * 60 * 1000 ? best : null;
}

export type PatrolScanInput = {
  guardId: string;
  clientEventUuid: string;
  checkpointCode: string;
  scanMethod?: 'qr' | 'nfc' | 'manual';
  rosterId?: string;
  roundId?: string;
  bookingId?: string;
  lat?: number;
  lng?: number;
  accuracyM?: number;
  isMockLocation?: boolean;
  deviceTime?: string;
  mediaIds?: string[];
  note?: string;
  observationType?: 'all_ok' | 'issue' | 'note';
};

export type PatrolScanResult = {
  duplicate: boolean;
  verified: boolean;
  checkpointId: string;
  checkpointName: string;
  roundId: string;
  distanceM: number | null;
  flags: string[];
  roundStatus: string;
};

/**
 * A patrol scan is never rejected — an unverifiable tag, a damaged tag keyed in by hand, or a
 * scan 80 m from where the checkpoint is registered all get recorded and flagged for the
 * supervisor (PRD 18.7 §8/§16). Blocking the round would just teach guards to stop scanning.
 */
export async function ingestPatrolScan(i: PatrolScanInput): Promise<PatrolScanResult> {
  const at = i.deviceTime ? new Date(i.deviceTime) : new Date();
  const roster = await resolveRoster(i.guardId, i.rosterId, at);
  const token = verifyCheckpointToken(i.checkpointCode);
  const flags: string[] = [];

  // Resolve the checkpoint: by id from a signed token, else by the printed scanCode.
  let checkpoint: any = null;
  if (token.checkpointId && mongoose.Types.ObjectId.isValid(token.checkpointId)) {
    checkpoint = await PatrolCheckpoint.findById(token.checkpointId).lean().catch(() => null);
  }
  if (!checkpoint && i.checkpointCode) {
    checkpoint = await PatrolCheckpoint.findOne({ scanCode: i.checkpointCode }).lean().catch(() => null);
  }

  let siteId = checkpoint?.siteId ?? '';
  let siteName = checkpoint?.siteName ?? roster?.siteName ?? '';
  let distanceM: number | null = null;

  // The scan must belong to the site the guard is rostered to (PRD 18.7 §8).
  if (roster && checkpoint) {
    const resolved = await resolveSite(roster.agencyId ?? '', roster.siteName);
    if (resolved.siteId && siteId && resolved.siteId !== String(siteId)) {
      flags.push('checkpoint_wrong_site');
    }
    const geo = evaluateGeofence(resolved, i.lat, i.lng);
    distanceM = geo.distanceM;
    const scanRadius = resolved.config?.patrolScanRadiusM ?? 50;
    if (distanceM !== null && distanceM > scanRadius) flags.push('scan_far_from_checkpoint');
    if (!resolved.siteId) siteName = resolved.siteName || siteName;
  }

  if (!checkpoint) flags.push('checkpoint_unknown');
  if (token.method === 'qr_hmac' && !token.hmacValid) flags.push('hmac_invalid');
  if (i.scanMethod === 'manual') flags.push('manual_scan');
  if (i.isMockLocation) flags.push('mock_location');

  const verified = !!checkpoint && i.scanMethod !== 'manual' && !flags.includes('hmac_invalid') && !flags.includes('scan_far_from_checkpoint');

  const trust = scoreEvent({
    isMockLocation: !!i.isMockLocation,
    accuracyM: i.accuracyM,
    geofenceResult: distanceM === null ? 'unknown' : flags.includes('scan_far_from_checkpoint') ? 'outside' : 'inside',
    deviceTime: i.deviceTime,
    serverTime: Date.now(),
  });
  trust.reviewFlags = [...new Set([...trust.reviewFlags, ...flags])];

  // Attach the scan to an open round for this site/date when one exists.
  let round: any = null;
  if (i.roundId && !i.roundId.startsWith('gen:') && mongoose.Types.ObjectId.isValid(i.roundId)) {
    round = await PatrolRound.findById(i.roundId).catch(() => null);
  }
  if (!round && siteId) {
    round = await PatrolRound.findOne({
      siteId: String(siteId),
      scheduledDate: { $in: [istDateKey(at), addDays(istDateKey(at), -1)] },
      status: { $in: ['Scheduled', 'In progress'] },
    })
      .sort({ scheduledTime: 1 })
      .catch(() => null);
  }

  const res = await GuardFieldEvent.updateOne(
    { clientEventUuid: i.clientEventUuid },
    {
      $setOnInsert: {
        clientEventUuid: i.clientEventUuid,
        kind: 'patrol_scan',
        guardId: i.guardId,
        rosterId: roster ? String(roster._id) : '',
        shiftDate: roster?.date ?? '',
        siteId: String(siteId ?? ''),
        siteName,
        bookingId: i.bookingId ?? '',
        deviceTime: at,
        serverReceivedTime: new Date(),
        lat: i.lat,
        lng: i.lng,
        distanceM,
        mediaIds: i.mediaIds ?? [],
        checkpointCode: i.checkpointCode ?? '',
        checkpointId: checkpoint ? String(checkpoint._id) : '',
        roundId: round ? String(round._id) : '',
        scanMethod: i.scanMethod ?? (token.method === 'qr_hmac' ? 'qr' : 'manual'),
        reason: i.note ?? '',
        status: verified ? 'verified' : i.scanMethod === 'manual' ? 'manual' : 'unverified',
        eventTrustScore: trust.eventTrustScore,
        confidence: trust.confidence,
        reviewFlags: trust.reviewFlags,
        meta: { observationType: i.observationType ?? 'all_ok', hmacValid: token.hmacValid },
      },
    },
    { upsert: true }
  );

  const duplicate = (res as any).upsertedCount === 0;
  let roundStatus = round?.status ?? 'Scheduled';

  if (round && checkpoint && !duplicate) {
    const cpId = String(checkpoint._id);
    const already = (round.scans ?? []).some((s: any) => String(s.checkpointId) === cpId);
    if (!already) {
      round.scans.push({ checkpointId: cpId, scannedAt: at });
      const required: string[] = (round.checkpointIds ?? []).map(String);
      const scanned = new Set(round.scans.map((s: any) => String(s.checkpointId)));
      // Completion is computed server-side; the client's view is advisory (PRD 18.7 §10).
      round.status = required.length > 0 && required.every((id) => scanned.has(id)) ? 'Completed' : 'In progress';
      roundStatus = round.status;
      await round.save().catch(() => {});
    }
  }

  await bindMedia(i.mediaIds, i.clientEventUuid, roster ? String(roster._id) : '');

  // A scan proves wakefulness: suppress a wake prompt due within the next 30 minutes
  // (PRD 18.8 §9 — "a scan proves wakefulness and suppresses the next prompt").
  if (!duplicate) {
    await GuardWakeSchedule.updateMany(
      {
        guardId: i.guardId,
        status: 'pending',
        dueAt: { $gte: at, $lte: new Date(at.getTime() + 30 * 60_000) },
      },
      { $set: { status: 'suppressed', suppressedBy: i.clientEventUuid } }
    ).catch(() => {});
  }

  return {
    duplicate,
    verified,
    checkpointId: checkpoint ? String(checkpoint._id) : '',
    checkpointName: checkpoint?.name ?? '',
    roundId: round ? String(round._id) : '',
    distanceM,
    flags: trust.reviewFlags,
    roundStatus,
  };
}

export type PatrolObservationInput = {
  guardId: string;
  /** The scan this observation belongs to. */
  scanUuid: string;
  observationType: 'all_ok' | 'issue' | 'note';
  note?: string;
  mediaIds?: string[];
};

/**
 * What the guard saw at a checkpoint (PRD 18.7 §6): All OK, a photo, a voice note, or an issue.
 *
 * The scan is recorded the moment the tag is read, so the observation arrives afterwards and is
 * folded into that scan rather than stored as a second event. An issue flags the scan for the
 * supervisor and is pushed to them straight away.
 */
export async function recordPatrolObservation(i: PatrolObservationInput): Promise<{ found: boolean }> {
  const type = (['all_ok', 'issue', 'note'] as const).includes(i.observationType) ? i.observationType : 'note';
  const mediaIds = (i.mediaIds ?? []).map(String).slice(0, 5);
  const note = String(i.note ?? '').trim().slice(0, 1000);

  const scan: any = await GuardFieldEvent.findOneAndUpdate(
    { clientEventUuid: i.scanUuid, guardId: i.guardId, kind: 'patrol_scan' },
    {
      $set: { 'meta.observationType': type, 'meta.observedAt': new Date(), ...(note ? { reason: note } : {}) },
      ...(mediaIds.length ? { $addToSet: { mediaIds: { $each: mediaIds } } } : {}),
    },
    { new: true }
  ).lean();
  if (!scan) return { found: false };

  if (type === 'issue') {
    await GuardFieldEvent.updateOne({ _id: scan._id }, { $addToSet: { reviewFlags: 'patrol_issue' } });
    try {
      (globalThis as any).__io?.emit?.('new-notification', {
        kind: 'PATROL_ISSUE',
        audience: ['supervisor', 'command_center'],
        guardId: i.guardId,
        siteId: scan.siteId,
        siteName: scan.siteName,
        checkpointId: scan.checkpointId,
        scanUuid: i.scanUuid,
        note,
        mediaIds: scan.mediaIds ?? [],
        at: new Date().toISOString(),
      });
    } catch {
      /* ignore */
    }
  }

  await bindMedia(mediaIds, i.scanUuid, scan.rosterId ?? '');
  return { found: true };
}

export type WakeAckInput = {
  guardId: string;
  clientEventUuid: string;
  wakeId?: string;
  rosterId?: string;
  bookingId?: string;
  missed?: boolean;
  /** 1 for the scheduled prompt, 2 for the re-prompt, and so on. */
  attempt?: number;
  respondedMs?: number;
  deviceTime?: string;
  lat?: number;
  lng?: number;
  mediaIds?: string[];
};

/**
 * Wake-check acknowledgement or recorded miss (PRD 18.8 §9, §11, SUR-GAP-016).
 *
 * The miss ladder:
 *   miss 1 → the device re-prompts after 60 s; the slot is `reprompted`, nobody is called yet
 *   miss 2 → slot `missed`, supervisor alerted at P2 (and, where telephony exists, an IVR call)
 *   miss 3 → Command Center alerted at P1
 *
 * Escalation beyond raising the alert — who is called, in what order — belongs to the Command
 * Center (§24). This only decides *that* it must happen, and at what priority.
 */
export async function ingestWakeCheck(i: WakeAckInput) {
  const at = i.deviceTime ? new Date(i.deviceTime) : new Date();
  const roster = await resolveRoster(i.guardId, i.rosterId, at);

  let scheduled: any = null;
  if (i.wakeId && mongoose.Types.ObjectId.isValid(i.wakeId)) {
    scheduled = await GuardWakeSchedule.findById(i.wakeId).lean().catch(() => null);
  }
  if (!scheduled) {
    // Match the prompt this acknowledgement most plausibly answers: the nearest open one.
    scheduled = await GuardWakeSchedule.findOne({
      guardId: i.guardId,
      status: { $in: ['pending', 'reprompted'] },
      dueAt: { $gte: new Date(at.getTime() - 30 * 60_000), $lte: new Date(at.getTime() + 5 * 60_000) },
    })
      .sort({ dueAt: -1 })
      .lean()
      .catch(() => null);
  }

  const ackWindowMs = (scheduled?.ackWindowSec ?? 120) * 1000;
  // Answering the re-prompt counts, but it is late by definition — the first prompt was missed.
  const lateAck =
    !i.missed && scheduled
      ? scheduled.status === 'reprompted' || at.getTime() - new Date(scheduled.dueAt).getTime() > ackWindowMs
      : false;

  const priorMisses: number = scheduled?.missCount ?? 0;
  const missCount = i.missed ? Math.max(priorMisses + 1, i.attempt ?? 1) : priorMisses;
  const escalation: '' | 'P2' | 'P1' = !i.missed ? '' : missCount >= 3 ? 'P1' : missCount >= 2 ? 'P2' : '';
  const slotStatus = i.missed
    ? missCount >= 2
      ? 'missed'
      : 'reprompted'
    : lateAck
      ? 'acknowledged_late'
      : 'acknowledged';

  const res = await GuardFieldEvent.updateOne(
    { clientEventUuid: i.clientEventUuid },
    {
      $setOnInsert: {
        clientEventUuid: i.clientEventUuid,
        kind: 'wake_check',
        guardId: i.guardId,
        rosterId: roster ? String(roster._id) : '',
        shiftDate: roster?.date ?? '',
        siteId: scheduled?.siteId ?? '',
        siteName: scheduled?.siteName ?? roster?.siteName ?? '',
        bookingId: i.bookingId ?? '',
        deviceTime: at,
        serverReceivedTime: new Date(),
        lat: i.lat,
        lng: i.lng,
        mediaIds: i.mediaIds ?? [],
        respondedMs: i.respondedMs,
        missed: !!i.missed,
        wakeScheduleId: scheduled ? String(scheduled._id) : '',
        status: slotStatus,
        meta: { attempt: i.attempt ?? 1, escalation },
      },
    },
    { upsert: true }
  );

  const duplicate = (res as any).upsertedCount === 0;

  if (scheduled && !duplicate) {
    await GuardWakeSchedule.updateOne(
      { _id: scheduled._id },
      {
        $set: {
          status: slotStatus,
          missCount,
          acknowledgedAt: i.missed ? null : at,
          respondedMs: i.respondedMs ?? null,
          mediaId: (i.mediaIds ?? [])[0] ?? '',
          ...(escalation ? { escalatedAt: escalation } : {}),
        },
      }
    ).catch(() => {});

    if (escalation) {
      // The call runs alongside the supervisor alert, not before it.
      void callForMissedWake(String(scheduled._id), i.guardId);
      try {
        (globalThis as any).__io?.emit?.('new-notification', {
          kind: 'WAKE_CHECK_MISSED',
          priority: escalation,
          // P2 goes to the supervisor; P1 to the Command Center queue (PRD 18.8 §9, §24).
          audience: escalation === 'P1' ? 'command_center' : 'supervisor',
          guardId: i.guardId,
          wakeId: String(scheduled._id),
          siteName: scheduled.siteName,
          missCount,
          at: new Date().toISOString(),
        });
      } catch {
        /* socket server not attached in this process */
      }
    }
  }

  await bindMedia(i.mediaIds, i.clientEventUuid, roster ? String(roster._id) : '');

  return {
    duplicate,
    status: slotStatus,
    missCount,
    escalation,
    wakeId: scheduled ? String(scheduled._id) : '',
  };
}

/** Point uploaded media at the event it belongs to, once that event exists. */
async function bindMedia(mediaIds: string[] | undefined, clientEventUuid: string, rosterId: string) {
  if (!mediaIds?.length) return;
  await GuardMedia.updateMany(
    { mediaId: { $in: mediaIds }, clientEventUuid: '' },
    { $set: { clientEventUuid, rosterId } }
  ).catch(() => {});
}

export { haversineM };
