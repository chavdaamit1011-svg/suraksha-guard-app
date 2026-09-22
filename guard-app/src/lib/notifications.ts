import { Platform } from 'react-native';
import { useI18n } from '@/i18n';
import type { WakeCheck } from './api';
import {
  cancelNativeAlarm,
  dismissNativeAlarm,
  nativeAlarmIds,
  nativeAlarms,
  scheduleNativeAlarm,
} from './native';
import { KEYS, store } from './storage';

/**
 * Local + push notifications (PRD 18.8 wake-checks, 18.12 replacement offers, §36).
 *
 * Wake-checks are **local** notifications scheduled from the server-generated times in the duty
 * bundle, so they fire on time with no network at all — the device owns the schedule while the
 * server owns when it should be (18.8 §10). On Android they go out on a MAX-importance channel
 * that bypasses Do Not Disturb and uses the alarm audio stream, because a guard asleep at 03:00
 * is exactly the person a silenced phone would fail.
 *
 * The module is loaded defensively, because `expo-notifications` can throw at *import* time —
 * Expo Go on Android does exactly that since SDK 53. A statically imported failure would take
 * down the whole authenticated stack and leave a guard unable to mark attendance because their
 * phone could not schedule an alarm. PRD 18.17.1 rule 12 is explicit that nothing blocks duty:
 * losing wake checks has to degrade to a warning on App health (18.8 §16), not a dead app.
 */

type NotificationsModule = typeof import('expo-notifications');

let Notifications: NotificationsModule | null = null;
let loadError: string | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Notifications = require('expo-notifications') as NotificationsModule;
} catch (e: any) {
  loadError = e?.message ?? 'expo-notifications unavailable';
}

/** False when the platform refused to load the module at all — surfaced on App health. */
export const notificationsAvailable = Notifications !== null;
export const notificationsError = loadError;

if (Notifications) {
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
  } catch {
    /* handler registration is best-effort */
  }
}

/**
 * Subscribe to notification taps. Returns an unsubscribe function that is safe to call even when
 * the module never loaded, so callers need no branching of their own.
 */
export function onNotificationResponse(handler: (data: any) => void): () => void {
  if (!Notifications) return () => {};
  try {
    const sub = Notifications.addNotificationResponseReceivedListener((resp) =>
      handler(resp.notification.request.content.data)
    );
    return () => sub.remove();
  } catch {
    return () => {};
  }
}

/** The notification that cold-started the app, if any (a tap from a killed process). */
export async function getLaunchNotificationData(): Promise<any | null> {
  if (!Notifications) return null;
  try {
    const resp = await Notifications.getLastNotificationResponseAsync();
    return resp?.notification.request.content.data ?? null;
  } catch {
    return null;
  }
}

export async function ensureNotificationPermission(): Promise<boolean> {
  if (!Notifications) return false;
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status === 'granted') return true;
    const req = await Notifications.requestPermissionsAsync();
    return req.status === 'granted';
  } catch {
    return false;
  }
}

/** Permission state for App health, without forcing a prompt. */
export async function notificationPermissionGranted(): Promise<boolean | null> {
  if (!Notifications) return null;
  try {
    return (await Notifications.getPermissionsAsync()).granted;
  } catch {
    return null;
  }
}

export async function setupAndroidChannels() {
  if (!Notifications || Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('wake', {
    name: 'Wake checks',
    importance: Notifications.AndroidImportance.MAX,
    sound: 'default',
    vibrationPattern: [0, 500, 250, 500, 250, 500],
    bypassDnd: true,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    enableVibrate: true,
  });
  await Notifications.setNotificationChannelAsync('duty', {
    name: 'Duty & alerts',
    importance: Notifications.AndroidImportance.HIGH,
  });
  await Notifications.setNotificationChannelAsync('shift', {
    name: 'Shift reminders',
    importance: Notifications.AndroidImportance.DEFAULT,
  });
}

type ArmedMap = Record<string, string>; // wakeId → local notification id

/**
 * Arm the night's wake prompts from the duty bundle.
 *
 * Idempotent: prompts already armed are left alone (re-scheduling would move a prompt the guard
 * is about to receive), prompts the server has since resolved or cancelled are torn down, and
 * anything already due is skipped rather than fired retroactively.
 */
const NATIVE = 'native:';

/** Deep link the alarm opens: the same parameters a notification tap passes. */
function wakeUrl(p: { wakeId: string; ackWindowSec?: number; selfieRequired?: boolean; attempt?: number }): string {
  const q = new URLSearchParams({ prompt: '1', wakeId: p.wakeId });
  if (p.ackWindowSec) q.set('ackWindowSec', String(p.ackWindowSec));
  if (p.selfieRequired) q.set('selfie', '1');
  if (p.attempt) q.set('attempt', String(p.attempt));
  return `surakshaguard://wake?${q.toString()}`;
}

function wakeText(again: boolean) {
  const t = useI18n.getState().t;
  return {
    title: again ? t('wake.alarmAgainTitle') : t('wake.alarmTitle'),
    body: again ? t('wake.alarmAgainBody') : t('wake.alarmBody'),
  };
}

async function cancelArmed(id: string) {
  if (id.startsWith(NATIVE)) cancelNativeAlarm(id.slice(NATIVE.length));
  else await Notifications?.cancelScheduledNotificationAsync(id).catch(() => {});
}

export async function armWakeChecks(wakeChecks: WakeCheck[]): Promise<number> {
  // The native alarm is used wherever it exists (real builds); notifications are the fallback.
  if (!Notifications && !nativeAlarms) return 0;
  if (Notifications && !(await ensureNotificationPermission())) return 0;
  await setupAndroidChannels();

  const armed = await store.getJSON<ArmedMap>(KEYS.armedWakeIds, {});
  const wanted = new Map(
    wakeChecks
      .filter((w) => w.status === 'pending' && Date.parse(w.dueAt) > Date.now() + 5_000)
      .map((w) => [w.wakeId, w])
  );

  // Tear down prompts that are no longer wanted (acknowledged, suppressed, shift cancelled).
  for (const [wakeId, notifId] of Object.entries(armed)) {
    if (!wanted.has(wakeId)) {
      await cancelArmed(notifId);
      delete armed[wakeId];
    }
  }

  for (const [wakeId, w] of wanted) {
    if (armed[wakeId]) continue;
    if (nativeAlarms) {
      const ok = scheduleNativeAlarm({
        id: wakeId,
        at: Date.parse(w.dueAt),
        ...wakeText(false),
        url: wakeUrl({ wakeId, ackWindowSec: w.ackWindowSec, selfieRequired: w.selfieRequired }),
        // Stop ringing when the answer window closes; the re-prompt takes over from there.
        timeoutMs: (w.ackWindowSec ?? 120) * 1000,
      });
      if (ok) {
        armed[wakeId] = `${NATIVE}${wakeId}`;
        continue;
      }
    }
    if (!Notifications) continue;
    try {
      const notifId = await Notifications.scheduleNotificationAsync({
        content: {
          title: 'Suraksha — Are you awake?',
          body: 'Tap to confirm you are awake and on duty.',
          data: { type: 'wake_check', wakeId, ackWindowSec: w.ackWindowSec, selfieRequired: w.selfieRequired },
          sticky: true,
          priority: Notifications.AndroidNotificationPriority.MAX,
          ...(Platform.OS === 'android' ? { channelId: 'wake' } : {}),
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: new Date(w.dueAt),
          ...(Platform.OS === 'android' ? { channelId: 'wake' } : {}),
        } as any,
      });
      armed[wakeId] = notifId;
    } catch {
      // Exact-alarm permission refused or the OS declined. App health surfaces this as
      // "alarm reliability" so the guard is told their wake checks may not fire (18.8 §16).
    }
  }

  await store.setJSON(KEYS.armedWakeIds, armed);
  return Object.keys(armed).length;
}

/**
 * Miss 1 of the wake ladder (PRD 18.8 §9): re-prompt after 60 seconds. Local, so it fires even
 * if the missed prompt happened in a dead zone. The attempt number rides in the payload so the
 * screen knows a second miss is the one that escalates.
 */
export async function scheduleWakeReprompt(args: {
  wakeId: string;
  attempt: number;
  afterSeconds: number;
  ackWindowSec: number;
  selfieRequired: boolean;
}): Promise<string | null> {
  if (nativeAlarms) {
    const id = `${args.wakeId}#${args.attempt}`;
    const ok = scheduleNativeAlarm({
      id,
      at: Date.now() + Math.max(5, args.afterSeconds) * 1000,
      ...wakeText(true),
      url: wakeUrl(args),
      timeoutMs: args.ackWindowSec * 1000,
    });
    if (ok) return `${NATIVE}${id}`;
  }
  if (!Notifications) return null;
  try {
    await setupAndroidChannels();
    return await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Suraksha — Wake check (again)',
        body: 'You missed the last check. Tap now to confirm you are awake.',
        data: {
          type: 'wake_check',
          wakeId: args.wakeId,
          attempt: args.attempt,
          ackWindowSec: args.ackWindowSec,
          selfieRequired: args.selfieRequired,
        },
        sticky: true,
        priority: Notifications.AndroidNotificationPriority.MAX,
        ...(Platform.OS === 'android' ? { channelId: 'wake' } : {}),
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: Math.max(5, args.afterSeconds),
        ...(Platform.OS === 'android' ? { channelId: 'wake' } : {}),
      } as any,
    });
  } catch {
    return null;
  }
}

/** Drop a single armed prompt once it has been answered locally. */
export async function disarmWakeCheck(wakeId: string, opts: { keepReprompt?: boolean } = {}) {
  // Silence the alarm if it is ringing, and drop any re-prompt still queued for this slot —
  // unless this was the first miss, whose re-prompt was just scheduled.
  dismissNativeAlarm(wakeId);
  for (const id of nativeAlarmIds()) {
    if (id === wakeId || (!opts.keepReprompt && id.startsWith(`${wakeId}#`))) {
      cancelNativeAlarm(id);
    }
  }
  const armed = await store.getJSON<ArmedMap>(KEYS.armedWakeIds, {});
  const notifId = armed[wakeId];
  if (notifId) {
    await cancelArmed(notifId);
    delete armed[wakeId];
    await store.setJSON(KEYS.armedWakeIds, armed);
  }
}

/** Silence a ringing re-prompt alarm (its id carries the attempt). */
export function silenceWakeAlarm(wakeId: string, attempt?: number) {
  dismissNativeAlarm(wakeId);
  if (attempt) dismissNativeAlarm(`${wakeId}#${attempt}`);
}

export async function cancelAllWakeChecks() {
  const armed = await store.getJSON<ArmedMap>(KEYS.armedWakeIds, {});
  await Promise.all(Object.values(armed).map((id) => cancelArmed(id)));
  await store.setJSON(KEYS.armedWakeIds, {});
}

/** How many wake prompts are currently armed — shown on the App health screen. */
export async function armedWakeCount(): Promise<number> {
  const armed = await store.getJSON<ArmedMap>(KEYS.armedWakeIds, {});
  return Object.keys(armed).length;
}

/** Shift reminders at T−60 and T−15 (PRD 18.3 §12). Local, so they survive a dead network. */
export async function armShiftReminders(startAt: string, siteName: string): Promise<void> {
  if (!Notifications) return;
  if (!(await ensureNotificationPermission())) return;
  await setupAndroidChannels();
  const start = Date.parse(startAt);
  for (const minsBefore of [60, 15]) {
    const at = start - minsBefore * 60_000;
    if (at <= Date.now() + 5_000) continue;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `Duty in ${minsBefore} minutes`,
        body: siteName ? `${siteName} — get ready to check in.` : 'Get ready to check in.',
        data: { type: 'shift_reminder' },
        ...(Platform.OS === 'android' ? { channelId: 'shift' } : {}),
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(at),
        ...(Platform.OS === 'android' ? { channelId: 'shift' } : {}),
      } as any,
    }).catch(() => {});
  }
}

export async function registerForPush(): Promise<string | null> {
  if (!Notifications) return null;
  try {
    if (!(await ensureNotificationPermission())) return null;
    await setupAndroidChannels();
    const token = await Notifications.getDevicePushTokenAsync();
    return token.data as string;
  } catch {
    return null;
  }
}
