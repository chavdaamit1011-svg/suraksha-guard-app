import { Schema, model, models } from 'mongoose';

/**
 * Guard-app site configuration (PRD 18.4 / 18.5 / 18.8).
 *
 * The existing `Site` model carries `geofenceRadius`, `address` and a free-text `postOrders`
 * string, but no coordinates — and the Guard App cannot evaluate a geofence without them.
 * Rather than modify the shared `Site` schema (which the agency portal owns), this collection
 * holds the guard-app-specific overlay for a site: its reporting-point coordinates, the duty
 * windows, the wake-check policy and the structured briefing cards.
 *
 * Lookup is by `siteId` where the caller has one, else by `agencyId` + `siteName` — the
 * AgencyRoster links a shift to a site by name, not by id.
 *
 * Every field has a default, so a site with no config row still behaves sensibly: the app falls
 * back to `Site.geofenceRadius` and to `geofence_result = unknown` when coordinates are absent
 * (which routes the check-in to supervisor verification rather than blocking duty — PRD 18.5 §16).
 */

const ContactSchema = new Schema(
  {
    name: { type: String, default: '' },
    phone: { type: String, default: '' },
    role: { type: String, default: '' }, // supervisor | control_room | client | police
  },
  { _id: false }
);

const BriefingCardSchema = new Schema(
  {
    text: { type: String, default: '' }, // <= 12 words per PRD 18.17.1 rule 7
    imageUrl: { type: String, default: '' },
    order: { type: Number, default: 0 },
  },
  { _id: false }
);

const GuardSiteConfigSchema = new Schema(
  {
    siteId: { type: String, default: '', index: true },
    siteName: { type: String, required: true, index: true },
    agencyId: { type: String, default: '', index: true },

    // --- Reporting point + geofence (PRD 18.5 §8) ---
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    /** Overrides Site.geofenceRadius when set. Large industrial sites may need 200m+. */
    geofenceRadiusM: { type: Number, default: null },
    reportingPoint: { type: String, default: '' },

    // --- Attendance windows (PRD 18.5 §9, agency-configurable, never hardcoded in the app) ---
    checkInWindowBeforeMin: { type: Number, default: 60 },
    checkInWindowAfterMin: { type: Number, default: 240 },
    lateGraceMin: { type: Number, default: 15 },
    autoAbsentAfterMin: { type: Number, default: 60 },
    checkOutEarlyAllowedMin: { type: Number, default: 30 },
    autoCloseAfterMin: { type: Number, default: 120 },

    // --- Wake check policy (PRD 18.8 §9) ---
    wakeCheckEnabled: { type: Boolean, default: false },
    wakeWindowStart: { type: String, default: '23:00' },
    wakeWindowEnd: { type: String, default: '05:30' },
    wakeIntervalMinMin: { type: Number, default: 45 },
    wakeIntervalMaxMin: { type: Number, default: 90 },
    wakeAckWindowSec: { type: Number, default: 120 },
    wakeSelfieRequired: { type: Boolean, default: false },

    // --- Patrol (PRD 18.7 §9) ---
    patrolRoundIntervalMin: { type: Number, default: 60 },
    patrolStrictOrder: { type: Boolean, default: false },
    patrolScanRadiusM: { type: Number, default: 50 },

    // --- Briefing (PRD 18.4) ---
    briefingCards: { type: [BriefingCardSchema], default: [] },
    briefingVersion: { type: Number, default: 1 },
    uniformRequired: { type: String, default: '' },
    equipmentRequired: { type: [String], default: [] },
    escalationContacts: { type: [ContactSchema], default: [] },

    // --- SOS (PRD 18.9 §9 step 6) ---
    sirenEnabled: { type: Boolean, default: true },
    sosSmsNumber: { type: String, default: '' },
  },
  { timestamps: true }
);

GuardSiteConfigSchema.index({ agencyId: 1, siteName: 1 });

export const GuardSiteConfig =
  models.GuardSiteConfig || model('GuardSiteConfig', GuardSiteConfigSchema);
