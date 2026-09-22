import { NextResponse } from 'next/server';
import { writeFile, mkdir, readFile } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { connectToDatabase } from '@/lib/db';
import { GuardMedia } from '@/lib/models/GuardMedia';
import { GuardAttendance } from '@/lib/models/GuardAttendance';
import { GuardFieldEvent } from '@/lib/models/GuardFieldEvent';
import { verifyFaceForEvent } from '@/lib/guardFaceVerify';
import { isAdminRequest, verifyLink } from '@/lib/guardSign';
import { SUBJECT_HEADER, sessionRequired } from '@/lib/guardSession';
import { mediaRoot } from '@/lib/guardMediaStore';
import { attachMediaToIncident } from '@/lib/guardIncident';

export const dynamic = 'force-dynamic';

/**
 * Guard App media upload (PRD 18.5 §7, 18.10, 18.15.3).
 *
 * Attendance selfies, incident photos/video, voice notes and document scans arrive here and are
 * stored as real files with a server-issued `mediaId`; field events then reference the id. Media
 * trails its parent metadata in the sync queue (18.15.3: "an operator sees the event before the
 * evidence"), so an upload always names the `clientEventUuid` it belongs to.
 *
 * Files land OUTSIDE `public/` — selfies and incident media are personal data and must not be
 * served by the static file server (PRD 18.5 §14, §39). GET below re-serves them with an
 * ownership check.
 *
 * Accepts multipart/form-data (`file`) or JSON `{ base64, mime }`, because the offline queue
 * flushes from a React Native client where base64 is the reliable path.
 */

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB hard cap; the app compresses well below this

const KINDS = new Set([
  'selfie',
  'wake_selfie',
  'incident_photo',
  'incident_video',
  'voice',
  'document',
  'sos_photo',
]);

const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'audio/m4a': '.m4a',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/opus': '.ogg',
  'audio/webm': '.webm',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/3gpp': '.3gp',
};

/** Reject a renamed executable regardless of the declared mime (same posture as upload-license). */
function sniff(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  const hex4 = buf.subarray(0, 4).toString('hex').toLowerCase();
  const brand = buf.subarray(4, 8).toString('latin1');

  if (hex4.startsWith('ffd8ff')) return '.jpg';
  if (hex4 === '89504e47') return '.png';
  if (hex4 === '1a45dfa3') return '.webm'; // Matroska/WebM
  if (buf.subarray(0, 4).toString('latin1') === 'OggS') return '.ogg';
  if (hex4 === '49443303' || hex4.startsWith('fffb')) return '.mp3';
  if (brand === 'ftyp') {
    const sub = buf.subarray(8, 12).toString('latin1');
    if (sub.startsWith('3gp')) return '.3gp';
    if (sub === 'M4A ' || sub === 'M4A\0') return '.m4a';
    return '.mp4'; // isom / mp42 / qt — covers expo-audio and expo-camera video
  }
  return null;
}


export async function POST(req: Request) {
  try {
    const contentType = (req.headers.get('content-type') ?? '').toLowerCase();

    let guardId = '';
    let kind = '';
    let clientEventUuid = '';
    let bookingId = '';
    let rosterId = '';
    let deviceTime = '';
    let declaredMime = '';
    let buffer: Buffer | null = null;

    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      guardId = String(form.get('guardId') ?? '');
      kind = String(form.get('kind') ?? '');
      clientEventUuid = String(form.get('clientEventUuid') ?? '');
      bookingId = String(form.get('bookingId') ?? '');
      rosterId = String(form.get('rosterId') ?? '');
      deviceTime = String(form.get('deviceTime') ?? '');
      const file = form.get('file') as File | null;
      if (file) {
        declaredMime = (file.type || '').toLowerCase();
        if (file.size > MAX_BYTES) {
          return NextResponse.json({ success: false, message: 'File too large' }, { status: 413 });
        }
        buffer = Buffer.from(await file.arrayBuffer());
      }
    } else {
      const b = await req.json();
      guardId = String(b.guardId ?? '');
      kind = String(b.kind ?? '');
      clientEventUuid = String(b.clientEventUuid ?? '');
      bookingId = String(b.bookingId ?? '');
      rosterId = String(b.rosterId ?? '');
      deviceTime = String(b.deviceTime ?? '');
      declaredMime = String(b.mime ?? '').toLowerCase();
      const base64: string = String(b.base64 ?? '').replace(/^data:[^;]+;base64,/, '');
      if (base64) {
        // 4 base64 chars ≈ 3 bytes — reject before allocating.
        if (base64.length * 0.75 > MAX_BYTES) {
          return NextResponse.json({ success: false, message: 'File too large' }, { status: 413 });
        }
        buffer = Buffer.from(base64, 'base64');
      }
    }

    if (!guardId) return NextResponse.json({ success: false, message: 'guardId required' }, { status: 400 });
    // The proxy cannot read a multipart body, so the owner check for form uploads happens here.
    const subject = req.headers.get(SUBJECT_HEADER);
    if (subject && subject !== guardId) {
      return NextResponse.json({ success: false, code: 'session_mismatch', message: 'forbidden' }, { status: 403 });
    }
    if (!subject && sessionRequired() && contentType.includes('multipart/form-data')) {
      return NextResponse.json({ success: false, code: 'session_required', message: 'Please sign in again.' }, { status: 401 });
    }
    if (!KINDS.has(kind)) return NextResponse.json({ success: false, message: 'unknown media kind' }, { status: 400 });
    if (!buffer || buffer.length === 0) {
      return NextResponse.json({ success: false, message: 'no file content' }, { status: 400 });
    }
    if (buffer.length > MAX_BYTES) {
      return NextResponse.json({ success: false, message: 'File too large' }, { status: 413 });
    }

    const sniffed = sniff(buffer);
    if (!sniffed) {
      return NextResponse.json(
        { success: false, message: 'Unsupported or unrecognised media format' },
        { status: 400 }
      );
    }
    // The declared mime only picks the stored extension when it agrees with the bytes.
    const ext = MIME_EXT[declaredMime] === sniffed ? sniffed : sniffed;
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

    await connectToDatabase();

    // Reused-media detection (PRD 18.6): the same bytes submitted twice is a replay signal.
    // We keep the original file and hand back its id rather than storing a second copy.
    const existing: any = await GuardMedia.findOne({ guardId, sha256 }).lean().catch(() => null);
    if (existing) {
      return NextResponse.json({
        success: true,
        mediaId: existing.mediaId,
        url: `/api/guard/media?mediaId=${existing.mediaId}&guardId=${encodeURIComponent(guardId)}`,
        sha256,
        bytes: existing.bytes,
        reused: true,
      });
    }

    const mediaId = crypto.randomBytes(16).toString('hex');
    // guardId is a Mongo ObjectId hex string, but sanitise anyway — this becomes a path segment.
    const safeGuardDir = guardId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'unknown';
    const relPath = path.posix.join(safeGuardDir, `${mediaId}${ext}`);
    const absDir = path.join(mediaRoot(), safeGuardDir);
    await mkdir(absDir, { recursive: true });
    await writeFile(path.join(mediaRoot(), relPath), buffer);

    await GuardMedia.create({
      mediaId,
      guardId,
      kind,
      mime: declaredMime || '',
      ext,
      bytes: buffer.length,
      relPath,
      sha256,
      clientEventUuid,
      bookingId,
      rosterId,
      deviceTime: deviceTime ? new Date(deviceTime) : undefined,
    });

    // Media trails its parent metadata through the offline queue (PRD 18.15.3), so the event row
    // usually already exists by the time the bytes arrive — back-fill the reference onto it here.
    if (clientEventUuid) await attachToEvent(clientEventUuid, kind, mediaId, sha256);

    // A check-in selfie is also the moment face verification can finally run: both images now
    // exist on the server. Deliberately not awaited — PRD 18.5 §10 has face verification happen
    // "asynchronously if the media arrives later", and an upload must never wait on a provider.
    if (kind === 'selfie' && clientEventUuid) {
      verifyFaceForEvent(guardId, clientEventUuid, buffer).catch(() => {});
    }

    return NextResponse.json({
      success: true,
      mediaId,
      url: `/api/guard/media?mediaId=${mediaId}&guardId=${encodeURIComponent(guardId)}`,
      sha256,
      bytes: buffer.length,
      reused: false,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'upload failed' }, { status: 500 });
  }
}

/**
 * Point the already-ingested field event at this media. A selfie also carries the bytes' hash
 * onto the attendance record, which is what reused-media detection reads (PRD 18.6).
 */
async function attachToEvent(clientEventUuid: string, kind: string, mediaId: string, sha256: string) {
  try {
    if (kind === 'selfie') {
      await GuardAttendance.updateOne(
        { clientEventUuid },
        {
          $set: { selfieMediaId: mediaId, ...(sha256 ? { photoHash: sha256 } : {}) },
          // The record arrived first and was flagged for missing evidence; the evidence is here now.
          $pull: { reviewFlags: 'no_selfie_media' },
        }
      );
      return;
    }
    await GuardFieldEvent.updateOne({ clientEventUuid }, { $addToSet: { mediaIds: mediaId } });
    // Incident photos, videos and voice notes belong to the Incident record, not a field event.
    if (kind === 'incident_photo' || kind === 'incident_video' || kind === 'voice') {
      await attachMediaToIncident(clientEventUuid, mediaId);
    }
  } catch {
    // A media upload must never fail because its parent event has not landed yet — the
    // GuardMedia row still carries clientEventUuid, so the link is recoverable either way.
  }
}

const CONTENT_TYPE: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.3gp': 'video/3gpp',
};

/** Re-serve media with an ownership check — never via the public static path (PRD 18.5 §14). */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const mediaId = searchParams.get('mediaId') ?? '';
    const guardId = searchParams.get('guardId') ?? '';
    if (!mediaId) return NextResponse.json({ success: false, message: 'mediaId required' }, { status: 400 });

    await connectToDatabase();
    const doc: any = await GuardMedia.findOne({ mediaId }).lean();
    if (!doc || doc.purgedAt) {
      return NextResponse.json({ success: false, message: 'not found' }, { status: 404 });
    }
    // Three ways in: the owning guard, a signed link (e.g. a voice note opened from a support
    // ticket), or the admin key. Omitting guardId used to skip the check entirely.
    const signed = verifyLink('media', mediaId, searchParams.get('e'), searchParams.get('s'));
    const owner = !!guardId && String(doc.guardId) === guardId;
    if (!owner && !signed && !isAdminRequest(req)) {
      return NextResponse.json({ success: false, message: 'forbidden' }, { status: 403 });
    }

    const abs = path.join(mediaRoot(), doc.relPath);
    if (!abs.startsWith(mediaRoot())) {
      return NextResponse.json({ success: false, message: 'forbidden' }, { status: 403 });
    }
    const bytes = await readFile(abs);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Content-Type': CONTENT_TYPE[doc.ext] ?? 'application/octet-stream',
        'Content-Length': String(bytes.length),
        'Cache-Control': 'private, max-age=86400',
      },
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'read failed' }, { status: 500 });
  }
}
