import * as Crypto from 'expo-crypto';
import { api } from './api';
import { signEvent } from './device';
import { flushMedia } from './media';
import { KEYS, store } from './storage';

/**
 * Offline-first event outbox (PRD 18.15.3 / SUR-GAP-029).
 *
 * Every duty-critical action is written here first with a `client_event_uuid` (the server's
 * idempotency key) and a monotonically increasing `capture_sequence_no` that never resets, so
 * events deleted from the queue leave a detectable gap (18.15.6). Nothing is ever dropped
 * silently: a permanently rejected event is surfaced to the guard instead.
 */

export type EventType =
  | 'check_in'
  | 'check_out'
  | 'break_start'
  | 'break_end'
  | 'patrol_scan'
  | 'patrol_observation'
  | 'wake_check'
  | 'incident'
  | 'sos'
  | 'leave'
  | 'document'
  | 'location';

export type QueuedEvent = {
  client_event_uuid: string;
  capture_sequence_no: number;
  type: EventType;
  guardId: string;
  device_time: string; // ISO, device clock at capture
  monotonic_ms: number; // uptime clock at capture — unaffected by clock changes
  process_id: string; // identifies the app process, to detect a broken monotonic chain
  payload: Record<string, any>;
  sig: string; // keystore-key signature over the event core (SUR-GAP-028)
  status: 'pending' | 'sent' | 'failed_permanent';
  attempts: number;
  lastError?: string;
};

/**
 * `performance.now()` counts from *process* start, not device boot — React Native gives us no
 * access to `elapsedRealtime`. That is enough for the reconstruction in PRD 18.15.5 as long as
 * we are honest about when the chain breaks: if the app process restarted between capture and
 * flush the reading is meaningless, so we stamp each event with the process it was captured in
 * and let the server downgrade `time_confidence` when they differ.
 */
const PROCESS_ID = Crypto.randomUUID();

function monotonicNow(): number {
  return Math.round(globalThis.performance?.now?.() ?? 0);
}

/** P0 SOS → P1 attendance/wake → P2 patrol → P3 incident → P4 the rest (PRD 18.15.3). */
const PRIORITY: Record<EventType, number> = {
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

async function nextSeq(): Promise<number> {
  const cur = await store.getJSON<number>(KEYS.seqNo, 0);
  const next = cur + 1;
  await store.setJSON(KEYS.seqNo, next);
  return next;
}

export async function enqueue(
  guardId: string,
  type: EventType,
  payload: Record<string, any>
): Promise<QueuedEvent> {
  const q = await store.getJSON<QueuedEvent[]>(KEYS.eventQueue, []);
  const client_event_uuid = Crypto.randomUUID();
  const capture_sequence_no = await nextSeq();
  const device_time = new Date().toISOString();
  const monotonic_ms = monotonicNow();
  const sig = await signEvent(`${client_event_uuid}|${type}|${guardId}|${device_time}|${capture_sequence_no}`);

  const event: QueuedEvent = {
    client_event_uuid,
    capture_sequence_no,
    type,
    guardId,
    device_time,
    monotonic_ms,
    process_id: PROCESS_ID,
    payload,
    sig,
    status: 'pending',
    attempts: 0,
  };
  q.push(event);
  await store.setJSON(KEYS.eventQueue, q);
  return event;
}

export async function pending(): Promise<QueuedEvent[]> {
  const q = await store.getJSON<QueuedEvent[]>(KEYS.eventQueue, []);
  return q.filter((e) => e.status === 'pending');
}

export async function pendingCount(): Promise<number> {
  return (await pending()).length;
}

/** Events the server refused outright — surfaced to the guard, never dropped (PRD 18.15.3). */
export async function failedEvents(): Promise<QueuedEvent[]> {
  const q = await store.getJSON<QueuedEvent[]>(KEYS.eventQueue, []);
  return q.filter((e) => e.status === 'failed_permanent');
}

export async function lastSyncAt(): Promise<number> {
  return store.getJSON<number>(KEYS.lastSyncAt, 0);
}

const BATCH_SIZE = 50; // PRD 18.15.3: up to 50 events per request

let flushing = false;

/**
 * Flush the outbox, then the media that trails it.
 *
 * Metadata first is deliberate (PRD 18.15.3): the Command Center sees that a check-in happened
 * before the selfie proving it finishes uploading over 2G. The server binds the two together by
 * `client_event_uuid` when the bytes land.
 */
export async function flush(guardId: string): Promise<{ sent: number; remaining: number; failed: number }> {
  if (flushing) {
    return { sent: 0, remaining: await pendingCount(), failed: (await failedEvents()).length };
  }
  flushing = true;
  try {
    const q = await store.getJSON<QueuedEvent[]>(KEYS.eventQueue, []);
    const toSend = q
      .filter((e) => e.status === 'pending')
      .sort((a, b) => PRIORITY[a.type] - PRIORITY[b.type] || a.capture_sequence_no - b.capture_sequence_no)
      .slice(0, BATCH_SIZE);

    if (toSend.length === 0) {
      await flushMedia().catch(() => undefined);
      return { sent: 0, remaining: 0, failed: q.filter((e) => e.status === 'failed_permanent').length };
    }

    let res: Awaited<ReturnType<typeof api.sync>>;
    try {
      res = await api.sync(guardId, toSend, { process_id: PROCESS_ID, monotonic_now_ms: monotonicNow() });
    } catch {
      // Still no network. Bump attempts and leave everything pending — the retry cadence is
      // driven by connectivity and foreground events, not by a timer in here.
      for (const e of toSend) e.attempts += 1;
      await store.setJSON(KEYS.eventQueue, q);
      return { sent: 0, remaining: toSend.length, failed: q.filter((e) => e.status === 'failed_permanent').length };
    }

    const byUuid = new Map((res.results ?? []).map((r) => [r.uuid, r]));
    const acceptedSet = new Set(res.accepted ?? []);

    for (const e of q) {
      const result = byUuid.get(e.client_event_uuid);
      if (result && result.ok === false && result.retry) {
        // Temporarily refused (an observation whose scan has not landed yet): try again later.
        e.attempts += 1;
        e.lastError = result.error ?? 'retry';
      } else if (result && result.ok === false) {
        // A 4xx-shaped refusal means this event will never be accepted. Mark it so the guard
        // can be told, rather than retrying it forever behind everything else.
        e.status = 'failed_permanent';
        e.lastError = result.error ?? 'rejected by server';
      } else if (acceptedSet.has(e.client_event_uuid)) {
        e.status = 'sent';
      }
    }

    // Keep pending + failed, plus a short tail of sent events for the App health view.
    const keep = q.filter((e) => e.status !== 'sent').concat(q.filter((e) => e.status === 'sent').slice(-20));
    await store.setJSON(KEYS.eventQueue, keep);
    await store.setJSON(KEYS.lastSyncAt, Date.now());

    // Evidence follows its metadata.
    await flushMedia().catch(() => undefined);

    return {
      sent: acceptedSet.size,
      remaining: keep.filter((e) => e.status === 'pending').length,
      failed: keep.filter((e) => e.status === 'failed_permanent').length,
    };
  } finally {
    flushing = false;
  }
}

/** Drop the events the server permanently refused, once the guard has been told about them. */
export async function clearFailed(): Promise<void> {
  const q = await store.getJSON<QueuedEvent[]>(KEYS.eventQueue, []);
  await store.setJSON(
    KEYS.eventQueue,
    q.filter((e) => e.status !== 'failed_permanent')
  );
}

export { PROCESS_ID };
