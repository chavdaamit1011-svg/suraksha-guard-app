import { GuardAppProfile } from '@/lib/models/GuardAppProfile';
import { GuardMedia } from '@/lib/models/GuardMedia';

/**
 * Document helpers (PRD 18.11, SUR-GAP-004 / 020).
 */

export const DOC_KINDS = ['aadhaar', 'pan', 'bank', 'psara', 'police'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

const EXPIRING_DAYS = 30;

/** Stored status, adjusted for expiry at read time so nothing needs a nightly job. */
export function effectiveStatus(d: { status?: string; expiresOn?: Date | string | null }, now = Date.now()): string {
  const status = d.status ?? 'Pending';
  if (status === 'Rejected' || !d.expiresOn) return status;
  const exp = new Date(d.expiresOn).getTime();
  if (Number.isNaN(exp)) return status;
  if (exp < now) return 'Expired';
  if (status === 'Verified' && exp - now < EXPIRING_DAYS * 24 * 3600_000) return 'Expiring';
  return status;
}

/** Aadhaar: never keep more than the last four digits. Other numbers are normalised. */
export function normaliseNumber(kind: string, raw: string): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (kind === 'aadhaar') {
    const digits = s.replace(/\D/g, '');
    return digits.length >= 4 ? `XXXX XXXX ${digits.slice(-4)}` : '';
  }
  if (kind === 'pan') return s.toUpperCase().replace(/\s/g, '').slice(0, 10);
  return s.slice(0, 40);
}

export type OcrSuggestion = { number?: string; expiresOn?: string; name?: string };

/** Pull the fields worth pre-filling out of OCR text. Suggestions only — the guard confirms. */
export function extractFields(kind: string, text: string): OcrSuggestion {
  const out: OcrSuggestion = {};
  const flat = text.replace(/\r/g, '');

  if (kind === 'aadhaar') {
    const m = flat.match(/\b(\d{4})\s?(\d{4})\s?(\d{4})\b/);
    if (m) out.number = normaliseNumber('aadhaar', m[0]); // masked before it leaves this function
  } else if (kind === 'pan') {
    const m = flat.toUpperCase().match(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/);
    if (m) out.number = m[0];
  } else if (kind === 'bank') {
    const acct = flat.match(/\b\d{9,18}\b/);
    if (acct) out.number = acct[0];
  } else {
    const lic = flat.toUpperCase().match(/\b[A-Z]{2,5}[-/ ]?\d{3,}[A-Z0-9/-]*\b/);
    if (lic) out.number = lic[0];
  }

  // Expiry: the latest dd/mm/yyyy (or dd-mm-yyyy) on the card that is in the future.
  const dates = [...flat.matchAll(/\b(\d{2})[/.-](\d{2})[/.-](\d{4})\b/g)]
    .map((m) => `${m[3]}-${m[2]}-${m[1]}`)
    .filter((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)))
    .sort();
  const future = dates.filter((d) => Date.parse(`${d}T00:00:00Z`) > Date.now());
  if (kind !== 'aadhaar' && kind !== 'pan' && future.length) out.expiresOn = future[future.length - 1];

  return out;
}

/**
 * Optional OCR through Google Cloud Vision. Unset `GOOGLE_VISION_API_KEY` means no OCR: the app
 * simply does not pre-fill, which the PRD marks as optional.
 */
export async function ocrImage(bytes: Buffer): Promise<{ provider: string; text: string } | null> {
  const key = process.env.GOOGLE_VISION_API_KEY;
  if (!key) return null;
  const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{ image: { content: bytes.toString('base64') }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }] }],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const j: any = await res.json();
  return { provider: 'google_vision', text: j?.responses?.[0]?.fullTextAnnotation?.text ?? '' };
}

export function ocrConfigured(): boolean {
  return !!process.env.GOOGLE_VISION_API_KEY;
}

export type RecordDocumentInput = {
  guardId: string;
  kind: string;
  clientEventUuid?: string;
  mediaId?: string;
  number?: string;
  expiresOn?: string;
  blurSuspected?: boolean;
};

export type RecordDocumentResult =
  | { ok: true; status: 'Pending'; number: string; duplicate: boolean }
  | { ok: false; httpStatus: number; message: string };

/**
 * Record a document scan, shared by the online route and the offline sync. The scan itself
 * travels through the media queue under the same `clientEventUuid` and is linked on read.
 */
export async function recordDocument(b: RecordDocumentInput): Promise<RecordDocumentResult> {
  const { guardId, kind } = b;
  if (!guardId || !DOC_KINDS.includes(kind as DocKind)) {
    return { ok: false, httpStatus: 400, message: 'guardId and a valid kind are required' };
  }
  if (!b.mediaId && !b.clientEventUuid) {
    return { ok: false, httpStatus: 400, message: 'mediaId or clientEventUuid required' };
  }
  let expiresOn: Date | undefined;
  if (b.expiresOn) {
    expiresOn = new Date(`${String(b.expiresOn).slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(expiresOn.getTime())) return { ok: false, httpStatus: 422, message: 'expiresOn must be YYYY-MM-DD' };
  }

  let mediaId = '';
  if (b.mediaId) {
    // Only the guard's own upload can back their document.
    const m = await GuardMedia.exists({ mediaId: b.mediaId, guardId });
    if (!m) return { ok: false, httpStatus: 422, message: 'unknown mediaId' };
    mediaId = String(b.mediaId);
  }

  let profile = await GuardAppProfile.findOne({ guardId });
  if (!profile) profile = await GuardAppProfile.create({ guardId });

  const existing = profile.documents.find((d: any) => d.kind === kind);
  // A re-sent scan (the online call succeeded, then the outbox copy arrived) changes nothing.
  if (existing && b.clientEventUuid && existing.clientEventUuid === b.clientEventUuid) {
    return { ok: true, status: 'Pending', number: existing.number, duplicate: true };
  }

  const patch = {
    kind,
    // A new scan always goes back to review, even replacing a verified one.
    status: 'Pending' as const,
    number: b.number ? normaliseNumber(kind, b.number) : (existing?.number ?? ''),
    imageUri: '',
    mediaId,
    clientEventUuid: String(b.clientEventUuid ?? ''),
    blurSuspected: !!b.blurSuspected,
    reviewNote: '',
    expiresOn: expiresOn ?? existing?.expiresOn,
    uploadedAt: new Date(),
  };
  if (existing) Object.assign(existing, patch);
  else profile.documents.push(patch);
  await profile.save();

  try {
    (globalThis as any).__io?.emit?.('new-notification', {
      kind: 'GUARD_DOCUMENT_UPLOADED',
      audience: ['agency'],
      guardId,
      documentKind: kind,
      blurSuspected: !!b.blurSuspected,
      at: new Date().toISOString(),
    });
  } catch {
    /* ignore */
  }
  return { ok: true, status: 'Pending', number: patch.number, duplicate: false };
}
