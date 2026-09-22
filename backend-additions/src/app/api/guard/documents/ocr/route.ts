import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/db';
import { DOC_KINDS, extractFields, ocrConfigured, ocrImage } from '@/lib/guardDocuments';
import { readOwnMedia } from '@/lib/guardMediaStore';

export const dynamic = 'force-dynamic';

/**
 * Optional OCR pre-fill for a document scan (PRD 18.11 / SUR-GAP-004).
 *
 *   POST { guardId, kind, mediaId } → { available, suggestion: { number?, expiresOn? } }
 *
 * Returns suggestions only; the raw OCR text is never returned or stored, because an Aadhaar
 * scan's text contains the full number.
 */
export async function POST(req: Request) {
  try {
    const b = await req.json();
    if (!b.guardId || !b.mediaId || !DOC_KINDS.includes(b.kind)) {
      return NextResponse.json({ success: false, message: 'guardId, kind and mediaId required' }, { status: 400 });
    }
    if (!ocrConfigured()) return NextResponse.json({ success: true, available: false, suggestion: {} });

    await connectToDatabase();
    const bytes = await readOwnMedia(String(b.mediaId), String(b.guardId));
    if (!bytes) return NextResponse.json({ success: false, message: 'not found' }, { status: 404 });

    const result = await ocrImage(bytes).catch(() => null);
    if (!result) return NextResponse.json({ success: true, available: false, suggestion: {} });

    return NextResponse.json({ success: true, available: true, provider: result.provider, suggestion: extractFields(b.kind, result.text) });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'ocr failed' }, { status: 500 });
  }
}
