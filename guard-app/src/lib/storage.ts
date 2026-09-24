import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { encryptedStore } from './secureStore';

/**
 * Two tiers of persistence:
 *  - SecureStore  → keystore-backed, for the guard session, device id and PIN hash.
 *  - `store`      → bulk, for the cached /guard/today bundle and the offline event queue.
 *
 * The bulk tier is **encrypted at rest** (PRD 18.15.1 / SUR-GAP-028): it holds queued attendance
 * events and several days of a guard's movements, which is personal data under §39 and sits on a
 * handset that gets lost. Values go through AES-256-GCM with a key in the platform keystore —
 * see `secureStore.ts` for why GCM and what it does and does not protect against.
 */

export const secure = {
  async get(key: string) {
    try {
      if (Platform.OS === 'web') return globalThis.sessionStorage?.getItem(key) ?? null;
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async set(key: string, value: string) {
    try {
      if (Platform.OS === 'web') {
        globalThis.sessionStorage?.setItem(key, value);
        return;
      }
      await SecureStore.setItemAsync(key, value);
    } catch {
      /* ignore */
    }
  },
  async del(key: string) {
    try {
      if (Platform.OS === 'web') {
        globalThis.sessionStorage?.removeItem(key);
        return;
      }
      await SecureStore.deleteItemAsync(key);
    } catch {
      /* ignore */
    }
  },
};

export const store = encryptedStore;

export const KEYS = {
  guard: 'sg.guard', // secure: the active APGuard object
  deviceId: 'sg.deviceId', // secure: keystore-backed device binding id
  pinHash: 'sg.pinHash', // secure: 4-digit app PIN (hashed)
  session: 'sg.session', // secure: server session token + expiry
  language: 'sg.lang', // async: preferred language code
  todayBundle: 'sg.today', // async: cached /guard/today
  eventQueue: 'sg.queue', // async: offline event queue
  lastLoginAt: 'sg.lastLoginAt', // async: for the 12h PIN re-lock
  seqNo: 'sg.seqNo', // async: per-device capture sequence counter
  mediaQueue: 'sg.mediaQueue', // async: captured media awaiting upload
  bootId: 'sg.bootId', // async: detects a reboot breaking the monotonic clock chain
  bootMonotonic: 'sg.bootMonotonic', // async: last seen uptime reading, for the same check
  incidentDraft: 'sg.incidentDraft', // async: in-progress incident, survives an app kill
  ackedBriefings: 'sg.ackedBriefings', // async: siteId:version pairs the guard acknowledged
  armedWakeIds: 'sg.armedWakeIds', // async: wakeId → local notification id, for cancellation
  lastSyncAt: 'sg.lastSyncAt', // async: last successful queue flush, shown in App health
  dutyTracking: 'sg.dutyTracking', // async: on-duty location service run (hard stop time)
} as const;
