import crypto from 'crypto';

/**
 * Face verification for attendance (PRD 18.5 §8, 18.1 §5, SUR-GAP-003/011).
 *
 * The rule that shapes everything here is PRD 18.5 §8:
 *
 *   > **A failed verification never blocks the guard from marking duty** — it downgrades the
 *   > record's confidence and raises a review task. Blocking a guard from working is a worse
 *   > outcome than a low-confidence record.
 *
 * So this returns a *band*, never a veto:
 *
 *   score ≥ T_high            → `match`        auto-accept
 *   T_low ≤ score < T_high    → `review`       accepted, flagged for a supervisor
 *   score < T_low             → `mismatch`     accepted, flagged, re-enrolment suggested
 *   no provider / no template → `unavailable`  accepted, routed to supervisor verification
 *
 * `unavailable` is a first-class outcome, not a failure: an agency with no face provider
 * configured still gets working attendance, with the same supervisor-verification fallback the
 * PRD already specifies for a guard whose face has changed (18.5 §16).
 *
 * Thresholds live server-side and are never sent to the client (18.6 §14).
 */

export type FaceBand = 'match' | 'review' | 'mismatch' | 'unavailable';

export type FaceResult = {
  band: FaceBand;
  /** 0–100. Null when no comparison could be made. */
  score: number | null;
  provider: string;
  /** Why a comparison could not be made, for the supervisor's context. */
  reason?: string;
};

/** Defaults chosen to be forgiving: a false "review" costs a supervisor tap, a false "match" costs trust. */
function thresholds() {
  const high = Number(process.env.GUARD_FACE_T_HIGH ?? 82);
  const low = Number(process.env.GUARD_FACE_T_LOW ?? 62);
  return {
    high: Number.isFinite(high) ? high : 82,
    low: Number.isFinite(low) ? low : 62,
  };
}

export function bandFor(score: number): FaceBand {
  const { high, low } = thresholds();
  if (score >= high) return 'match';
  if (score >= low) return 'review';
  return 'mismatch';
}

/**
 * Compare a captured selfie against the guard's enrolment image.
 *
 * Providers are selected by which credentials are present, mirroring how `guardSms.ts` picks an
 * SMS gateway — adding face matching is then a matter of adding a key, not editing code.
 */
export async function compareFaces(args: {
  enrolledImage: Buffer | null;
  capturedImage: Buffer | null;
}): Promise<FaceResult> {
  if (!args.enrolledImage) {
    return { band: 'unavailable', score: null, provider: 'none', reason: 'no_enrolment' };
  }
  if (!args.capturedImage) {
    return { band: 'unavailable', score: null, provider: 'none', reason: 'no_capture' };
  }

  try {
    if (process.env.AWS_REKOGNITION_REGION && process.env.AWS_ACCESS_KEY_ID) {
      return await compareWithRekognition(args.enrolledImage, args.capturedImage);
    }
    if (process.env.FACEPP_API_KEY && process.env.FACEPP_API_SECRET) {
      return await compareWithFacePlusPlus(args.enrolledImage, args.capturedImage);
    }
    if (process.env.AZURE_FACE_ENDPOINT && process.env.AZURE_FACE_KEY) {
      return await compareWithAzure(args.enrolledImage, args.capturedImage);
    }
  } catch (e: any) {
    // A provider outage must not stop attendance. Degrade to supervisor verification.
    return { band: 'unavailable', score: null, provider: 'error', reason: e?.message ?? 'provider_error' };
  }

  return { band: 'unavailable', score: null, provider: 'none', reason: 'no_provider_configured' };
}

/**
 * AWS Rekognition CompareFaces. Signed with SigV4 by hand so no SDK dependency is added to the
 * production app — the request is small and the signing is well-defined.
 */
async function compareWithRekognition(enrolled: Buffer, captured: Buffer): Promise<FaceResult> {
  const region = process.env.AWS_REKOGNITION_REGION!;
  const accessKey = process.env.AWS_ACCESS_KEY_ID!;
  const secretKey = process.env.AWS_SECRET_ACCESS_KEY!;
  const host = `rekognition.${region}.amazonaws.com`;
  const target = 'RekognitionService.CompareFaces';

  const body = JSON.stringify({
    SourceImage: { Bytes: enrolled.toString('base64') },
    TargetImage: { Bytes: captured.toString('base64') },
    // Ask for everything above the low threshold so the middle band is visible to us rather
    // than silently dropped by the provider.
    SimilarityThreshold: Math.max(0, thresholds().low - 10),
  });

  const headers = await signAwsRequest({ region, service: 'rekognition', host, target, body, accessKey, secretKey });

  const res = await fetch(`https://${host}/`, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`rekognition http ${res.status}`);
  const json: any = await res.json();

  const best = (json.FaceMatches ?? [])[0];
  if (!best) {
    // Rekognition returns no match at all below the threshold, and also when it found no face.
    const noFace = (json.UnmatchedFaces ?? []).length === 0;
    return noFace
      ? { band: 'unavailable', score: null, provider: 'rekognition', reason: 'no_face_detected' }
      : { band: 'mismatch', score: 0, provider: 'rekognition' };
  }

  const score = Math.round(best.Similarity);
  return { band: bandFor(score), score, provider: 'rekognition' };
}

/** Face++ Compare — widely used in India and cheap at this volume. */
async function compareWithFacePlusPlus(enrolled: Buffer, captured: Buffer): Promise<FaceResult> {
  const form = new FormData();
  form.append('api_key', process.env.FACEPP_API_KEY!);
  form.append('api_secret', process.env.FACEPP_API_SECRET!);
  form.append('image_base64_1', enrolled.toString('base64'));
  form.append('image_base64_2', captured.toString('base64'));

  const res = await fetch('https://api-us.faceplusplus.com/facepp/v3/compare', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`facepp http ${res.status}`);
  const json: any = await res.json();

  if (json.error_message) {
    if (String(json.error_message).includes('NO_FACE')) {
      return { band: 'unavailable', score: null, provider: 'facepp', reason: 'no_face_detected' };
    }
    throw new Error(json.error_message);
  }

  const score = Math.round(json.confidence ?? 0);
  return { band: bandFor(score), score, provider: 'facepp' };
}

/** Azure Face verify — two detect calls then a verify, since it works on face ids. */
async function compareWithAzure(enrolled: Buffer, captured: Buffer): Promise<FaceResult> {
  const endpoint = String(process.env.AZURE_FACE_ENDPOINT).replace(/\/$/, '');
  const key = process.env.AZURE_FACE_KEY!;
  const detect = async (img: Buffer): Promise<string | null> => {
    const res = await fetch(`${endpoint}/face/v1.0/detect?returnFaceId=true&detectionModel=detection_03`, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(img),
    });
    if (!res.ok) throw new Error(`azure detect http ${res.status}`);
    const faces: any[] = await res.json();
    return faces[0]?.faceId ?? null;
  };

  const [a, b] = await Promise.all([detect(enrolled), detect(captured)]);
  if (!a || !b) return { band: 'unavailable', score: null, provider: 'azure', reason: 'no_face_detected' };

  const res = await fetch(`${endpoint}/face/v1.0/verify`, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ faceId1: a, faceId2: b }),
  });
  if (!res.ok) throw new Error(`azure verify http ${res.status}`);
  const json: any = await res.json();

  const score = Math.round((json.confidence ?? 0) * 100);
  return { band: bandFor(score), score, provider: 'azure' };
}

/** Minimal SigV4 for a single POST, so no AWS SDK is pulled into the production bundle. */
async function signAwsRequest(args: {
  region: string;
  service: string;
  host: string;
  target: string;
  body: string;
  accessKey: string;
  secretKey: string;
}): Promise<Record<string, string>> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const canonicalHeaders =
    `content-type:application/x-amz-json-1.1\n` + `host:${args.host}\n` + `x-amz-date:${amzDate}\n` + `x-amz-target:${args.target}\n`;
  const signedHeaders = 'content-type;host;x-amz-date;x-amz-target';
  const payloadHash = crypto.createHash('sha256').update(args.body).digest('hex');
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const scope = `${dateStamp}/${args.region}/${args.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const hmac = (key: crypto.BinaryLike | Buffer, data: string) =>
    crypto.createHmac('sha256', key as any).update(data).digest();
  const kDate = hmac(`AWS4${args.secretKey}`, dateStamp);
  const kRegion = hmac(kDate, args.region);
  const kService = hmac(kRegion, args.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    'Content-Type': 'application/x-amz-json-1.1',
    'X-Amz-Date': amzDate,
    'X-Amz-Target': args.target,
    Authorization: `AWS4-HMAC-SHA256 Credential=${args.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** Is any provider configured? Surfaced on App health so the gap is visible, not silent. */
export function faceProviderConfigured(): boolean {
  return !!(
    (process.env.AWS_REKOGNITION_REGION && process.env.AWS_ACCESS_KEY_ID) ||
    (process.env.FACEPP_API_KEY && process.env.FACEPP_API_SECRET) ||
    (process.env.AZURE_FACE_ENDPOINT && process.env.AZURE_FACE_KEY)
  );
}
