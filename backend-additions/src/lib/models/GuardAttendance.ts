import mongoose, { Schema, model, models } from 'mongoose';

/**
 * Attendance events captured by the Guard App (PRD 18.5). Append-only: corrections create a
 * new linked record rather than overwriting. Idempotent on clientEventUuid so the offline
 * queue can safely re-send. Never trusts the client's own geofence verdict beyond recording it.
 */
const GuardAttendanceSchema = new Schema(
  {
    clientEventUuid: { type: String, required: true, unique: true }, // idempotency key
    captureSequenceNo: { type: Number, default: 0 }, // per-device counter (gap detection)
    guardId: { type: String, required: true, index: true },
    bookingId: { type: String, default: '', index: true },
    eventType: { type: String, enum: ['check_in', 'check_out', 'break_start', 'break_end'], required: true },

    // --- Roster linkage (PRD 18.5 §7). The shift an event belongs to, not the calendar day:
    // a night shift started on the 12th stays on the 12th's roster row past midnight. ---
    rosterId: { type: String, default: '', index: true },
    shiftDate: { type: String, default: '', index: true }, // YYYY-MM-DD of the roster row
    siteId: { type: String, default: '' },
    siteName: { type: String, default: '' },

    deviceTime: { type: Date },
    serverReceivedTime: { type: Date, default: Date.now },
    monotonicMs: { type: Number },
    /** Monotonic-clock reconstruction of the true occurrence time (PRD 18.15.5 step 2). */
    estimatedTrueTime: { type: Date },

    lat: { type: Number },
    lng: { type: Number },
    accuracyM: { type: Number },
    geofenceResult: { type: String, enum: ['inside', 'outside', 'unknown'], default: 'unknown' },
    /** Server-computed distance from the site's reporting point; null when coords are unknown. */
    distanceM: { type: Number, default: null },
    outsideReason: { type: String, default: '' },
    isMockLocation: { type: Boolean, default: false },

    deviceId: { type: String, default: '' },
    deviceModel: { type: String, default: '' },
    osVersion: { type: String, default: '' },
    appVersion: { type: String, default: '' },

    provider: { type: String, default: '' }, // gps | network | fused
    batteryPct: { type: Number },
    isCharging: { type: Boolean },
    networkState: { type: String, default: '' }, // online | offline

    /** Server-issued id from /api/guard/media — the real evidence. */
    selfieMediaId: { type: String, default: '', index: true },
    /** Legacy/diagnostic: the device-local URI the app captured from. Not servable. */
    selfieUri: { type: String, default: '' },
    photoHash: { type: String, default: '' },
    faceMatchScore: { type: Number },
    livenessResult: { type: String, default: '' },

    // --- Derived duty flags (computed server-side from the roster window, never client-sent) ---
    lateByMin: { type: Number, default: 0 },
    earlyOutReason: { type: String, default: '' },
    autoClosed: { type: Boolean, default: false },
    /** A correction never overwrites: it points at the record it replaces (PRD 18.5 §11). */
    supersedes: { type: String, default: '' },

    // Confidence, not a hard block: a failed check downgrades the record and raises review.
    confidence: { type: String, enum: ['high', 'low', 'review'], default: 'high' },
    eventTrustScore: { type: Number, default: 100 }, // 0-100, computed from the signal set (PRD 18.6)
    timeConfidence: { type: String, enum: ['high', 'low'], default: 'high' },
    reviewFlags: { type: [String], default: [] },

    // --- Supervisor verification (PRD 18.16). A flagged event is recorded, then decided by a
    // human; the decision is appended, never used to rewrite the original capture. ---
    reviewDecision: { type: String, enum: ['', 'approved', 'rejected'], default: '' },
    reviewedBy: { type: String, default: '' },
    reviewedAt: { type: Date, default: null },
    reviewReason: { type: String, default: '' },

    /** Set when a supervisor marked this for a guard who had no working phone (18.5 §9). */
    proxyBy: { type: String, default: '' },
    meta: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

GuardAttendanceSchema.index({ guardId: 1, createdAt: -1 });
// The Duty Home asks "has this guard checked in for this shift?" on every open.
GuardAttendanceSchema.index({ guardId: 1, rosterId: 1, eventType: 1 });

export const GuardAttendance =
  models.GuardAttendance || model('GuardAttendance', GuardAttendanceSchema);
