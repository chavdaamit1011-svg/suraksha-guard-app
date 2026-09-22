import { Schema, model, models } from 'mongoose';

/**
 * Planned anti-sleep wake prompts for one rostered night shift (PRD 18.8 §10).
 *
 * The schedule is generated **server-side** and pushed down in the `/guard/today` bundle so the
 * device can arm local alarms and fire them with no network at all. Persisting it matters for
 * the other half of the rule: "the server independently detects the absence of an expected
 * acknowledgement after a grace period and escalates" — which is only possible if the server
 * knows what it asked for.
 *
 * This is deliberately separate from the agency portal's `NightWakeCheck` collection: that one
 * records prompts the portal itself raised, and pre-seeding it with a whole night of speculative
 * rows would corrupt the portal's own counts. Acknowledgements still write a `wake_check`
 * GuardFieldEvent, which is what payroll and the Command Center read.
 */
const GuardWakeScheduleSchema = new Schema(
  {
    guardId: { type: String, required: true, index: true },
    rosterId: { type: String, default: '', index: true },
    shiftDate: { type: String, default: '', index: true }, // YYYY-MM-DD of the roster row
    siteId: { type: String, default: '' },
    siteName: { type: String, default: '' },
    agencyId: { type: String, default: '' },

    /** When the full-screen prompt should fire. */
    dueAt: { type: Date, required: true, index: true },
    /** Acknowledgement window in seconds (PRD default 120, configurable 60–300). */
    ackWindowSec: { type: Number, default: 120 },
    selfieRequired: { type: Boolean, default: false },

    status: {
      type: String,
      // `reprompted`: the first prompt was missed and the 60 s re-prompt is out (PRD 18.8 §9).
      enum: ['pending', 'reprompted', 'acknowledged', 'acknowledged_late', 'missed', 'suppressed', 'cancelled'],
      default: 'pending',
      index: true,
    },
    acknowledgedAt: { type: Date, default: null },
    respondedMs: { type: Number, default: null },
    /** How many prompts for this slot went unanswered. Drives the escalation ladder. */
    missCount: { type: Number, default: 0 },
    /** Highest priority this slot has been escalated at: '' | 'P2' (supervisor) | 'P1' (command centre). */
    escalatedAt: { type: String, default: '' },
    /** IVR call on the second miss (PRD 18.8 §9): '' | dialling | placed | failed | not_configured. */
    ivrStatus: { type: String, default: '' },
    ivrAt: { type: Date, default: null },
    ivrProvider: { type: String, default: '' },
    ivrRef: { type: String, default: '' },
    /** Set when a patrol scan inside the window proved wakefulness (PRD 18.8 §9). */
    suppressedBy: { type: String, default: '' },
    mediaId: { type: String, default: '' },
  },
  { timestamps: true }
);

// One prompt per guard per instant — makes schedule generation idempotent across bundle fetches.
GuardWakeScheduleSchema.index({ guardId: 1, dueAt: 1 }, { unique: true });

export const GuardWakeSchedule =
  models.GuardWakeSchedule || model('GuardWakeSchedule', GuardWakeScheduleSchema);
