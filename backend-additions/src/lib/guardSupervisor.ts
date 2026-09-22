import mongoose from 'mongoose';
import { AgencyRoster } from '@/lib/models/AgencyRoster';
import { APGuard } from '@/lib/models/APGuard';
import { GuardAppProfile } from '@/lib/models/GuardAppProfile';
import { addDays, istDateKey, shiftWindow } from '@/lib/guardRoster';

/**
 * Supervisor (field) scope and authority (PRD 18.16, SUR-GAP-034).
 *
 * A supervisor uses the same app with an extra "My team" tab. What separates them from a guard is
 * authority over *other people's* records — approving a flagged check-in, marking someone present
 * by proxy — and both of those move money, so the grant is explicit and the scope is bounded:
 * a supervisor may only act on guards rostered to sites they cover today (PRD §31).
 */

export type SupervisorScope = {
  isSupervisor: boolean;
  canVerify: boolean;
  canProxy: boolean;
  canBroadcast: boolean;
  /** Site ids the supervisor covers today. */
  siteIds: string[];
  /** Site names, because the roster links to sites by name rather than id. */
  siteNames: string[];
  agencyId: string;
  guard: any | null;
};

const NO_SCOPE: SupervisorScope = {
  isSupervisor: false,
  canVerify: false,
  canProxy: false,
  canBroadcast: false,
  siteIds: [],
  siteNames: [],
  agencyId: '',
  guard: null,
};

/** Job titles that carry field-supervision authority when no explicit grant exists yet. */
const SUPERVISOR_TITLES = /supervisor|field officer|gate inspector/i;

export async function resolveSupervisorScope(guardId: string): Promise<SupervisorScope> {
  if (!mongoose.Types.ObjectId.isValid(guardId)) return NO_SCOPE;

  const guard: any = await APGuard.findById(guardId).lean().catch(() => null);
  if (!guard) return NO_SCOPE;

  const profile: any = await GuardAppProfile.findOne({ guardId }).lean().catch(() => null);

  // An explicit grant wins; a supervisory job title is the fallback so agencies that have not
  // touched the new field yet are not locked out of the tab entirely.
  const isSupervisor = profile?.isSupervisor === true || SUPERVISOR_TITLES.test(String(guard.type ?? ''));
  if (!isSupervisor) return NO_SCOPE;

  const perms: string[] = profile?.permissions ?? [];
  // With no per-permission list configured, a supervisor gets the full 18.16 capability set.
  const unset = perms.length === 0;

  const today = istDateKey();
  const myRosters: any[] = await AgencyRoster.find({
    date: { $in: [addDays(today, -1), today] },
    'assignedGuards.guardId': guardId,
  })
    .lean()
    .catch(() => []);

  const siteNames = new Set<string>(myRosters.map((r) => String(r.siteName)).filter(Boolean));
  const siteIds = new Set<string>((profile?.supervisorSiteIds ?? []).map(String));

  return {
    isSupervisor: true,
    canVerify: unset || perms.includes('attendance.verify'),
    canProxy: unset || perms.includes('attendance.proxy'),
    canBroadcast: unset || perms.includes('notice.broadcast'),
    siteIds: [...siteIds],
    siteNames: [...siteNames],
    agencyId: guard.agencyId ?? '',
    guard,
  };
}

/**
 * The roster rows in the supervisor's scope for a given day. Matching is by site *name* because
 * that is what AgencyRoster carries; explicitly-granted site ids are resolved to names first.
 */
export async function scopedRosters(scope: SupervisorScope, dateKey: string): Promise<any[]> {
  if (!scope.isSupervisor) return [];

  const names = new Set(scope.siteNames.map((n) => n.toLowerCase()));

  // Granted site ids → names, so an agency can scope a supervisor to sites they do not work at.
  if (scope.siteIds.length > 0) {
    const Site = (await import('@/lib/models/Site')).default;
    const sites: any[] = await Site.find({ _id: { $in: scope.siteIds } })
      .select('name')
      .lean()
      .catch(() => []);
    sites.forEach((s) => names.add(String(s.name).toLowerCase()));
  }

  if (names.size === 0) return [];

  const rosters: any[] = await AgencyRoster.find({
    date: { $in: [addDays(dateKey, -1), dateKey] },
    ...(scope.agencyId ? { agencyId: scope.agencyId } : {}),
  })
    .lean()
    .catch(() => []);

  return rosters.filter((r) => names.has(String(r.siteName).toLowerCase()));
}

/** Is this guard someone the supervisor is allowed to act on today? */
export async function guardIsInScope(scope: SupervisorScope, subjectGuardId: string): Promise<boolean> {
  if (!scope.isSupervisor) return false;
  const today = istDateKey();
  const rosters = await scopedRosters(scope, today);
  return rosters.some((r) =>
    (r.assignedGuards ?? []).some((g: any) => String(g.guardId) === String(subjectGuardId))
  );
}

/**
 * The live state chip for one guard on one shift (PRD 18.16): On duty / Late / Absent /
 * Not checked in / Checked out. Computed from the shift window and the attendance events, so it
 * matches exactly what the guard's own Duty Home is showing them.
 */
export function teamMemberState(args: {
  roster: any;
  checkedInAt: Date | null;
  checkedOutAt: Date | null;
  lateByMin: number;
  now?: Date;
}): 'Scheduled' | 'On duty' | 'Late' | 'Absent' | 'Not checked in' | 'Checked out' {
  const now = args.now ?? new Date();
  const w = shiftWindow(args.roster.date, args.roster.timing);

  if (args.checkedOutAt) return 'Checked out';
  if (args.checkedInAt) return args.lateByMin > 0 ? 'Late' : 'On duty';

  const t = now.getTime();
  if (t < w.startAt.getTime()) return 'Scheduled';
  // An hour past the start with no check-in is the Absent threshold (PRD 18.5 §9).
  if (t > w.startAt.getTime() + 60 * 60_000) return 'Absent';
  return 'Not checked in';
}
