import { create } from 'zustand';
import { api, ApiError, type CurrentAssignment, type DutyAlert, type DutyBundle, type TimelineItem, type ContractOffer } from '@/lib/api';
import { getDeviceId } from '@/lib/device';
import { computeDuty, type LocalDuty } from '@/lib/duty';
import { setDutyLocationSink } from '@/lib/dutyTracking';
import { armShiftReminders, armWakeChecks } from '@/lib/notifications';
import { flush, failedEvents, pending as pendingEvents, pendingCount } from '@/lib/queue';
import { pendingMediaCount } from '@/lib/media';
import { emitLocation, joinDutyRoom } from '@/lib/socket';
import { KEYS, store as kv } from '@/lib/storage';
import { guardId as gid, useAuth } from './auth';

/**
 * Duty state (PRD 18.3).
 *
 * One `/guard/today` bundle drives every duty screen, and the last one is cached so the Duty
 * Home renders in full with no network (SUR-GAP-008, 18.15.2). Between bundles the app reruns
 * the same state machine locally so the countdown ticks and an offline guard still sees an
 * enabled CHECK IN button; a fresh bundle always overrides that local guess.
 *
 * The older on-demand B2C booking is carried alongside as `booking` rather than replaced — the
 * same app serves both, but the roster is what the Duty Home is built on.
 */

export type Booking = {
  bookingId: string;
  bookingStatus: string;
  customerName?: string;
  serviceType?: string;
  location?: { address?: string; city?: string; lat?: number; lng?: number };
  schedule?: { date?: string; startTime?: string; endTime?: string };
  assignedGuard?: { etaMinutes?: number; assignedAt?: string };
  dutyDetails?: { arrivalOtp?: string; checkoutOtp?: string; dutyStartedAt?: string };
  [k: string]: any;
};

type DutyStore = {
  bundle: DutyBundle | null;
  current: CurrentAssignment | null;
  timeline: TimelineItem[];
  alerts: DutyAlert[];
  /** Locally recomputed between bundles so the countdown ticks and offline still works. */
  duty: LocalDuty;

  booking: Booking | null;
  contractOffers: ContractOffer[];
  activeContract: ContractOffer | null;
  online: boolean;

  offline: boolean;
  queued: number;
  mediaQueued: number;
  failed: number;
  lastError: string | null;
  hydrated: boolean;

  /** True when this phone is not the one bound to the account (SUR-GAP-006). */
  deviceBlocked: boolean;
  deviceStanding: string;

  hydrateBundle: () => Promise<void>;
  refresh: () => Promise<void>;
  tick: () => void;
  setOnline: (v: boolean, coords?: { lat: number; lng: number }) => Promise<void>;
  accept: () => Promise<void>;
  reject: (reason?: string) => Promise<void>;
  respondContract: (contractId: string, action: 'accept' | 'reject', reason?: string) => Promise<void>;
  pushLocation: (lat: number, lng: number, heading?: number) => Promise<void>;
  refreshQueued: () => Promise<void>;
  /** Optimistically mark the current shift checked in/out so the UI moves before the server replies. */
  markAttendance: (kind: 'in' | 'out', at?: string) => void;
};

const ACTIVE_BOOKING = ['ASSIGNED', 'EN_ROUTE', 'ARRIVED', 'ACTIVE', 'CHECKOUT_INITIATED'];

const IDLE_DUTY: LocalDuty = {
  state: 'no_duty',
  countdownSec: null,
  canCheckIn: false,
  canCheckOut: false,
  lateByMin: 0,
  earlyOutReasonRequired: false,
};

/** Apply check-in / check-out events that are still in the outbox to an assignment. */
async function withPendingAttendance(cur: CurrentAssignment): Promise<CurrentAssignment> {
  const pending = (await pendingEvents()).filter(
    (e) => (e.type === 'check_in' || e.type === 'check_out') && e.payload?.rosterId === cur.rosterId
  );
  if (pending.length === 0) return cur;
  const next = { ...cur };
  for (const e of pending) {
    if (e.type === 'check_in' && !next.checkedInAt) next.checkedInAt = e.device_time;
    if (e.type === 'check_out' && !next.checkedOutAt) next.checkedOutAt = e.device_time;
  }
  // The server's duty verdict predates these events, so recompute locally.
  return { ...next, duty: computeDuty(next) } as CurrentAssignment;
}

/** Remember which shift we already armed alarms for, so a poll every 8s does not re-arm. */
let armedForRosterId = '';
/** The wake list last armed; re-armed only when it changes. */
let armedWakeKey = '';

export const useDuty = create<DutyStore>((set, get) => ({
  bundle: null,
  current: null,
  timeline: [],
  alerts: [],
  duty: IDLE_DUTY,
  booking: null,
  contractOffers: [],
  activeContract: null,
  online: false,
  offline: false,
  queued: 0,
  mediaQueued: 0,
  failed: 0,
  lastError: null,
  hydrated: false,
  deviceBlocked: false,
  deviceStanding: 'ok',

  hydrateBundle: async () => {
    const cached = await kv.getJSON<DutyBundle | null>(KEYS.todayBundle, null);
    if (cached) {
      set({
        bundle: cached,
        current: cached.current,
        timeline: cached.timeline ?? [],
        alerts: cached.alerts ?? [],
        booking: (cached.booking as Booking) ?? null,
        contractOffers: cached.contractOffers ?? [],
        activeContract: cached.activeContract ?? null,
        online: !!cached.guard?.isOnline,
        duty: computeDuty(cached.current, new Date(), cached.booking),
        hydrated: true,
      });
    } else {
      set({ hydrated: true });
    }
    await get().refreshQueued();
  },

  refresh: async () => {
    const id = gid(useAuth.getState().guard);
    if (!id) return;

    try {
      // Send what is queued first, so the bundle we fetch already reflects a check-in made
      // seconds ago. Fetching first used to overwrite it with the pre-check-in state until the
      // next poll — long enough for a guard to think it failed and check in again.
      const flushedFirst = await flush(id).catch(() => null);
      if (flushedFirst && (flushedFirst.sent > 0 || flushedFirst.failed > 0)) await get().refreshQueued();

      const res = await api.today(id, await getDeviceId());
      const bundle = res.bundle;
      // Anything still waiting in the outbox (no network) is laid over the server's view.
      if (bundle.current) bundle.current = await withPendingAttendance(bundle.current);

      // An unapproved second phone gets an empty bundle. Do not cache it over the real one —
      // if the change is approved, the next poll restores everything; and if the guard is on
      // their own phone with a stale binding, they keep seeing their duty until it resolves.
      if (res.deviceBlocked) {
        set({
          deviceBlocked: true,
          deviceStanding: res.deviceStanding ?? 'blocked',
          alerts: bundle.alerts ?? [],
          offline: false,
          hydrated: true,
        });
        return;
      }
      set({ deviceBlocked: false, deviceStanding: 'ok' });

      await kv.setJSON(KEYS.todayBundle, bundle);
      set({
        bundle,
        current: bundle.current,
        timeline: bundle.timeline ?? [],
        alerts: bundle.alerts ?? [],
        booking: (bundle.booking as Booking) ?? null,
        contractOffers: bundle.contractOffers ?? [],
        activeContract: bundle.activeContract ?? null,
        online: !!bundle.guard?.isOnline,
        // The server's verdict wins the moment it arrives.
        duty: bundle.current?.duty ?? computeDuty(bundle.current, new Date(), bundle.booking),
        offline: false,
        lastError: null,
        hydrated: true,
      });

      if (bundle.booking && ACTIVE_BOOKING.includes(bundle.booking.bookingStatus)) {
        joinDutyRoom(bundle.booking.bookingId);
      }

      // Arm the night's wake prompts and the shift reminders from the server's schedule. These
      // are local alarms, so they still fire if the network dies afterwards. Shift reminders once
      // per shift; wake prompts whenever the server's list changes (a prompt added, answered or
      // suppressed by a patrol scan), which a once-per-shift arm used to miss until a restart.
      const cur = bundle.current;
      if (cur && cur.rosterId !== armedForRosterId) {
        armedForRosterId = cur.rosterId;
        if (!cur.checkedInAt) armShiftReminders(cur.startAt, cur.siteName).catch(() => {});
      }
      const wakeKey = cur
        ? `${cur.rosterId}|${(cur.wakeChecks ?? []).map((w) => `${w.wakeId}:${w.status}:${w.dueAt}`).join(',')}`
        : '';
      if (cur && wakeKey !== armedWakeKey) {
        armedWakeKey = wakeKey;
        armWakeChecks(cur.wakeChecks ?? []).catch(() => {});
      }

    } catch (e: any) {
      if (!useAuth.getState().guard) {
        await kv.del(KEYS.todayBundle);
        set({ bundle: null, current: null, booking: null, timeline: [], alerts: [], online: false,
          duty: IDLE_DUTY, offline: false, deviceBlocked: false, lastError: null });
        return;
      }
      // Offline is a normal state, not an error (PRD 18.17.1 rule 15). Fall back to the cache
      // and keep the local state machine running.
      set({ offline: !(e instanceof ApiError), lastError: e?.message ?? 'offline' });
      if (!get().bundle) await get().hydrateBundle();
      set({ duty: computeDuty(get().current, new Date(), get().booking) });
    }
  },

  tick: () => {
    const cur = get().current;
    const b = get().booking;
    if (!cur && !b) return;
    set({ duty: computeDuty(cur, new Date(), b) });
  },

  setOnline: async (v, coords) => {
    const id = gid(useAuth.getState().guard);
    if (!id) return;
    set({ online: v });
    try {
      await api.toggleOnline(id, v, coords);
    } catch (e: any) {
      set({ lastError: e?.message ?? 'Could not update status' });
    }
  },

  accept: async () => {
    const id = gid(useAuth.getState().guard);
    const b = get().booking;
    if (!id || !b) return;
    await api.acceptBooking(b.bookingId, id);
    await get().refresh();
  },

  reject: async (reason = 'Guard unavailable / declined') => {
    const id = gid(useAuth.getState().guard);
    const b = get().booking;
    if (!id || !b) return;
    await api.rejectBooking(b.bookingId, id, reason);
    await get().refresh();
  },

  respondContract: async (contractId: string, action: 'accept' | 'reject', reason?: string) => {
    const id = gid(useAuth.getState().guard);
    if (!id) return;
    await api.respondContract(contractId, id, action, reason);
    await get().refresh();
  },

  pushLocation: async (lat, lng, heading) => {
    const id = gid(useAuth.getState().guard);
    const b = get().booking;
    const cur = get().current;
    emitLocation({ dutyId: b?.bookingId ?? cur?.rosterId ?? '', lat, lng, heading });
    if (!id || !b) return;
    try {
      await api.postLocation(b.bookingId, id, lat, lng);
    } catch {
      /* the socket already carried the live fix; REST persistence retries next tick */
    }
  },

  refreshQueued: async () =>
    set({
      queued: await pendingCount(),
      mediaQueued: await pendingMediaCount(),
      failed: (await failedEvents()).length,
    }),

  markAttendance: (kind, at = new Date().toISOString()) => {
    const cur = get().current;
    if (!cur) return;
    const next: CurrentAssignment = {
      ...cur,
      checkedInAt: kind === 'in' ? at : cur.checkedInAt,
      checkedOutAt: kind === 'out' ? at : cur.checkedOutAt,
    };
    set({ current: next, duty: computeDuty(next) });
  },
}));

// Fixes from the on-duty location service (which may run with the app in the background).
setDutyLocationSink((lat, lng, heading) => {
  useDuty.getState().pushLocation(lat, lng, heading).catch(() => {});
});
