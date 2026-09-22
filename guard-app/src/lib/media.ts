import { File, UploadType } from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import { API_BASE_URL } from '@/config';
import { authHeader, ensureFreshSession, handleUnauthorized } from '@/lib/session';
import { KEYS, store } from './storage';

/**
 * Media outbox (PRD 18.5 §7, 18.10, 18.15.3).
 *
 * Duty evidence — the check-in selfie, an incident photo or voice note, a wake-check selfie — is
 * a real file that has to reach the server. Previously the app queued the device-local `file://`
 * URI and the server stored that string, so the evidence never existed anywhere but the phone.
 *
 * The design follows 18.15.3: **media trails its parent metadata**. The field event is queued and
 * flushed first, carrying only a local media reference; the bytes upload afterwards tagged with
 * the same `client_event_uuid`, and the server binds them to the event on arrival. An operator
 * therefore sees the event immediately and the photo shortly after, rather than waiting for a
 * 400 KB upload over 2G before learning that anything happened at all.
 *
 * The one exception is the fast path: when a network is available at capture time we upload
 * straight away, so the common case has the evidence in place before the guard leaves the screen.
 */

export type MediaKind =
  | 'selfie'
  | 'wake_selfie'
  | 'incident_photo'
  | 'incident_video'
  | 'voice'
  | 'document'
  | 'sos_photo';

export type PendingMedia = {
  localId: string;
  uri: string;
  kind: MediaKind;
  clientEventUuid: string;
  guardId: string;
  rosterId?: string;
  bookingId?: string;
  deviceTime: string;
  attempts: number;
  /** Set once uploaded; the row is kept briefly so App health can show what landed. */
  mediaId?: string;
};

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  '3gp': 'video/3gpp',
  webm: 'video/webm',
  ogg: 'audio/ogg',
  caf: 'audio/mp4',
};

function mimeFor(uri: string, kind: MediaKind): string {
  const ext = (uri.split('?')[0].split('.').pop() ?? '').toLowerCase();
  if (MIME[ext]) return MIME[ext];
  return kind === 'voice' ? 'audio/mp4' : kind === 'incident_video' ? 'video/mp4' : 'image/jpeg';
}

/** Register a captured file for upload and return its local handle. */
export async function enqueueMedia(args: {
  guardId: string;
  uri: string;
  kind: MediaKind;
  clientEventUuid: string;
  rosterId?: string;
  bookingId?: string;
}): Promise<PendingMedia> {
  const row: PendingMedia = {
    localId: Crypto.randomUUID(),
    uri: args.uri,
    kind: args.kind,
    clientEventUuid: args.clientEventUuid,
    guardId: args.guardId,
    rosterId: args.rosterId,
    bookingId: args.bookingId,
    deviceTime: new Date().toISOString(),
    attempts: 0,
  };
  const q = await store.getJSON<PendingMedia[]>(KEYS.mediaQueue, []);
  q.push(row);
  await store.setJSON(KEYS.mediaQueue, q);
  return row;
}

/**
 * Upload a file straight away and wait for the id, bypassing the outbox.
 *
 * Used for the Emergency thumbnail (PRD 18.10 §10): a ~40 KB image sent before anything else so
 * the operator sees *something* within a second or two, rather than waiting on a 400 KB photo
 * over 2G. Returns null rather than throwing — a failed thumbnail must not stop the report.
 */
export async function uploadNow(args: {
  guardId: string;
  uri: string;
  kind: MediaKind;
  clientEventUuid: string;
  rosterId?: string;
}): Promise<string | null> {
  try {
    const mediaId = await uploadOne({
      localId: 'immediate',
      uri: args.uri,
      kind: args.kind,
      clientEventUuid: args.clientEventUuid,
      guardId: args.guardId,
      rosterId: args.rosterId,
      deviceTime: new Date().toISOString(),
      attempts: 0,
    });
    return mediaId || null;
  } catch {
    return null;
  }
}

/** SHA-256 of the file's bytes — the same hash the server computes, for tamper evidence. */
export async function hashFile(uri: string): Promise<string> {
  try {
    const f = new File(uri);
    const b64 = await f.base64();
    return await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, b64);
  } catch {
    return '';
  }
}

async function uploadOne(row: PendingMedia): Promise<string | null> {
  const file = new File(row.uri);
  if (!file.exists) return null; // the OS cleared the cache file — nothing to send

  const parameters: Record<string, string> = {
    guardId: row.guardId,
    kind: row.kind,
    clientEventUuid: row.clientEventUuid,
    deviceTime: row.deviceTime,
  };
  if (row.rosterId) parameters.rosterId = row.rosterId;
  if (row.bookingId) parameters.bookingId = row.bookingId;

  await ensureFreshSession();
  const send = () =>
    file.upload(`${API_BASE_URL}/api/guard/media`, {
      httpMethod: 'POST',
      uploadType: UploadType.MULTIPART,
      fieldName: 'file',
      mimeType: mimeFor(row.uri, row.kind),
      parameters,
      headers: authHeader(),
    });

  let res = await send();
  if (res.status === 401) {
    // A lapsed login is not the file's fault: renew and retry, or keep it queued until the guard
    // signs in again — never drop evidence over it.
    let code = '';
    try {
      code = res.body ? JSON.parse(res.body)?.code ?? '' : '';
    } catch {
      /* not JSON */
    }
    if (await handleUnauthorized(code)) res = await send();
    if (res.status === 401) throw new Error('not signed in');
  }

  if (res.status < 200 || res.status >= 300) {
    // 4xx means the server will never accept this file (wrong format, too large). Retrying
    // forever would pin the queue, so treat it as permanent and let it be dropped.
    if (res.status >= 400 && res.status < 500) return '';
    throw new Error(`upload failed (${res.status})`);
  }

  const body = res.body ? JSON.parse(res.body) : {};
  return body?.mediaId ?? '';
}

let uploading = false;

/**
 * Upload everything pending. Safe to call repeatedly and from several triggers (connectivity
 * regained, app foreground, after a queue flush) — a second call while one is in flight is a
 * no-op rather than a duplicate upload.
 */
export async function flushMedia(): Promise<{ uploaded: number; remaining: number }> {
  if (uploading) return { uploaded: 0, remaining: await pendingMediaCount() };
  uploading = true;
  try {
    const q = await store.getJSON<PendingMedia[]>(KEYS.mediaQueue, []);
    const todo = q.filter((m) => !m.mediaId);
    if (todo.length === 0) return { uploaded: 0, remaining: 0 };

    let uploaded = 0;
    for (const row of todo) {
      try {
        const mediaId = await uploadOne(row);
        if (mediaId === null) {
          row.mediaId = 'missing'; // file gone; stop trying
        } else if (mediaId === '') {
          row.mediaId = 'rejected'; // server refused permanently
        } else {
          row.mediaId = mediaId;
          uploaded += 1;
        }
      } catch {
        row.attempts += 1;
        // Give up after a long run of failures rather than growing the queue without bound.
        if (row.attempts > 25) row.mediaId = 'failed';
      }
    }

    // Keep a short tail of finished rows so App health can report what was sent, drop the rest.
    const done = q.filter((m) => m.mediaId);
    const still = q.filter((m) => !m.mediaId);
    await store.setJSON(KEYS.mediaQueue, [...still, ...done.slice(-20)]);
    return { uploaded, remaining: still.length };
  } finally {
    uploading = false;
  }
}

export async function pendingMediaCount(): Promise<number> {
  const q = await store.getJSON<PendingMedia[]>(KEYS.mediaQueue, []);
  return q.filter((m) => !m.mediaId).length;
}

/** Total bytes of media still waiting, for the App health storage line (PRD 18.15.3). */
export async function pendingMediaBytes(): Promise<number> {
  const q = await store.getJSON<PendingMedia[]>(KEYS.mediaQueue, []);
  let total = 0;
  for (const m of q) {
    if (m.mediaId) continue;
    try {
      total += new File(m.uri).size ?? 0;
    } catch {
      /* unreadable file contributes nothing */
    }
  }
  return total;
}

/**
 * Capture-time fast path: queue the file, then try to send it immediately. Returns the server
 * media id when the upload succeeded, or null when it is waiting in the outbox — the caller
 * records the event either way, because nothing blocks duty (PRD 18.17.1 rule 12).
 */
export async function captureMedia(args: {
  guardId: string;
  uri: string;
  kind: MediaKind;
  clientEventUuid: string;
  rosterId?: string;
  bookingId?: string;
}): Promise<string | null> {
  const row = await enqueueMedia(args);
  try {
    const mediaId = await uploadOne(row);
    if (mediaId) {
      const q = await store.getJSON<PendingMedia[]>(KEYS.mediaQueue, []);
      const hit = q.find((m) => m.localId === row.localId);
      if (hit) hit.mediaId = mediaId;
      await store.setJSON(KEYS.mediaQueue, q);
      return mediaId;
    }
  } catch {
    /* offline or flaky — it stays in the outbox and flushes later */
  }
  return null;
}
