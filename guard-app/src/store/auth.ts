import * as Crypto from 'expo-crypto';
import { create } from 'zustand';
import { api } from '@/lib/api';
import { getDeviceId } from '@/lib/device';
import { stopDutyTracking } from '@/lib/dutyTracking';
import { pendingCount } from '@/lib/queue';
import { destroyStoreKey } from '@/lib/secureStore';
import { KEYS, secure, store } from '@/lib/storage';
import { clearSession, loadSession, onSignedOut, revokeSession, saveSession } from '@/lib/session';

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

export type Guard = {
  _id: string;
  id?: string;
  guardId?: string;
  name: string;
  phone: string;
  city?: string;
  type?: string;
  agencyId?: string;
  agencyName?: string;
  status?: string;
  isOnline?: boolean;
  profilePhoto?: string;
  pvStatus?: string;
  kycVerified?: boolean;
  wage?: string;
  [k: string]: any;
};

type AuthState = {
  hydrated: boolean;
  guard: Guard | null;
  needsPin: boolean; // true when a PIN unlock is required (fresh launch / 12h idle)
  hasPin: boolean;

  hydrate: () => Promise<void>;
  setGuard: (g: Guard, session?: { token: string | null; expiresAt: number | null }) => Promise<void>;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;

  setPin: (pin: string) => Promise<void>;
  verifyPin: (pin: string) => Promise<boolean>;
  markUnlocked: () => Promise<void>;
  touch: () => Promise<void>;
  lockIfIdle: () => Promise<boolean>;
};

async function hashPin(pin: string) {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `sg-pin:${pin}`);
}

export const useAuth = create<AuthState>((set, get) => ({
  hydrated: false,
  guard: null,
  needsPin: false,
  hasPin: false,

  hydrate: async () => {
    await getDeviceId(); // ensure a device id exists early
    await loadSession();
    // The server ended this login (logged out elsewhere, phone unlinked): sign out locally.
    onSignedOut(() => {
      secure.del(KEYS.guard).catch(() => {});
      store.del(KEYS.todayBundle).catch(() => {});
      stopDutyTracking().catch(() => {});
      set({ guard: null, needsPin: false });
    });
    const raw = await secure.get(KEYS.guard);
    const guard = raw ? (JSON.parse(raw) as Guard) : null;
    const pinHash = await secure.get(KEYS.pinHash);
    const lastLoginAt = await store.getJSON<number>(KEYS.lastLoginAt, 0);
    const idleTooLong = Date.now() - lastLoginAt > TWELVE_HOURS_MS;
    // A guard who is checked in (per the cached bundle) is never stopped by a PIN on launch.
    const cached = await store.getJSON<any>(KEYS.todayBundle, null).catch(() => null);
    const onShift = !!cached?.current?.checkedInAt && !cached?.current?.checkedOutAt;
    set({
      hydrated: true,
      guard,
      hasPin: !!pinHash,
      needsPin: !!guard && !!pinHash && idleTooLong && !onShift,
    });
  },

  setGuard: async (g, session) => {
    await secure.set(KEYS.guard, JSON.stringify(g));
    if (session) await saveSession(session.token, session.expiresAt);
    await store.setJSON(KEYS.lastLoginAt, Date.now());
    set({ guard: g, needsPin: false });
  },

  refresh: async () => {
    const g = get().guard;
    if (!g?._id) return;
    try {
      const res = await api.me(g._id);
      if (res.guard) {
        const merged = { ...g, ...res.guard };
        await secure.set(KEYS.guard, JSON.stringify(merged));
        set({ guard: merged });
      }
    } catch {
      /* keep cached guard offline */
    }
  },

  logout: async () => {
    // Location must not outlive the signed-in guard (PRD §39).
    await stopDutyTracking();
    // End the session on the server too, so this phone's token cannot be reused.
    await revokeSession();
    await clearSession();
    await secure.del(KEYS.guard);
    await store.del(KEYS.todayBundle);

    /**
     * Destroying the store key makes everything left on the device unreadable (PRD §39). But it
     * would also make *unsent duty records* unreadable, and 18.15.3 is clear that queued events
     * are never evicted — a guard logging out on a bad network must not lose the shift they just
     * worked. So the key only goes when there is nothing left to lose.
     */
    const stillQueued = await pendingCount().catch(() => 1);
    if (stillQueued === 0) {
      await destroyStoreKey();
    }

    set({ guard: null, needsPin: false });
  },

  setPin: async (pin) => {
    await secure.set(KEYS.pinHash, await hashPin(pin));
    await store.setJSON(KEYS.lastLoginAt, Date.now());
    set({ hasPin: true, needsPin: false });
  },

  verifyPin: async (pin) => {
    const stored = await secure.get(KEYS.pinHash);
    const ok = !!stored && stored === (await hashPin(pin));
    if (ok) await get().markUnlocked();
    return ok;
  },

  markUnlocked: async () => {
    await store.setJSON(KEYS.lastLoginAt, Date.now());
    set({ needsPin: false });
  },

  /**
   * The guard stays signed in until they log out. The PIN is only asked after 12 hours of not
   * using the app — "last use", not "last unlock": counting from the unlock made a guard who
   * uses the app all day type the PIN every 12 hours anyway.
   */
  touch: async () => {
    if (!get().guard || get().needsPin) return;
    await store.setJSON(KEYS.lastLoginAt, Date.now());
  },

  /** On returning to the app: true (and PIN required) when it sat unused for 12 hours. */
  lockIfIdle: async () => {
    const { guard, hasPin } = get();
    if (!guard || !hasPin) return false;
    const last = await store.getJSON<number>(KEYS.lastLoginAt, 0);
    if (Date.now() - last <= TWELVE_HOURS_MS) return false;
    set({ needsPin: true });
    return true;
  },
}));

/** guardId helper — the backend keys everything on the Mongo _id. */
export function guardId(g: Guard | null): string {
  return g?._id ?? g?.guardId ?? g?.id ?? '';
}
