import { Schema, model, models } from 'mongoose';

/**
 * A guard's progress through a training module (PRD 18.14 Training, SUR-GAP-024).
 *
 * Kept server-side rather than only on the device because completion is **evidence**: it gates
 * deployment to certain post types, it is what an agency shows a client who asks whether the
 * guard on their gate is fire-trained, and it has to survive the guard changing phones.
 *
 * Attempts are appended, never replaced. A guard who fails twice and passes on the third try has
 * a training history, not a single flattering number.
 */

const AttemptSchema = new Schema(
  {
    at: { type: Date, default: Date.now },
    scorePct: { type: Number, default: 0 },
    passed: { type: Boolean, default: false },
    /** Which questions were answered wrongly, so the agency can see what is not landing. */
    wrongQuestionIds: { type: [String], default: [] },
    /** Seconds spent in the module before this attempt — a 4-second "completion" is visible. */
    studySeconds: { type: Number, default: 0 },
  },
  { _id: false }
);

const GuardTrainingRecordSchema = new Schema(
  {
    guardId: { type: String, required: true, index: true },
    moduleId: { type: String, required: true, index: true },
    agencyId: { type: String, default: '' },

    status: {
      type: String,
      enum: ['Pending', 'In Progress', 'Completed'],
      default: 'Pending',
      index: true,
    },

    /** Lesson ids the guard has opened and finished. Drives the progress ring. */
    lessonsCompleted: { type: [String], default: [] },
    totalLessons: { type: Number, default: 0 },

    attempts: { type: [AttemptSchema], default: [] },
    bestScorePct: { type: Number, default: 0 },
    passed: { type: Boolean, default: false },
    completedAt: { type: Date, default: null },

    /**
     * The certificate reference issued on passing (PRD 18.14: "certificates are tenant-signed
     * artefacts"). Stored as an id plus a signature over the facts, so it can be verified later
     * without trusting whatever the app displays.
     */
    certificateId: { type: String, default: '' },
    certificateSig: { type: String, default: '' },

    /** Set from the module catalogue at enrolment so an expiry sweep has something to read. */
    expiresOn: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    lastOpenedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

GuardTrainingRecordSchema.index({ guardId: 1, moduleId: 1 }, { unique: true });

export const GuardTrainingRecord =
  models.GuardTrainingRecord || model('GuardTrainingRecord', GuardTrainingRecordSchema);
