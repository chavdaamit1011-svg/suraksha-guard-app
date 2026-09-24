import mongoose, { Schema, model, models } from 'mongoose';

/**
 * Patrol checkpoint scans, night wake-check acknowledgements, SOS and leave requests captured
 * by the Guard App (PRD 18.7 / 18.8 / 18.9 / 18.12). One collection, discriminated by `kind`,
 * all idempotent on clientEventUuid so the offline queue can re-send safely.
 */
const GuardFieldEventSchema = new Schema(
  {
    clientEventUuid: { type: String, required: true, unique: true },
    kind: {
      type: String,
      enum: ['patrol_scan', 'patrol_observation', 'wake_check', 'sos', 'leave', 'site_visit', 'incident', 'document'],
      required: true,
      index: true,
    },
    guardId: { type: String, required: true, index: true },
    bookingId: { type: String, default: '', index: true },

    rosterId: { type: String, default: '', index: true },
    shiftDate: { type: String, default: '' },
    siteId: { type: String, default: '', index: true },
    siteName: { type: String, default: '' },

    deviceTime: { type: Date },
    serverReceivedTime: { type: Date, default: Date.now },
    estimatedTrueTime: { type: Date },

    lat: { type: Number },
    lng: { type: Number },
    distanceM: { type: Number, default: null },

    mediaIds: { type: [String], default: [] },

    checkpointCode: { type: String, default: '' },
    checkpointId: { type: String, default: '' },
    roundId: { type: String, default: '', index: true },
    scanMethod: { type: String, default: '' },
    respondedMs: { type: Number },
    missed: { type: Boolean, default: false },
    wakeScheduleId: { type: String, default: '', index: true },
    acknowledgedBy: { type: String, default: '' },
    triggerMethod: { type: String, default: '' },
    channel: { type: String, default: '' },

    eventTrustScore: { type: Number, default: 100 },
    confidence: { type: String, enum: ['high', 'low', 'review'], default: 'high' },
    reviewFlags: { type: [String], default: [] },
    fromDate: { type: String, default: '' },
    toDate: { type: String, default: '' },
    reason: { type: String, default: '' },

    status: { type: String, default: 'recorded' },

    reviewDecision: { type: String, enum: ['', 'approved', 'rejected'], default: '' },
    reviewedBy: { type: String, default: '' },
    reviewedAt: { type: Date, default: null },
    reviewReason: { type: String, default: '' },

    meta: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

GuardFieldEventSchema.index({ guardId: 1, kind: 1, createdAt: -1 });

export const GuardFieldEvent =
  models.GuardFieldEvent || model('GuardFieldEvent', GuardFieldEventSchema);
