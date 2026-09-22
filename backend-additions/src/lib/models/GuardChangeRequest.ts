import { Schema, model, models } from 'mongoose';

/**
 * A request to change a guard's personal details (PRD 18.11, SUR-GAP-026).
 *
 * Three kinds, three paths:
 *   identity (name, dob)          → `pending` until the agency approves or rejects it
 *   payout   (bank, upi)          → OTP re-verified, then `cooling_off` for 24 h, then `applied`;
 *                                   payroll is notified at both points and the guard can cancel
 *                                   during the cool-off (the defence against a stolen phone)
 *   contact  (address, emergency) → `applied` immediately; recorded for the audit trail
 *
 * `newValue` holds the full requested value, including a bank account number, so it is
 * `select: false`; API responses carry `display`, a masked summary, instead.
 */
const GuardChangeRequestSchema = new Schema(
  {
    requestId: { type: String, required: true, unique: true, index: true },
    guardId: { type: String, required: true, index: true },
    agencyId: { type: String, default: '', index: true },

    field: { type: String, enum: ['name', 'dob', 'bank', 'upi', 'address', 'emergencyContact'], required: true },
    category: { type: String, enum: ['identity', 'payout', 'contact'], required: true },

    newValue: { type: Schema.Types.Mixed, select: false },
    display: { type: String, default: '' },
    previousDisplay: { type: String, default: '' },
    reason: { type: String, default: '' },
    mediaIds: { type: [String], default: [] },

    status: {
      type: String,
      enum: ['pending', 'cooling_off', 'approved', 'applied', 'rejected', 'cancelled'],
      default: 'pending',
      index: true,
    },
    otpVerifiedAt: { type: Date },
    /** Payout changes take effect at this time unless cancelled first. */
    effectiveAt: { type: Date, index: true },
    appliedAt: { type: Date },

    decidedBy: { type: String, default: '' },
    decidedAt: { type: Date },
    decisionNote: { type: String, default: '' },
    cancelledBy: { type: String, default: '' },

    payrollNotifiedAt: { type: Date },
    guardAlertedAt: { type: Date },
  },
  { timestamps: true }
);

GuardChangeRequestSchema.index({ guardId: 1, field: 1, status: 1 });

export const GuardChangeRequest =
  models.GuardChangeRequest || model('GuardChangeRequest', GuardChangeRequestSchema);
