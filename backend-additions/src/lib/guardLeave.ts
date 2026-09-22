import { GuardAttendance } from '@/lib/models/GuardAttendance';
import { GuardFieldEvent } from '@/lib/models/GuardFieldEvent';
import { istDateKey } from '@/lib/guardRoster';

/**
 * Leave requests (PRD 18.12, SUR-GAP-021), shared by the online route and the offline sync so a
 * request made in a basement is judged by the same rules as one made on Wi-Fi.
 *
 * The rules (18.12 §8, 18.15.4):
 *  - no leave for a past date, **except** Sick or Emergency with a reason — accepted but flagged
 *    as retrospective, because a guard who fell ill yesterday still needs it recorded;
 *  - no overlap with a leave request that is still live;
 *  - no leave for a day the guard actually worked — an offline request for a shift they then
 *    checked into is rejected with a reason rather than silently double-counted.
 *
 * Balances count **days**, not requests. A three-day leave is three days.
 */

export const LEAVE_TYPES = ['casual', 'sick', 'emergency', 'unpaid'] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];

/** Annual entitlement by type. Agency-configurable in §20; these are the defaults. */
export const ENTITLEMENT: Record<LeaveType, number | null> = {
  casual: 12,
  sick: 7,
  emergency: 3,
  unpaid: null, // not a balance — it is unpaid
};

const LIVE_STATUSES = ['recorded', 'pending', 'approved', 'active'];
const MS_DAY = 24 * 3600_000;

export function isIsoDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

/** Inclusive day count between two YYYY-MM-DD dates. */
export function dayCount(from: string, to: string, halfDay = false): number {
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_DAY) + 1;
  return halfDay && days === 1 ? 0.5 : days;
}

export type LeaveCheck =
  | { ok: true; retrospective: boolean; days: number }
  | { ok: false; code: string; message: string };

export async function validateLeave(args: {
  guardId: string;
  type: string;
  from: string;
  to: string;
  reason: string;
  hasVoice: boolean;
  halfDay?: boolean;
  /** When re-validating an offline request, exclude the request itself from overlap checks. */
  excludeUuid?: string;
}): Promise<LeaveCheck> {
  const { guardId, from, to } = args;

  if (!LEAVE_TYPES.includes(args.type as LeaveType)) {
    return { ok: false, code: 'bad_type', message: 'Unknown leave type.' };
  }
  if (!isIsoDate(from) || !isIsoDate(to)) {
    return { ok: false, code: 'bad_date', message: 'Dates must be YYYY-MM-DD.' };
  }
  if (to < from) {
    return { ok: false, code: 'bad_range', message: 'The end date is before the start date.' };
  }

  const days = dayCount(from, to, args.halfDay);
  if (days > 60) {
    return { ok: false, code: 'too_long', message: 'A single request cannot exceed 60 days.' };
  }

  const today = istDateKey();
  const retrospective = from < today;
  if (retrospective) {
    const allowed = args.type === 'sick' || args.type === 'emergency';
    if (!allowed) {
      return { ok: false, code: 'past_date', message: 'Leave cannot start in the past.' };
    }
    if (!args.reason.trim() && !args.hasVoice) {
      return {
        ok: false,
        code: 'reason_required',
        message: 'A reason is needed for leave on a past date.',
      };
    }
  }

  // Overlap with any live request.
  const live: any[] = await GuardFieldEvent.find({
    guardId,
    kind: 'leave',
    status: { $in: LIVE_STATUSES },
    ...(args.excludeUuid ? { clientEventUuid: { $ne: args.excludeUuid } } : {}),
  })
    .select('fromDate toDate')
    .lean()
    .catch(() => []);

  const overlaps = live.some((l) => l.fromDate && l.toDate && l.fromDate <= to && from <= l.toDate);
  if (overlaps) {
    return { ok: false, code: 'overlap', message: 'You already have leave for some of these days.' };
  }

  // A day the guard actually checked in cannot also be leave (PRD 18.15.4).
  const worked: any[] = await GuardAttendance.find({
    guardId,
    eventType: 'check_in',
    shiftDate: { $gte: from, $lte: to },
  })
    .select('shiftDate')
    .limit(1)
    .lean()
    .catch(() => []);
  if (worked.length > 0) {
    return {
      ok: false,
      code: 'already_worked',
      message: `You were on duty on ${worked[0].shiftDate}, so it cannot be leave.`,
    };
  }

  return { ok: true, retrospective, days };
}

/** Days used per type this calendar year, from requests that are still live or approved. */
export async function leaveBalance(guardId: string) {
  const year = istDateKey().slice(0, 4);
  const rows: any[] = await GuardFieldEvent.find({
    guardId,
    kind: 'leave',
    status: { $in: LIVE_STATUSES },
    fromDate: { $regex: `^${year}` },
  })
    .select('fromDate toDate meta')
    .lean()
    .catch(() => []);

  const used: Record<string, number> = { casual: 0, sick: 0, emergency: 0, unpaid: 0 };
  for (const r of rows) {
    const t = (r.meta?.leaveType as string) ?? 'casual';
    used[t] = (used[t] ?? 0) + dayCount(r.fromDate, r.toDate, !!r.meta?.halfDay);
  }

  return LEAVE_TYPES.map((type) => {
    const entitled = ENTITLEMENT[type];
    return {
      type,
      entitled,
      used: used[type] ?? 0,
      left: entitled === null ? null : Math.max(0, entitled - (used[type] ?? 0)),
    };
  });
}
