import { NextResponse } from 'next/server';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { connectToDatabase } from '@/lib/db';
import { APGuard } from '@/lib/models/APGuard';
import { Booking } from '@/lib/models/BookingState';
import { AgencyRoster } from '@/lib/models/AgencyRoster';
import AgencyContract from '@/lib/models/AgencyContract';
import { PatrolCheckpoint, PatrolRound } from '@/lib/models/Patrol';
import { GuardAttendance } from '@/lib/models/GuardAttendance';
import { GuardNotification } from '@/lib/models/GuardNotification';
import { GuardAppProfile } from '@/lib/models/GuardAppProfile';
import { GuardWakeSchedule } from '@/lib/models/GuardWakeSchedule';
import { GuardReplacementOffer } from '@/lib/models/GuardReplacement';
import { deviceStanding } from '@/lib/guardDevice';
import { effectiveStatus } from '@/lib/guardDocuments';
import {
  addDays,
  briefingCards,
  dutyPolicy,
  dutyState,
  generatePatrolRoundTimes,
  generateWakeTimes,
  istDateKey,
  resolveSite,
  shiftWindow,
  type ResolvedSite,
} from '@/lib/guardRoster';

export const dynamic = 'force-dynamic';

/**
 * The duty bundle (PRD 18.3 §10 / SUR-GAP-008): assignment, site, geofence, checkpoints,
 * briefing, patrol schedule, wake schedule, notices and pending actions in ONE round trip, so
 * the Duty Home renders fully from cache with no network (18.15.2).
 *
 * This is roster-driven. The Guard App is a rostered-duty tool: every screen derives from an
 * AgencyRoster row joined to its Site and the site's guard-app overlay. The older on-demand
 * Booking is still returned alongside as `booking`, because the same app serves B2C on-demand
 * duties — but it is no longer the thing the Duty Home is built on.
 *
 * Yesterday's roster is deliberately included: a 20:00–08:00 shift rostered on the 12th is still
 * the guard's live duty at 03:00 on the 13th (PRD 18.3 §16 — the Duty screen belongs to the
 * shift, not the calendar day).
 */

type Assignment = {
  rosterId: string;
  date: string;
  siteName: string;
  siteId: string;
  shiftType: string;
  timing: string;
  start: string;
  end: string;
  startAt: string;
  endAt: string;
  crossesMidnight: boolean;
  durationMin: number;
  rosterStatus: string;
  isReliever: boolean;
  replacedGuardName: string;
  site: {
    name: string;
    address: string;
    lat: number | null;
    lng: number | null;
    geofenceRadiusM: number;
    geoKnown: boolean;
    reportingPoint: string;
    uniformRequired: string;
    equipmentRequired: string[];
    escalationContacts: { name: string; phone: string; role: string }[];
    sirenEnabled: boolean;
  };
  briefing: { version: number; cards: { text: string; imageUrl: string; order: number }[] };
  policy: ReturnType<typeof dutyPolicy>;
  wakeCheckEnabled: boolean;
  checkedInAt: string | null;
  checkedOutAt: string | null;
  duty: ReturnType<typeof dutyState>;
};

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const guardId = searchParams.get('guardId');
    if (!guardId) {
      return NextResponse.json({ success: false, message: 'guardId required' }, { status: 400 });
    }
    if (!mongoose.Types.ObjectId.isValid(guardId)) {
      return NextResponse.json({ success: false, action: 'LOGOUT', message: 'Invalid guardId' }, { status: 400 });
    }

    await connectToDatabase();
    const guard: any = await APGuard.findById(guardId).lean();
    if (!guard) {
      return NextResponse.json({ success: false, action: 'LOGOUT', message: 'Guard not found' });
    }

    /**
     * Device binding (PRD 18.1 §9, SUR-GAP-006): duty data is withheld from an unapproved second
     * device until an Operations Manager approves the change. Checked on every fetch rather than
     * at login, so revoking a device bites on its next poll.
     *
     * What is deliberately *not* withheld: the guard's identity, SOS, and help. A guard whose
     * device change is pending must still be able to raise an alarm — locking them out of that
     * would turn a fraud control into a safety hazard.
     */
    const device = await deviceStanding(guardId, searchParams.get('deviceId'));
    if (!device.allowed) {
      return NextResponse.json({
        success: true,
        deviceBlocked: true,
        deviceStanding: device.standing,
        bundle: {
          serverTime: new Date().toISOString(),
          guard: { _id: guard._id, name: guard.name, phone: guard.phone },
          assignments: [],
          current: null,
          timeline: [],
          alerts: [
            {
              key: 'device_change_pending',
              severity: 'danger',
              label:
                device.standing === 'change_pending'
                  ? 'New phone — waiting for your agency to approve'
                  : 'This phone is not approved for your account',
              route: '/help',
            },
          ],
          booking: null,
          offers: [],
          recentAttendance: [],
          notifications: [],
          pendingActions: [],
        },
      });
    }

    const now = new Date();
    const today = istDateKey(now);
    // Yesterday through +3 days: yesterday for a still-running night shift, +3 for the
    // offline duty-bundle horizon (PRD 18.15.1).
    const dateKeys = [addDays(today, -1), today, addDays(today, 1), addDays(today, 2), addDays(today, 3)];

    const rosters: any[] = await AgencyRoster.find({
      date: { $in: dateKeys },
      'assignedGuards.guardId': guardId,
    })
      .sort({ date: 1 })
      .lean()
      .catch(() => []);

    // Resolve each distinct site once, not once per shift.
    const siteCache = new Map<string, ResolvedSite>();
    const siteFor = async (agencyId: string, siteName: string) => {
      const key = `${agencyId}::${siteName}`;
      if (!siteCache.has(key)) siteCache.set(key, await resolveSite(agencyId, siteName));
      return siteCache.get(key)!;
    };
    // Keyed by roster row, so the second lookup for the current shift cannot resolve against a
    // different agencyId than the one the assignment was built with.
    const resolvedByRoster = new Map<string, ResolvedSite>();

    const rosterIds = rosters.map((r) => String(r._id));
    const attendance: any[] = rosterIds.length
      ? await GuardAttendance.find({ guardId, rosterId: { $in: rosterIds } })
          .sort({ serverReceivedTime: 1 })
          .lean()
          .catch(() => [])
      : [];

    const firstEvent = (rosterId: string, type: string) =>
      attendance.find((a) => a.rosterId === rosterId && a.eventType === type) ?? null;

    const assignments: Assignment[] = [];
    for (const r of rosters) {
      const mine = (r.assignedGuards ?? []).find((g: any) => String(g.guardId) === guardId);
      if (!mine || !['Accepted', 'Scheduled', 'Active'].includes(mine.status)) {
        continue;
      }
      if (r.contractId && (!activeContractDocForGuard || String(activeContractDocForGuard._id) !== String(r.contractId))) {
        continue;
      }
      const resolved = await siteFor(r.agencyId ?? guard.agencyId ?? '', r.siteName);
      const w = shiftWindow(r.date, r.timing);
      const policy = dutyPolicy(resolved.config);
      const rosterId = String(r._id);
      resolvedByRoster.set(rosterId, resolved);

      const inEvt = firstEvent(rosterId, 'check_in');
      const outEvt = firstEvent(rosterId, 'check_out');
      const checkedInAt = inEvt ? new Date(inEvt.estimatedTrueTime ?? inEvt.serverReceivedTime ?? inEvt.deviceTime) : null;
      const checkedOutAt = outEvt ? new Date(outEvt.estimatedTrueTime ?? outEvt.serverReceivedTime ?? outEvt.deviceTime) : null;

      assignments.push({
        rosterId,
        date: r.date,
        siteName: resolved.siteName || r.siteName,
        siteId: resolved.siteId,
        shiftType: r.shiftType ?? '',
        timing: r.timing ?? '',
        start: w.start,
        end: w.end,
        startAt: w.startAt.toISOString(),
        endAt: w.endAt.toISOString(),
        crossesMidnight: w.crossesMidnight,
        durationMin: w.durationMin,
        rosterStatus: mine?.status ?? 'Scheduled',
        isReliever: !!mine?.isReliever,
        replacedGuardName: mine?.replacedGuardName ?? '',
        site: {
          name: resolved.siteName || r.siteName,
          address: resolved.address,
          lat: resolved.lat,
          lng: resolved.lng,
          geofenceRadiusM: resolved.geofenceRadiusM,
          geoKnown: resolved.geoKnown,
          reportingPoint: resolved.config?.reportingPoint ?? '',
          uniformRequired: resolved.config?.uniformRequired ?? '',
          equipmentRequired: resolved.config?.equipmentRequired ?? [],
          escalationContacts: resolved.config?.escalationContacts ?? [],
          sirenEnabled: resolved.config?.sirenEnabled ?? true,
        },
        briefing: {
          version: resolved.config?.briefingVersion ?? 1,
          cards: briefingCards(resolved),
        },
        policy,
        wakeCheckEnabled: !!resolved.config?.wakeCheckEnabled,
        checkedInAt: checkedInAt ? checkedInAt.toISOString() : null,
        checkedOutAt: checkedOutAt ? checkedOutAt.toISOString() : null,
        duty: dutyState({ window: w, policy, checkedInAt, checkedOutAt, now }),
      });
    }

    /**
     * Pick the assignment the Duty Home should show, in priority order:
     *   1. a shift already checked into and not closed out
     *   2. a shift whose check-in window is open right now
     *   3. a shift whose own window still contains "now" — the guard is standing on their post
     *      having missed the check-in window entirely. Leaving this case out is how a guard who
     *      is 90 minutes late ends up with a blank Duty screen during their own shift, with no
     *      way to mark attendance at all.
     *   4. the soonest future shift, for the countdown
     * A guard is never shown two live shifts (BR-001 forbids overlap).
     */
    const nowMs = now.getTime();
    const live = assignments.find((a) => a.checkedInAt && !a.checkedOutAt);
    const openNow = assignments.find((a) => a.duty.canCheckIn);
    const inWindow = assignments.find((a) => {
      if (a.checkedOutAt) return false;
      const start = Date.parse(a.startAt) - a.policy.checkInWindowBeforeMin * 60_000;
      const end = Date.parse(a.endAt) + a.policy.autoCloseAfterMin * 60_000;
      return nowMs >= start && nowMs <= end;
    });
    const upcoming = assignments
      .filter((a) => !a.checkedOutAt && Date.parse(a.startAt) >= nowMs)
      .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))[0];
    const current = live ?? openNow ?? inWindow ?? upcoming ?? null;

    // --- Everything below is scoped to the current assignment only ---
    let checkpoints: any[] = [];
    let patrolRounds: any[] = [];
    let wakeChecks: any[] = [];

    if (current) {
      const w = shiftWindow(current.date, current.timing);
      const resolved = resolvedByRoster.get(current.rosterId)!;

      if (current.siteId) {
        checkpoints = (
          await PatrolCheckpoint.find({ siteId: current.siteId }).sort({ order: 1 }).lean().catch(() => [])
        ).map((c: any) => ({
          checkpointId: String(c._id),
          name: c.name,
          scanCode: c.scanCode,
          scanType: c.scanType ?? 'QR',
          order: c.order ?? 1,
        }));

        const persisted: any[] = await PatrolRound.find({
          siteId: current.siteId,
          scheduledDate: { $in: [current.date, addDays(current.date, 1)] },
          $or: [{ guardId }, { guardId: '' }],
        })
          .sort({ scheduledTime: 1 })
          .lean()
          .catch(() => []);

        if (persisted.length > 0) {
          patrolRounds = persisted.map((p: any) => ({
            roundId: String(p._id),
            scheduledDate: p.scheduledDate,
            scheduledTime: p.scheduledTime ?? '',
            status: p.status,
            checkpointIds: p.checkpointIds ?? [],
            scans: (p.scans ?? []).map((s: any) => ({ checkpointId: s.checkpointId, scannedAt: s.scannedAt })),
            generated: false,
          }));
        } else {
          // No rounds authored for this site/date — hand the app the site's configured cadence
          // as an advisory schedule so it can still show "next round in 00:23". Nothing is
          // persisted here: round authoring belongs to the agency portal.
          patrolRounds = generatePatrolRoundTimes(w, resolved.config).map((t, i) => ({
            roundId: `gen:${current.rosterId}:${i}`,
            scheduledDate: current.date,
            scheduledTime: t.toISOString(),
            status: 'Scheduled',
            checkpointIds: checkpoints.map((c) => c.checkpointId),
            scans: [],
            generated: true,
          }));
        }
      }

      wakeChecks = await ensureWakeSchedule({
        guardId,
        guard,
        assignment: current,
        resolved,
        window: w,
      });
    }

    // --- The on-demand booking path, unchanged, for B2C duties ---
    const booking = await Booking.findOne({
      $or: [
        { bookingStatus: 'PENDING_ACCEPTANCE', dispatchedGuardIds: guardId },
        { bookingStatus: 'PENDING_ACCEPTANCE', pendingGuardId: guardId },
        {
          bookingStatus: { $in: ['ASSIGNED', 'EN_ROUTE', 'ARRIVED', 'ACTIVE', 'CHECKOUT_INITIATED'] },
          'assignedGuard.guardId': guardId,
        },
      ],
    })
      .sort({ createdAt: -1 })
      .lean()
      .catch(() => null);

    const [recentAttendance, notifications, profile, offers, pendingContracts, activeContractDoc] = await Promise.all([
      GuardAttendance.find({ guardId }).sort({ createdAt: -1 }).limit(10).lean().catch(() => []),
      GuardNotification.find({ guardId }).sort({ createdAt: -1 }).limit(10).lean().catch(() => []),
      GuardAppProfile.findOne({ guardId }).lean().catch(() => null),
      // Live replacement offers ride in the bundle so the Duty Home can surface them even if the
      // push notification was missed — PRD 18.12 §12 pairs push with a fallback for exactly this.
      GuardReplacementOffer.find({ guardId, status: 'pending', expiresAt: { $gt: now } })
        .sort({ expiresAt: 1 })
        .limit(5)
        .lean()
        .catch(() => []),
      AgencyContract.find({
        status: { $in: ['Active', 'Draft'] },
        assignedGuards: {
          $elemMatch: {
            guardId,
            status: { $in: ['Pending', undefined] }
          }
        }
      }).lean().catch(() => []),
      AgencyContract.findOne({
        status: 'Active',
        assignedGuards: {
          $elemMatch: {
            guardId,
            status: 'Accepted'
          }
        }
      }).lean().catch(() => null),
    ]);

    const contractOffers = (pendingContracts as any[]).map((c: any) => {
      const clientName = c.client || c.clientName || 'Client';
      const siteDisplay = (!c.site || c.site === 'All Sites') ? (c.title ? `${c.title} (${clientName})` : clientName) : c.site;
      return {
        contractId: String(c._id),
        contractCode: `CNT-${String(c._id).slice(-4).toUpperCase()}`,
        title: c.title || 'Security Contract',
        client: clientName,
        site: siteDisplay,
        startDate: c.startDate,
        endDate: c.endDate || 'Ongoing',
        shiftTiming: c.shiftTiming || `${c.shiftHours || 12}h Shift`,
        shiftHours: c.shiftHours || 8,
        ratePerGuard: c.ratePerGuard,
      };
    });

    const activeContract = activeContractDoc ? {
      contractId: String((activeContractDoc as any)._id),
      title: (activeContractDoc as any).title,
      client: (activeContractDoc as any).client,
      site: (activeContractDoc as any).site || 'Main Site',
      startDate: (activeContractDoc as any).startDate,
      endDate: (activeContractDoc as any).endDate || 'Ongoing',
      shiftTiming: (activeContractDoc as any).shiftTiming || `${(activeContractDoc as any).shiftHours || 12}h Shift`,
      shiftHours: (activeContractDoc as any).shiftHours || 8,
    } : null;

    const alerts = buildAlerts(guard, profile, current, notifications, offers);

    const bundle = {
      serverTime: now.toISOString(),
      todayKey: today,
      guard,
      assignments,
      current: current
        ? {
            ...current,
            checkpoints,
            patrolRounds,
            wakeChecks,
          }
        : null,
      timeline: buildTimeline(current, patrolRounds, wakeChecks),
      alerts,
      booking: booking ?? null,
      contractOffers,
      activeContract,
      offers: offers.map((o: any) => ({
        offerId: String(o._id),
        vacancyId: o.vacancyId,
        siteName: o.siteName,
        siteId: o.siteId,
        shiftDate: o.shiftDate,
        timing: o.timing,
        shiftType: o.shiftType,
        incentivePaise: o.incentivePaise ?? 0,
        distanceKm: o.distanceKm ?? null,
        expiresAt: o.expiresAt,
        status: o.status,
      })),
      recentAttendance,
      notifications,
      /** Kept for the older app builds that read `pendingActions` rather than `alerts`. */
      pendingActions: alerts.map((a) => ({ key: a.key, label: a.label })),
    };

    // ETag so the app can revalidate the bundle cheaply (PRD 18.3 §10).
    //
    // Hashing the whole bundle would never match: `serverTime` and every `countdownSec` move on
    // each request, so the ETag would change once a second and revalidation would save nothing.
    // Hash only what the guard would actually see change.
    const etag = `"${crypto.createHash('sha1').update(materialState(bundle)).digest('hex').slice(0, 24)}"`;
    if (req.headers.get('if-none-match') === etag) {
      return new NextResponse(null, { status: 304, headers: { ETag: etag } });
    }

    return NextResponse.json({ success: true, bundle }, { headers: { ETag: etag } });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'today failed' }, { status: 500 });
  }
}

/**
 * The part of the bundle that is genuinely *state* rather than clock — what the ETag is computed
 * over. Deliberately excludes `serverTime` and every derived countdown, and keeps the ordering
 * fixed so an unchanged shift always hashes the same.
 */
function materialState(bundle: any): string {
  const c = bundle.current;
  return JSON.stringify({
    guard: [bundle.guard?._id, bundle.guard?.status, bundle.guard?.pvStatus, bundle.guard?.kycVerified],
    assignments: (bundle.assignments ?? []).map((a: Assignment) => [
      a.rosterId,
      a.date,
      a.timing,
      a.siteId,
      a.rosterStatus,
      a.checkedInAt,
      a.checkedOutAt,
      a.briefing.version,
    ]),
    current: c
      ? [
          c.rosterId,
          c.site.lat,
          c.site.lng,
          c.site.geofenceRadiusM,
          (c.checkpoints ?? []).map((k: any) => k.checkpointId),
          (c.patrolRounds ?? []).map((r: any) => [r.roundId, r.status, (r.scans ?? []).length]),
          (c.wakeChecks ?? []).map((w: any) => [w.wakeId, w.status]),
        ]
      : null,
    alerts: (bundle.alerts ?? []).map((a: any) => [a.key, a.label]),
    offers: (bundle.offers ?? []).map((o: any) => [o.offerId, o.status]),
    booking: bundle.booking ? [bundle.booking.bookingId, bundle.booking.bookingStatus] : null,
    notifications: (bundle.notifications ?? []).map((n: any) => String(n._id)),
  });
}

/**
 * Generate-once-then-read the night's wake prompts. Regenerating on every bundle fetch would
 * move the prompt times each time the app polled — which would both defeat the randomisation and
 * break the device's already-armed local alarms. The unique (guardId, dueAt) index makes the
 * insert idempotent under concurrent fetches.
 */
async function ensureWakeSchedule(args: {
  guardId: string;
  guard: any;
  assignment: Assignment;
  resolved: ResolvedSite;
  window: ReturnType<typeof shiftWindow>;
}) {
  const { guardId, guard, assignment, resolved, window: w } = args;

  const existing: any[] = await GuardWakeSchedule.find({ guardId, rosterId: assignment.rosterId })
    .sort({ dueAt: 1 })
    .lean()
    .catch(() => []);

  if (existing.length > 0) return existing.map(shapeWake);
  if (!resolved.config?.wakeCheckEnabled) return [];

  const times = generateWakeTimes(w, resolved.config, assignment.date);
  if (times.length === 0) return [];

  const docs = times.map((dueAt) => ({
    guardId,
    rosterId: assignment.rosterId,
    shiftDate: assignment.date,
    siteId: assignment.siteId,
    siteName: assignment.siteName,
    agencyId: guard.agencyId ?? '',
    dueAt,
    ackWindowSec: resolved.config?.wakeAckWindowSec ?? 120,
    selfieRequired: !!resolved.config?.wakeSelfieRequired,
    status: 'pending',
  }));

  // ordered:false so a duplicate from a concurrent fetch does not drop the rest.
  await GuardWakeSchedule.insertMany(docs, { ordered: false }).catch(() => {});
  const created: any[] = await GuardWakeSchedule.find({ guardId, rosterId: assignment.rosterId })
    .sort({ dueAt: 1 })
    .lean()
    .catch(() => []);
  return created.map(shapeWake);
}

function shapeWake(d: any) {
  return {
    wakeId: String(d._id),
    dueAt: d.dueAt,
    ackWindowSec: d.ackWindowSec ?? 120,
    selfieRequired: !!d.selfieRequired,
    status: d.status,
    acknowledgedAt: d.acknowledgedAt ?? null,
  };
}

/** The Duty Home's timeline strip: check-in ✓ · patrol 1 ✓ · wake ○ · check-out ○ (PRD 18.3 §5). */
function buildTimeline(current: Assignment | null, rounds: any[], wakes: any[]) {
  if (!current) return [];
  const items: { key: string; label: string; done: boolean; at: string | null; route: string }[] = [
    { key: 'check_in', label: 'Check-in', done: !!current.checkedInAt, at: current.checkedInAt, route: '/checkin?mode=in' },
  ];

  rounds.forEach((r, i) => {
    items.push({
      key: `patrol:${r.roundId}`,
      label: `Patrol ${i + 1}`,
      done: r.status === 'Completed' || (r.scans?.length ?? 0) >= (r.checkpointIds?.length ?? 1),
      at: r.scheduledTime ?? null,
      route: '/patrol',
    });
  });

  wakes.forEach((k, i) => {
    items.push({
      key: `wake:${k.wakeId}`,
      label: `Wake check ${i + 1}`,
      done: k.status === 'acknowledged' || k.status === 'acknowledged_late' || k.status === 'suppressed',
      at: k.dueAt,
      route: '/wake',
    });
  });

  items.push({
    key: 'check_out',
    label: 'Check-out',
    done: !!current.checkedOutAt,
    at: current.checkedOutAt,
    route: '/checkin?mode=out',
  });
  return items;
}

/** The alert strip: zero to three things the guard can resolve in one tap (PRD 18.3 §5). */
function buildAlerts(
  guard: any,
  profile: any,
  current: Assignment | null,
  notifications: any[],
  offers: any[] = []
) {
  // `label` is the English fallback; the app translates by `key`, filling in `count` / `site`.
  const alerts: {
    key: string;
    severity: 'info' | 'warn' | 'danger';
    label: string;
    route: string;
    count?: number;
    site?: string;
  }[] = [];

  // A live offer outranks everything else on the strip — it expires, the rest do not.
  if (offers.length > 0) {
    alerts.push({
      key: offers.length === 1 ? 'replacement_offer' : 'replacement_offers',
      severity: 'info',
      label:
        offers.length === 1
          ? `Extra duty offered: ${offers[0].siteName}`
          : `${offers.length} extra duties offered`,
      route: '/offers',
      count: offers.length,
      site: offers[0].siteName ?? '',
    });
  }

  // Expiry is computed at read time (a stored "Verified" can be past its date).
  const docs: any[] = (profile?.documents ?? []).map((d: any) => ({ ...d, status: effectiveStatus(d) }));
  const expiring = docs.filter((d) => d.status === 'Expiring');
  const expired = docs.filter((d) => d.status === 'Expired' || d.status === 'Rejected');
  if (expired.length > 0) {
    alerts.push({ key: 'documents_expired', severity: 'danger', label: `${expired.length} document(s) need attention`, route: '/documents', count: expired.length });
  } else if (expiring.length > 0) {
    alerts.push({ key: 'documents_expiring', severity: 'warn', label: `${expiring.length} document(s) expiring soon`, route: '/documents', count: expiring.length });
  } else if (docs.length === 0 || !guard?.kycVerified) {
    alerts.push({ key: 'documents_pending', severity: 'warn', label: 'Documents pending', route: '/documents' });
  }

  if (guard?.pvStatus && guard.pvStatus !== 'PV Done') {
    alerts.push({ key: 'police_verification', severity: 'warn', label: 'Police verification pending', route: '/documents' });
  }

  const unread = (notifications ?? []).filter((n: any) => !n.read && !n.isRead).length;
  if (unread > 0) {
    alerts.push({ key: 'notices', severity: 'info', label: `${unread} unread notice(s)`, route: '/notices', count: unread });
  }

  if (current?.duty.state === 'absent' && !current.checkedInAt) {
    alerts.push({ key: 'not_checked_in', severity: 'danger', label: 'You have not checked in', route: '/checkin?mode=in' });
  }

  return alerts.slice(0, 3);
}
