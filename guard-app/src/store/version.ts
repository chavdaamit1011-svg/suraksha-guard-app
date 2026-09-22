import Constants from 'expo-constants';
import { create } from 'zustand';
import { api } from '@/lib/api';

/**
 * Version tier (PRD SUR-GAP-040).
 *
 *   ok        — current
 *   nudge     — an update exists; nothing changes
 *   degraded  — below the minimum supported version. Duty still works (attendance, SOS,
 *               incidents), but the features an outdated client could get wrong are switched off
 *               and a banner asks for the update. PRD: "a read-only degraded mode rather than a
 *               hard lockout".
 *   blocked   — below a version with a known defect. Reserved; SOS-by-phone stays reachable.
 *
 * Offline, the tier stays `ok`. An app that cannot reach the server cannot know it is out of date,
 * and must never lock a guard out on a guess.
 */

export type VersionTier = 'ok' | 'nudge' | 'degraded' | 'blocked';

/** Features degraded mode can switch off. Duty-critical flows are deliberately not on this list. */
export type Gated = 'offers' | 'training' | 'profile_edit' | 'leave';

type VersionState = {
  tier: VersionTier;
  current: string;
  latest: string;
  storeUrl: string;
  disabled: string[];
  /** Support numbers from the server; empty when not configured (the row is then hidden). */
  helpline: string;
  commandCenter: string;
  check: () => Promise<void>;
  isDisabled: (feature: Gated) => boolean;
};

/** true when `a` is lower than `b`, comparing dotted numeric versions. */
export function isLower(a: string, b: string): boolean {
  if (!b) return false;
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return false;
  }
  return false;
}

export const useVersion = create<VersionState>((set, get) => ({
  tier: 'ok',
  current: Constants.expoConfig?.version ?? '1.0.0',
  latest: '',
  storeUrl: '',
  disabled: [],
  helpline: '',
  commandCenter: '',

  check: async () => {
    const current = get().current;
    try {
      const v = await api.version();
      let tier: VersionTier = 'ok';
      if (v.blockBelow && isLower(current, v.blockBelow)) tier = 'blocked';
      else if (v.minSupported && isLower(current, v.minSupported)) tier = 'degraded';
      else if (v.latest && isLower(current, v.latest)) tier = 'nudge';

      set({
        tier,
        helpline: v.helpline ?? '',
        commandCenter: v.commandCenter ?? '',
        latest: v.latest ?? '',
        storeUrl: v.storeUrl ?? '',
        disabled: tier === 'degraded' ? (v.degradedDisables ?? []) : [],
      });
    } catch {
      /* offline: never degrade or block on a guess */
    }
  },

  isDisabled: (feature) => get().tier === 'degraded' && get().disabled.includes(feature),
}));
