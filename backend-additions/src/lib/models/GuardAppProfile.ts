import mongoose, { Schema, model, models } from 'mongoose';

/**
 * Guard-App-specific identity data that does not belong on the shared APGuard record
 * (PRD 18.1 / 18.6 / 18.11). Keyed by the APGuard _id string. Additive: keeps device binding,
 * face enrolment, documents and agency-association history without touching APGuard.
 */
const DocumentSchema = new Schema(
  {
    kind: { type: String, required: true }, // aadhaar | pan | bank | psara | police
    status: { type: String, enum: ['Pending', 'Verified', 'Expiring', 'Expired', 'Rejected'], default: 'Pending' },
    /** Aadhaar is only ever stored masked (last four digits), per UIDAI storage rules. */
    number: { type: String, default: '' },
    /** Legacy device-local path from older builds; the server cannot open it. */
    imageUri: { type: String, default: '' },
    /** The uploaded scan in the media store. May arrive after the record when the guard is offline. */
    mediaId: { type: String, default: '' },
    clientEventUuid: { type: String, default: '' },
    /** The app's blur check failed and the guard chose to submit anyway — reviewer, look closely. */
    blurSuspected: { type: Boolean, default: false },
    reviewNote: { type: String, default: '' },
    expiresOn: { type: Date },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const AssociationSchema = new Schema(
  {
    agencyId: String,
    agencyName: String,
    status: { type: String, enum: ['Pending', 'Active', 'Archived', 'Rejected'], default: 'Pending' },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date },
    endedBy: { type: String, default: '' },
    reason: { type: String, default: '' },
  },
  { _id: false }
);

const GuardAppProfileSchema = new Schema(
  {
    guardId: { type: String, required: true, unique: true, index: true },

    /** Bumped on logout or device revocation; session tokens carrying an older value stop renewing. */
    sessionVersion: { type: Number, default: 0 },

    // Device binding (PRD 18.1 §9 / 18.6): one active device per guard.
    boundDeviceId: { type: String, default: '' },
    pendingDeviceId: { type: String, default: '' }, // awaiting approval on device change
    deviceModel: { type: String, default: '' },
    lastDeviceChangeAt: { type: Date },

    // Face enrolment (PRD 18.1 §5 / §39).
    faceEnrolledAt: { type: Date },
    faceTemplateRef: { type: String, default: '' },
    /** The uploaded enrolment image in the media store — what captures are compared against. */
    faceEnrolMediaId: { type: String, default: '' },
    /** Legacy device-local path. Kept for older app builds; cannot be compared against. */
    faceEnrolUri: { type: String, default: '' },
    /**
     * Re-enrolment history. PRD 18.5 §16: a guard whose face changes (beard, injury, bandage)
     * should be asked to re-enrol, not blocked repeatedly.
     */
    faceEnrolHistory: {
      type: [{ mediaId: String, at: Date, reason: String }],
      default: [],
    },
    /** Set after a run of low scores, so the app can prompt instead of flagging forever. */
    reEnrolmentSuggested: { type: Boolean, default: false },
    consecutiveLowFaceScores: { type: Number, default: 0 },

    documents: { type: [DocumentSchema], default: [] },
    associations: { type: [AssociationSchema], default: [] },
    ackedNotices: { type: [String], default: [] }, // acknowledged notice ids (PRD 18.14 / SUR-GAP-025)
    pushToken: { type: String, default: '' },

    // --- Supervisor (field) capability (PRD 18.16 / SUR-GAP-034) ---
    // A supervisor uses the same app with an extra "My team" tab, not a different app. The grant
    // is explicit rather than inferred from a job title, because it carries real authority:
    // approving a flagged check-in and marking a guard present by proxy both move money.
    isSupervisor: { type: Boolean, default: false },
    /** Sites this supervisor covers, beyond the ones they are themselves rostered to. */
    supervisorSiteIds: { type: [String], default: [] },
    /** Fine-grained grants, so proxy attendance can be withheld from a verifying-only role. */
    permissions: { type: [String], default: [] }, // attendance.verify | attendance.proxy | notice.broadcast

    // --- Personal details not held on APGuard (PRD 18.11 / SUR-GAP-026) ---
    // Written only through an applied change request, never directly by the app.
    dob: { type: String, default: '' }, // YYYY-MM-DD
    emergencyContact: {
      name: { type: String, default: '' },
      phone: { type: String, default: '' },
      relation: { type: String, default: '' },
    },
    /**
     * Where wages are paid. The full account number is `select: false` so an ordinary profile
     * read never carries it; payroll reads it explicitly.
     */
    payout: {
      method: { type: String, enum: ['', 'bank', 'upi'], default: '' },
      accountHolder: { type: String, default: '' },
      accountNumber: { type: String, default: '', select: false },
      accountLast4: { type: String, default: '' },
      ifsc: { type: String, default: '' },
      vpa: { type: String, default: '' },
      updatedAt: { type: Date },
      changeRequestId: { type: String, default: '' },
    },
  },
  { timestamps: true }
);

export const GuardAppProfile =
  models.GuardAppProfile || model('GuardAppProfile', GuardAppProfileSchema);
