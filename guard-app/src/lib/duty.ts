import type { Assignment, DutyStateName } from './api';

/**
 * Client-side mirror of the server's duty state machine (PRD 18.3 §9).
 *
 * The server is authoritative — its verdict ships in the duty bundle. But the bundle is a
 * snapshot, and the Duty Home has to keep ticking between polls and keep working with no network
 * at all (18.15.2: "view today's duty — yes, from the duty bundle"). So the app recomputes the
 * same function locally from the cached window and policy. The moment a fresh bundle arrives its
 * verdict wins; this is what fills the gap in between, not a second opinion.
 */

const MS_MIN = 60_000;

export type LocalDuty = {
  state: DutyStateName;
  countdownSec: number | null;
  canCheckIn: boolean;
  canCheckOut: boolean;
  lateByMin: number;
  earlyOutReasonRequired: boolean;
};

export function computeDuty(
  a: Assignment | null,
  now: Date = new Date(),
  booking?: { bookingStatus?: string; [k: string]: any } | null
): LocalDuty {
  if (!a) {
    if (booking) {
      const bs = booking.bookingStatus ?? '';
      if (['ASSIGNED', 'EN_ROUTE', 'ARRIVED'].includes(bs)) {
        return {
          state: 'check_in',
          countdownSec: null,
          canCheckIn: true,
          canCheckOut: false,
          lateByMin: 0,
          earlyOutReasonRequired: false,
        };
      }
      if (bs === 'ACTIVE') {
        return {
          state: 'on_duty',
          countdownSec: null,
          canCheckIn: false,
          canCheckOut: true,
          lateByMin: 0,
          earlyOutReasonRequired: false,
        };
      }
      if (bs === 'CHECKOUT_INITIATED') {
        return {
          state: 'check_out',
          countdownSec: null,
          canCheckIn: false,
          canCheckOut: true,
          lateByMin: 0,
          earlyOutReasonRequired: false,
        };
      }
      if (bs === 'COMPLETED') {
        return {
          state: 'complete',
          countdownSec: null,
          canCheckIn: false,
          canCheckOut: false,
          lateByMin: 0,
          earlyOutReasonRequired: false,
        };
      }
    }
    return { state: 'no_duty', countdownSec: null, canCheckIn: false, canCheckOut: false, lateByMin: 0, earlyOutReasonRequired: false };
  }

  const t = now.getTime();
  const start = Date.parse(a.startAt);
  const end = Date.parse(a.endAt);
  const p = a.policy;

  const windowOpens = start - p.checkInWindowBeforeMin * MS_MIN;
  const windowCloses = start + p.checkInWindowAfterMin * MS_MIN;
  const absentAt = start + p.autoAbsentAfterMin * MS_MIN;
  const checkOutOpens = end - p.checkOutEarlyAllowedMin * MS_MIN;

  const checkedInAt = a.checkedInAt ? Date.parse(a.checkedInAt) : null;
  const checkedOutAt = a.checkedOutAt ? Date.parse(a.checkedOutAt) : null;

  const lateByMin = checkedInAt
    ? Math.max(0, Math.round((checkedInAt - start - p.lateGraceMin * MS_MIN) / MS_MIN))
    : 0;

  if (checkedOutAt) {
    return { state: 'complete', countdownSec: null, canCheckIn: false, canCheckOut: false, lateByMin, earlyOutReasonRequired: false };
  }

  if (checkedInAt) {
    return {
      state: t >= checkOutOpens ? 'check_out' : 'on_duty',
      countdownSec: t < checkOutOpens ? Math.round((checkOutOpens - t) / 1000) : null,
      canCheckIn: false,
      // Check-out is never blocked; leaving early just needs a reason (PRD 18.5 §9).
      canCheckOut: true,
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

  return {
    state: t > absentAt ? 'absent' : t > start + p.lateGraceMin * MS_MIN ? 'late' : 'check_in',
    countdownSec: t < start ? Math.round((start - t) / 1000) : null,
    // Past the absent threshold the guard may still check in: nothing blocks duty
    // (PRD 18.17.1 rule 12). The record simply carries the flag.
    canCheckIn: true,
    canCheckOut: false,
    lateByMin: 0,
    earlyOutReasonRequired: false,
  };
}

/** Great-circle metres — the client-side geofence *hint*; the server re-evaluates on sync. */
export function distanceM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export type GeofenceHint = {
  result: 'inside' | 'outside' | 'unknown';
  distanceM: number | null;
  radiusM: number;
};

export type GeofenceTarget =
  | Assignment
  | { site?: { lat?: number | null; lng?: number | null; geofenceRadiusM?: number; geoKnown?: boolean } }
  | { lat?: number | null; lng?: number | null; radiusM?: number }
  | null;

export function geofenceHint(target: GeofenceTarget, lat?: number, lng?: number): GeofenceHint {
  let targetLat: number | null = null;
  let targetLng: number | null = null;
  let radiusM = 100;
  let geoKnown = false;

  if (target && 'site' in target && target.site) {
    targetLat = target.site.lat ?? null;
    targetLng = target.site.lng ?? null;
    radiusM = target.site.geofenceRadiusM ?? 100;
    geoKnown = !!target.site.geoKnown && targetLat != null && targetLng != null;
  } else if (target && 'lat' in target && target.lat != null && 'lng' in target && target.lng != null) {
    targetLat = target.lat;
    targetLng = target.lng;
    radiusM = (target as any).radiusM ?? 200;
    geoKnown = (targetLat !== 0 || targetLng !== 0);
  }

  if (!geoKnown || targetLat == null || targetLng == null || lat == null || lng == null) {
    return { result: 'unknown', distanceM: null, radiusM };
  }
  const d = Math.round(distanceM(lat, lng, targetLat, targetLng));
  return { result: d <= radiusM ? 'inside' : 'outside', distanceM: d, radiusM };
}

/**
 * A distance a guard can read at a glance. Metres up to a kilometre, then kilometres — "948466m"
 * is a number nobody parses, and the whole point of showing the distance is that the guard can
 * immediately tell "I'm at the wrong gate" from "I'm in the wrong city".
 */
export function formatDistance(m: number | null | undefined): string {
  if (m == null || !Number.isFinite(m)) return '';
  if (m < 1000) return `${Math.round(m)} m`;
  if (m < 10_000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000).toLocaleString('en-IN')} km`;
}

/** "00:42" / "2:05:11" — a countdown a guard can read at a glance without parsing units. */
export function formatCountdown(sec: number | null): string {
  if (sec == null || sec < 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** IST wall-clock "HH:mm" for an instant — the app shows site-local time, always IST. */
export function istTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return new Date(t + 330 * MS_MIN).toISOString().slice(11, 16);
}
