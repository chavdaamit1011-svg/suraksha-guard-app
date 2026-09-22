import { Schema, model, models } from 'mongoose';

/**
 * Replacement offers (PRD 18.12, SUR-GAP-022).
 *
 * A guard goes on leave, or fails to show; the agency needs the post filled. The engine offers
 * the shift to candidates in waves — nearest and best-matched first, then widening — and the
 * **first ACCEPT wins**.
 *
 * The reason this is two collections rather than one is that atomicity: the vacancy is the thing
 * being competed for, and claiming it has to be a single conditional update that exactly one
 * request can win. PRD 18.12 §18 is explicit — two guards tapping ACCEPT in the same second must
 * produce one confirmation, one refusal, and no double assignment.
 */

const VacancySchema = new Schema(
  {
    agencyId: { type: String, default: '', index: true },
    /** The roster row whose slot needs filling. */
    rosterId: { type: String, required: true, index: true },
    shiftDate: { type: String, default: '', index: true },
    siteId: { type: String, default: '' },
    siteName: { type: String, default: '' },
    timing: { type: String, default: '' },
    shiftType: { type: String, default: '' },

    /** Who is being replaced, and why — shown to the candidate for context. */
    replacingGuardId: { type: String, default: '' },
    replacingGuardName: { type: String, default: '' },
    reason: { type: String, default: '' }, // leave | absent | no_show | other

    /** Extra pay for taking the shift, in paise (money is integer paise everywhere, canon §4). */
    incentivePaise: { type: Number, default: 0 },

    status: { type: String, enum: ['open', 'filled', 'cancelled', 'expired'], default: 'open', index: true },
    filledBy: { type: String, default: '' },
    filledAt: { type: Date, default: null },
    /** Which dispatch wave the engine has reached. */
    wave: { type: Number, default: 1 },
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);

const OfferSchema = new Schema(
  {
    vacancyId: { type: String, required: true, index: true },
    guardId: { type: String, required: true, index: true },

    /** Denormalised so the offer card renders from cache with no network (PRD 18.15.2). */
    siteName: { type: String, default: '' },
    siteId: { type: String, default: '' },
    shiftDate: { type: String, default: '' },
    timing: { type: String, default: '' },
    shiftType: { type: String, default: '' },
    incentivePaise: { type: Number, default: 0 },
    distanceKm: { type: Number, default: null },

    wave: { type: Number, default: 1 },
    expiresAt: { type: Date, required: true, index: true },

    status: {
      type: String,
      enum: ['pending', 'accepted', 'declined', 'expired', 'cancelled', 'lost'],
      default: 'pending',
      index: true,
    },
    /** `lost` means the guard accepted but another guard got there first. */
    respondedAt: { type: Date, default: null },
    /** Non-response is a reliability signal, not a penalty by default (PRD 18.12 §9). */
    notifiedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// One offer per guard per vacancy — re-dispatching a wave must not duplicate cards.
OfferSchema.index({ vacancyId: 1, guardId: 1 }, { unique: true });
OfferSchema.index({ guardId: 1, status: 1, expiresAt: -1 });

export const GuardVacancy = models.GuardVacancy || model('GuardVacancy', VacancySchema);
export const GuardReplacementOffer =
  models.GuardReplacementOffer || model('GuardReplacementOffer', OfferSchema);
