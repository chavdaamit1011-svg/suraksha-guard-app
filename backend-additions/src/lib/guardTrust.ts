/**
 * Anti-spoof event trust scoring (PRD 18.6). Combines the device/location signal set into a
 * 0-100 eventTrustScore, a confidence band and review flags. Never a hard block — a low score
 * downgrades the record and raises a review task (canon: never block a guard from marking duty).
 */
export type TrustInput = {
  isMockLocation?: boolean;
  accuracyM?: number;
  geofenceResult?: 'inside' | 'outside' | 'unknown';
  deviceTime?: string | number | Date;
  serverTime?: number;
  monotonicMs?: number;
  photoHashSeenBefore?: boolean;
  deviceIntegrityCompromised?: boolean;

  // --- Client-reported device integrity (PRD 18.6 §9). These are *hints*: everything below is
  // observable and therefore forgeable on a rooted device, so each carries a modest penalty and
  // none is decisive on its own. The server-side signals — geofence, clock skew, reused media,
  // impossible travel — are what actually carry weight (18.6 §14). ---
  /** Play Integrity verdict, or root-indicator heuristics where it is unavailable. */
  isRooted?: boolean;
  /** Hardware/sensor fingerprint suggesting an emulator rather than a handset. */
  isEmulator?: boolean;
  /** Developer options enabled — weak on its own, corroborating alongside others. */
  developerMode?: boolean;
  /** App signature or checksum did not match the published build. */
  appTampered?: boolean;

  /** Speed implied by the previous event from this guard, in km/h. Server-derived. */
  impliedSpeedKmh?: number;
  /** A gap in the per-device capture counter: events were deleted from the queue (18.15.6). */
  sequenceGapDetected?: boolean;
};

export type TrustResult = {
  eventTrustScore: number;
  confidence: 'high' | 'low' | 'review';
  timeConfidence: 'high' | 'low';
  reviewFlags: string[];
};

export function scoreEvent(i: TrustInput): TrustResult {
  const flags: string[] = [];
  let score = 100;

  if (i.isMockLocation) {
    score -= 60;
    flags.push('mock_location');
  }
  if (i.deviceIntegrityCompromised) {
    score -= 20;
    flags.push('device_integrity');
  }
  if (i.photoHashSeenBefore) {
    score -= 50;
    flags.push('reused_media');
  }
  if (typeof i.accuracyM === 'number' && i.accuracyM > 100) {
    score -= 10;
    flags.push('low_gps_accuracy');
  }

  /**
   * Device integrity. PRD 18.6 is explicit that a rooted phone is **not** an automatic block —
   * "many legitimate low-end devices fail these checks" — so the penalty is small and the guard
   * sees nothing. An emulator is different: there is no honest reason for a guard's attendance
   * to come from one, so it costs much more.
   */
  if (i.isRooted) {
    score -= 15;
    flags.push('device_rooted');
  }
  if (i.isEmulator) {
    score -= 50;
    flags.push('emulator');
  }
  if (i.appTampered) {
    score -= 45;
    flags.push('app_tampered');
  }
  if (i.developerMode) {
    // On its own this means almost nothing; it earns its place by corroborating the others.
    score -= 5;
    flags.push('developer_mode');
  }

  /**
   * Impossible travel (PRD 18.6 §9): two events implying more than 120 km/h between them. The
   * threshold is deliberately above highway speed — a guard genuinely driving between sites must
   * not be flagged — and a very high figure usually means one of the two locations was faked.
   */
  if (typeof i.impliedSpeedKmh === 'number' && i.impliedSpeedKmh > 120) {
    score -= i.impliedSpeedKmh > 400 ? 45 : 25;
    flags.push('impossible_travel');
  }

  if (i.sequenceGapDetected) {
    score -= 20;
    flags.push('sequence_gap');
  }
  if (i.geofenceResult === 'outside') {
    score -= 25;
    flags.push('outside_geofence');
  } else if (i.geofenceResult === 'unknown') {
    score -= 10;
    flags.push('geofence_unknown');
  }

  // Clock-tamper check: device_time vs server_received_time delta beyond ±120 s.
  let timeConfidence: 'high' | 'low' = 'high';
  if (i.deviceTime && i.serverTime) {
    const dt = new Date(i.deviceTime).getTime();
    if (Number.isFinite(dt) && Math.abs(i.serverTime - dt) > 120_000) {
      timeConfidence = 'low';
      score -= 15;
      flags.push('clock_skew');
    }
  }

  score = Math.max(0, Math.min(100, score));
  const confidence: TrustResult['confidence'] = score >= 75 ? 'high' : score >= 40 ? 'low' : 'review';
  return { eventTrustScore: score, confidence, timeConfidence, reviewFlags: flags };
}
