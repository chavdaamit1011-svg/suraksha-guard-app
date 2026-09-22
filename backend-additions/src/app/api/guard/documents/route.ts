import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/db';
import { GuardAppProfile } from '@/lib/models/GuardAppProfile';
import { GuardMedia } from '@/lib/models/GuardMedia';
import { effectiveStatus, recordDocument } from '@/lib/guardDocuments';

export const dynamic = 'force-dynamic';

/**
 * Guard documents (PRD 18.11, SUR-GAP-004 / 020).
 *
 *   GET  ?guardId=   every document with its effective status (Expiring / Expired computed now)
 *   POST { guardId, kind, clientEventUuid, mediaId?, number?, expiresOn?, blurSuspected? }
 *
 * The offline path is `/api/guard/sync` (event type `document`), sharing `recordDocument`.
 */
export async function GET(req: Request) {
  const guardId = new URL(req.url).searchParams.get('guardId');
  if (!guardId) return NextResponse.json({ success: false, message: 'guardId required' }, { status: 400 });
  await connectToDatabase();
  const profile: any = await GuardAppProfile.findOne({ guardId });
  const docs: any[] = profile?.documents ?? [];

  // Late-arriving scans: attach any upload that now exists for a record still missing one.
  let changed = false;
  for (const d of docs) {
    if (!d.mediaId && d.clientEventUuid) {
      const m: any = await GuardMedia.findOne({ guardId, clientEventUuid: d.clientEventUuid }).select('mediaId').lean();
      if (m) {
        d.mediaId = m.mediaId;
        changed = true;
      }
    }
  }
  if (changed) await profile.save();

  return NextResponse.json({
    success: true,
    documents: docs.map((d) => ({
      kind: d.kind,
      status: effectiveStatus(d),
      number: d.number,
      expiresOn: d.expiresOn ?? null,
      uploadedAt: d.uploadedAt,
      hasImage: !!d.mediaId,
      awaitingUpload: !d.mediaId && !!d.clientEventUuid,
      reviewNote: d.reviewNote ?? '',
    })),
  });
}

export async function POST(req: Request) {
  try {
    const b = await req.json();
    await connectToDatabase();
    const r = await recordDocument(b);
    if (!r.ok) return NextResponse.json({ success: false, message: r.message }, { status: r.httpStatus });
    return NextResponse.json({ success: true, status: r.status, number: r.number, duplicate: r.duplicate });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'upload failed' }, { status: 500 });
  }
}
