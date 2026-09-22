import { GuardAppProfile } from '@/lib/models/GuardAppProfile';
import { GuardAttendance } from '@/lib/models/GuardAttendance';
import { compareFaces } from '@/lib/guardFace';
import { readOwnMedia } from '@/lib/guardMediaStore';

/**
 * Compare a check-in selfie against the guard's enrolment and band the result (PRD 18.5 §8).
 *
 * Runs from whichever arrives second — the selfie upload or the attendance record — because on a
 * good connection the upload usually lands first.
 *
 * Every outcome is recorded; none of them rejects the attendance. A `match` lifts nothing (the
 * event was already scored on its other signals); `review` and `mismatch` add a flag and pull the
 * confidence down so the event surfaces in the supervisor's queue; `unavailable` does the same
 * with a reason that makes clear it was the system, not the guard, that fell short.
 */
export async function verifyFaceForEvent(guardId: string, clientEventUuid: string, captured: Buffer) {
  const attendance: any = await GuardAttendance.findOne({ clientEventUuid }).lean();
  if (!attendance) return; // not a check-in selfie, or its record has not arrived yet
  if (attendance.livenessResult) return; // already scored

  const profile: any = await GuardAppProfile.findOne({ guardId }).lean();
  const enrolledId: string = profile?.faceEnrolMediaId ?? '';
  const enrolled = enrolledId ? await readOwnMedia(enrolledId, guardId) : null;

  const result = await compareFaces({ enrolledImage: enrolled, capturedImage: captured });

  const flags: string[] = [];
  let confidence: 'high' | 'low' | 'review' | null = null;

  if (result.band === 'review') {
    flags.push('face_low_score');
    confidence = 'low';
  } else if (result.band === 'mismatch') {
    flags.push('face_mismatch');
    confidence = 'review';
  } else if (result.band === 'unavailable') {
    flags.push(result.reason === 'no_enrolment' ? 'face_not_enrolled' : 'face_check_unavailable');
    confidence = 'low';
  }

  await GuardAttendance.updateOne(
    { clientEventUuid },
    {
      $set: {
        faceMatchScore: result.score ?? undefined,
        livenessResult: result.band,
        'meta.faceProvider': result.provider,
        ...(result.reason ? { 'meta.faceReason': result.reason } : {}),
        // Only ever lower the confidence — a good face score does not excuse a mock location.
        ...(confidence && attendance.confidence === 'high' ? { confidence } : {}),
      },
      ...(flags.length ? { $addToSet: { reviewFlags: { $each: flags } } } : {}),
    }
  ).catch(() => {});

  // Repeated low scores mean the face has changed, not that the guard is an impostor. Suggest
  // re-enrolment rather than flagging them every single shift (PRD 18.5 §16).
  if (result.band === 'mismatch' || result.band === 'review') {
    const next = (profile?.consecutiveLowFaceScores ?? 0) + 1;
    await GuardAppProfile.updateOne(
      { guardId },
      { $set: { consecutiveLowFaceScores: next, ...(next >= 3 ? { reEnrolmentSuggested: true } : {}) } },
      { upsert: true }
    ).catch(() => {});
  } else if (result.band === 'match') {
    await GuardAppProfile.updateOne(
      { guardId },
      { $set: { consecutiveLowFaceScores: 0, reEnrolmentSuggested: false } }
    ).catch(() => {});
  }
}
