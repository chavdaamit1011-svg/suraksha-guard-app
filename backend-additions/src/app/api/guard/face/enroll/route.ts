import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { connectToDatabase } from '@/lib/db';
import { GuardAppProfile } from '@/lib/models/GuardAppProfile';
import { GuardMedia } from '@/lib/models/GuardMedia';
import { faceProviderConfigured } from '@/lib/guardFace';

export const dynamic = 'force-dynamic';

/**
 * Selfie face enrolment (PRD 18.1 §5, SUR-GAP-003).
 *
 * The enrolment image is uploaded through `/api/guard/media` first (kind `selfie`) and this route
 * is given the resulting `mediaId`. That matters: the previous version stored the device's local
 * `file://` path, which meant the enrolment existed only on the phone and could never be compared
 * against anything.
 *
 * Re-enrolment is expected rather than exceptional — PRD 18.5 §16 calls for it when a guard's
 * face changes (beard, injury, bandage) and repeated low scores would otherwise keep flagging a
 * legitimate person. Each enrolment supersedes the last and the history is kept.
 */
export async function POST(req: Request) {
  try {
    const b = await req.json();
    const guardId: string = b.guardId ?? '';
    const mediaId: string = b.mediaId ?? '';
    // `imageUri` is the older field; still accepted so an un-updated app keeps working, but it
    // cannot be compared against and the response says so.
    const imageUri: string = b.imageUri ?? '';

    if (!guardId || (!mediaId && !imageUri)) {
      return NextResponse.json(
        { success: false, message: 'guardId and mediaId are required' },
        { status: 400 }
      );
    }

    await connectToDatabase();

    let usable = false;
    if (mediaId) {
      const media: any = await GuardMedia.findOne({ mediaId, guardId }).lean();
      if (!media) {
        return NextResponse.json({ success: false, message: 'media not found for this guard' }, { status: 404 });
      }
      usable = true;
    }

    const profile: any = await GuardAppProfile.findOneAndUpdate(
      { guardId },
      {
        $set: {
          faceEnrolledAt: new Date(),
          faceEnrolMediaId: mediaId,
          faceEnrolUri: imageUri,
          faceTemplateRef: `tmpl_${crypto.randomBytes(8).toString('hex')}`,
        },
        ...(mediaId
          ? { $push: { faceEnrolHistory: { mediaId, at: new Date(), reason: b.reason ?? 'enrolment' } } }
          : {}),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    return NextResponse.json({
      success: true,
      faceTemplateRef: profile.faceTemplateRef,
      /** false when only a legacy device path was supplied — nothing can be matched against it. */
      comparable: usable,
      /** false when no face provider is configured; check-ins will route to supervisor review. */
      verificationAvailable: faceProviderConfigured(),
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'enrol failed' }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const guardId = searchParams.get('guardId');
    if (!guardId) return NextResponse.json({ success: false, message: 'guardId required' }, { status: 400 });

    await connectToDatabase();
    const profile: any = await GuardAppProfile.findOne({ guardId }).lean();

    return NextResponse.json({
      success: true,
      enrolled: !!profile?.faceEnrolledAt,
      comparable: !!profile?.faceEnrolMediaId,
      faceTemplateRef: profile?.faceTemplateRef ?? '',
      enrolledAt: profile?.faceEnrolledAt ?? null,
      verificationAvailable: faceProviderConfigured(),
      /** Set by the ingest path when repeated low scores suggest the face has changed. */
      reEnrolmentSuggested: !!profile?.reEnrolmentSuggested,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'read failed' }, { status: 500 });
  }
}
