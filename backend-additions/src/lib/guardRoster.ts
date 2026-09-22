import Site from '@/lib/models/Site';
import { GuardSiteConfig } from '@/lib/models/GuardSiteConfig';

/**
 * Roster / shift resolution for the Guard App (PRD 18.3, 18.4, 18.5, 18.8).
 *
 * The Guard App is a rostered-duty tool, not an on-demand one: everything on the Duty Home is
 * derived from an AgencyRoster row (date + siteName + timing) joined to a Site and its
 * guard-app overlay (GuardSiteConfig). These helpers do that join and own the shift-window
 * arithmetic, so the routes stay thin and the state machine lives in exactly one place.
 *
 * Time zone is always IST (PRD 18.5 §16: "devices set to other zones are normalised and
 * flagged"), and the server may well run in UTC — so every wall-clock string in the roster is
 * interpreted here at +05:30 rather than in the process's local zone.
 */

export const IST_OFFSET_MIN = 330; // +05:30

const MS_MIN = 60_000;

/** The IST calendar day ("YYYY-MM-DD") that an instant falls on. */
export function istDateKey(d: Date = new Date()): string {
  const shifted = new Date(d.getTime() + IST_OFFSET_MIN * MS_MIN);
  return shifted.toISOString().slice(0, 10);
}

/** `dateKey` + `HH:mm` read as an IST wall-clock time, returned as a real (UTC-based) Date. */
export function istDateAt(dateKey: string, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10) || 0);
  const base = Date.parse(`${dateKey}T00:00:00.000Z`);
  return new Date(base + (h * 60 + m - IST_OFFSET_MIN) * MS_MIN);
}

/** Offset an IST date key by whole days. */
export function addDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Normalise the roster's free-text `timing` into 24h start/end.
 * Accepts "08:00 - 20:00", "8:00-20:00", "8:00 AM - 8:00 PM", "20:00 to 08:00".
 * Falls back to a 09:00–18:00 day shift rather than throwing, because a malformed timing
 * string must never stop a guard from marking duty.
 */
export function parseTiming(timing: string): { start: string; end: string } {
  const fallback = { start: '09:00', end: '18:00' };
  if (!timing) return fallback;

  const matches = [...timing.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/gi)];
  if (matches.length < 2) return fallback;

  const toHHMM = (m: RegExpMatchArray): string => {
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2] ?? '0', 10) || 0;
    const mer = (m[3] ?? '').toLowerCase();
    if (mer === 'pm' && h < 12) h += 12;
    if (mer === 'am' && h === 12) h = 0;
    if (h > 23) h = 23;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  };

  return { start: toHHMM(matches[0]), end: toHHMM(matches[1]) };
}

export type ShiftWindow = {
  start: string;
  end: string;
  startAt: Date;
  endAt: Date;
  crossesMidnight: boolean;
  durationMin: number;
};

/**
 * The absolute window a rostered shift occupies. A shift whose end time is at or before its
 * start time runs into the next calendar day — PRD 18.3 §16: "the Duty screen belongs to the
 * shift, not the calendar day".
 */
export function shiftWindow(dateKey: string, timing: string): ShiftWindow {
  const { start, end } = parseTiming(timing);
  const startAt = istDateAt(dateKey, start);
  let endAt = istDateAt(dateKey, end);
  const crossesMidnight = endAt.getTime() <= startAt.getTime();
  if (crossesMidnight) endAt = new Date(endAt.getTime() + 24 * 60 * MS_MIN);
  return {
    start,
    end,
    startAt,
    endAt,
    crossesMidnight,
    durationMin: Math.round((endAt.getTime() - startAt.getTime()) / MS_MIN),
  };
}

/** Great-circle distance in metres. */
export function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export type ResolvedSite = {
  site: any | null;
  config: any | null;
  siteId: string;
  siteName: string;
  address: string;
  lat: number | null;
  lng: number | null;
  geofenceRadiusM: number;
  /** false when the site has no coordinates — the geofence cannot be evaluated at all. */
  geoKnown: boolean;
};

const DEFAULT_RADIUS_M = 100;

/**
 * Join a roster row's `siteName` to its Site and guard-app overlay. The roster links to a site
 * by name (it carries no siteId), so the name + agency is the lookup key; the overlay may also
 * be registered against the Site's `_id` once one exists.
 */
export async function resolveSite(agencyId: string, siteName: string): Promise<ResolvedSite> {
  const nameRx = new RegExp(`^${escapeRx(siteName ?? '')}$`, 'i');

  const site: any = siteName
    ? await Site.findOne(agencyId ? { agencyId, name: nameRx } : { name: nameRx })
        .lean()
        .catch(() => null)
    : null;

  const siteId = site?._id ? String(site._id) : '';
  const config: any = await GuardSiteConfig.findOne(
    siteId
      ? { $or: [{ siteId }, { siteName: nameRx, agencyId }] }
      : { siteName: nameRx, ...(agencyId ? { agencyId } : {}) }
  )
    .lean()
    .catch(() => null);

  const lat = Number.isFinite(config?.lat) ? config.lat : null;
  const lng = Number.isFinite(config?.lng) ? config.lng : null;

  return {
    site,
    config,
    siteId,
    siteName: site?.name ?? siteName ?? '',
    address: site?.address ?? '',
    lat,
    lng,
    geofenceRadiusM:
      (Number.isFinite(config?.geofenceRadiusM) ? config.geofenceRadiusM : null) ??
      (Number.isFinite(site?.geofenceRadius) ? site.geofenceRadius : null) ??
      DEFAULT_RADIUS_M,
    geoKnown: lat !== null && lng !== null && !(lat === 0 && lng === 0),
  };
}

function escapeRx(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Server-authoritative geofence verdict (PRD 18.5 §10 — the client's own verdict is never
 * trusted). `unknown` when the site has no coordinates or the fix is missing; an unknown
 * verdict routes to supervisor verification, it does not reject the event.
 */
export function evaluateGeofence(
  resolved: Pick<ResolvedSite, 'lat' | 'lng' | 'geofenceRadiusM' | 'geoKnown'>,
  lat?: number,
  lng?: number
): { geofenceResult: 'inside' | 'outside' | 'unknown'; distanceM: number | null } {
  if (!resolved.geoKnown || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { geofenceResult: 'unknown', distanceM: null };
  }
  const distanceM = Math.round(haversineM(lat as number, lng as number, resolved.lat as number, resolved.lng as number));
  return { geofenceResult: distanceM <= resolved.geofenceRadiusM ? 'inside' : 'outside', distanceM };
}

/** Duty windows, with the site overlay's per-agency overrides applied. */
export type DutyPolicy = {
  checkInWindowBeforeMin: number;
  checkInWindowAfterMin: number;
  lateGraceMin: number;
  autoAbsentAfterMin: number;
  checkOutEarlyAllowedMin: number;
  autoCloseAfterMin: number;
};

export function dutyPolicy(config: any | null): DutyPolicy {
  return {
    checkInWindowBeforeMin: config?.checkInWindowBeforeMin ?? 60,
    checkInWindowAfterMin: config?.checkInWindowAfterMin ?? 240,
    lateGraceMin: config?.lateGraceMin ?? 15,
    autoAbsentAfterMin: config?.autoAbsentAfterMin ?? 60,
    checkOutEarlyAllowedMin: config?.checkOutEarlyAllowedMin ?? 30,
    autoCloseAfterMin: config?.autoCloseAfterMin ?? 120,
  };
}

export type DutyState =
  | 'no_duty'
  | 'upcoming'
  | 'check_in'
  | 'late'
  | 'absent'
  | 'on_duty'
  | 'check_out'
  | 'complete';

/**
 * The single state machine behind the Duty Home's primary button (PRD 18.3 §9). The app renders
 * this verdict; it does not compute its own, so a policy change is a config change on the server
 * rather than an app release.
 */
export function dutyState(input: {
  window: ShiftWindow;
  policy: DutyPolicy;
  checkedInAt: Date | null;
  checkedOutAt: Date | null;
  now?: Date;
}): {
  state: DutyState;
  /** Seconds until the next state transition, for the countdown. Null when nothing is pending. */
  countdownSec: number | null;
  canCheckIn: boolean;
  canCheckOut: boolean;
  lateByMin: number;
  earlyOutReasonRequired: boolean;
} {
  const now = input.now ?? new Date();
  const t = now.getTime();
  const { window: w, policy: p } = input;
  const start = w.startAt.getTime();
  const end = w.endAt.getTime();

  const windowOpens = start - p.checkInWindowBeforeMin * MS_MIN;
  const windowCloses = start + p.checkInWindowAfterMin * MS_MIN;
  const absentAt = start + p.autoAbsentAfterMin * MS_MIN;
  const checkOutOpens = end - p.checkOutEarlyAllowedMin * MS_MIN;

  const lateByMin = input.checkedInAt
    ? Math.max(0, Math.round((input.checkedInAt.getTime() - start - p.lateGraceMin * MS_MIN) / MS_MIN))
    : 0;

  if (input.checkedOutAt) {
    return { state: 'complete', countdownSec: null, canCheckIn: false, canCheckOut: false, lateByMin, earlyOutReasonRequired: false };
  }

  if (input.checkedInAt) {
    const canCheckOut = true; // never block check-out; an early one just needs a reason
    const state: DutyState = t >= checkOutOpens ? 'check_out' : 'on_duty';
    return {
      state,
      countdownSec: t < checkOutOpens ? Math.round((checkOutOpens - t) / 1000) : null,
      canCheckIn: false,
      canCheckOut,
      lateByMin,
      earlyOutReasonRequired: t < checkOutOpens,
    };
  }

  if (t < windowOpens) {
    return { state: 'upcoming', countdownSec: Math.round((windowOpens - t) / 1000), canCheckIn: false, canCheckOut: false, lateByMin: 0, earlyOutReasonRequired: false };
  }

  if (t > windowCloses) {
    return { state: 'absent', countdownSec: null, canCheckIn: false, canCheckOut: false, lateByMin: 0, earlyOutReasonRequired: false };
  }

  // Inside the check-in window. Past the absent threshold the guard may still check in —
  // PRD 18.17.1 rule 12: nothing blocks duty; the record simply carries the flag.
  const state: DutyState = t > absentAt ? 'absent' : t > start + p.lateGraceMin * MS_MIN ? 'late' : 'check_in';
  return {
    state,
    countdownSec: t < start ? Math.round((start - t) / 1000) : null,
    canCheckIn: true,
    canCheckOut: false,
    lateByMin: 0,
    earlyOutReasonRequired: false,
  };
}

/**
 * Randomised wake-check times for one night shift (PRD 18.8 §9): 45–90 min apart, inside the
 * configured night window, intersected with the shift. Generated server-side and pushed in the
 * duty bundle so the device can arm local alarms and fire them with no network.
 */
export function generateWakeTimes(w: ShiftWindow, config: any | null, dateKey: string): Date[] {
  if (!config?.wakeCheckEnabled) return [];

  const windowStart = config.wakeWindowStart ?? '23:00';
  const windowEnd = config.wakeWindowEnd ?? '05:30';
  const minGap = (config.wakeIntervalMinMin ?? 45) * MS_MIN;
  const maxGap = (config.wakeIntervalMaxMin ?? 90) * MS_MIN;

  let nightStart = istDateAt(dateKey, windowStart).getTime();
  let nightEnd = istDateAt(dateKey, windowEnd).getTime();
  if (nightEnd <= nightStart) nightEnd += 24 * 60 * MS_MIN;

  // Intersect the night window with the shift itself.
  const from = Math.max(nightStart, w.startAt.getTime());
  const to = Math.min(nightEnd, w.endAt.getTime());
  if (to - from < minGap) return [];

  const times: Date[] = [];
  let cursor = from + minGap / 2 + Math.random() * (maxGap - minGap);
  while (cursor < to && times.length < 12) {
    times.push(new Date(Math.round(cursor)));
    cursor += minGap + Math.random() * (maxGap - minGap);
  }
  return times;
}

/** Patrol round start times across the shift, at the site's configured interval (PRD 18.7 §9). */
export function generatePatrolRoundTimes(w: ShiftWindow, config: any | null): Date[] {
  const intervalMin = config?.patrolRoundIntervalMin ?? 60;
  if (!intervalMin || intervalMin <= 0) return [];
  const times: Date[] = [];
  let t = w.startAt.getTime();
  while (t < w.endAt.getTime() && times.length < 24) {
    times.push(new Date(t));
    t += intervalMin * MS_MIN;
  }
  return times;
}

/** Split a Site's free-text `postOrders` into the briefing card stack the app renders. */
export function briefingCards(resolved: ResolvedSite): { text: string; imageUrl: string; order: number }[] {
  const configured = resolved.config?.briefingCards ?? [];
  if (configured.length > 0) {
    return [...configured].sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
  }
  const raw: string = resolved.site?.postOrders ?? '';
  return raw
    .split(/\r?\n|(?<=\.)\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((text, order) => ({ text, imageUrl: '', order }));
}
