import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { PING_INTERVAL_SEC } from '@/config';
import { KEYS, store } from './storage';

/**
 * On-duty location as an Android foreground service (PRD 18.15.7): one visible notification
 * ("On duty — location active"), updates keep flowing with the screen off or another app in front.
 *
 * Privacy (§39, SUR-GAP-033): the service is started only at check-in and stopped at check-out,
 * and it also carries its own hard stop — the end of the shift plus the agency's auto-close
 * window — so a guard who never opens the app again is not tracked past their shift.
 *
 * A foreground service does not need the "Allow all the time" background permission, only
 * "While using the app"; Android requires it to be started while the app is on screen.
 */

export const DUTY_TASK = 'suraksha-duty-location';
const LOW_BATTERY = 0.15;

type Run = { stopAt: number; saver: boolean };
type Sink = (lat: number, lng: number, heading?: number) => void;

let sink: Sink | null = null;

/** Where fixes go. Set by the duty store once it loads (kept out of here to avoid an import cycle). */
export function setDutyLocationSink(fn: Sink) {
  sink = fn;
}

TaskManager.defineTask<{ locations: Location.LocationObject[] }>(DUTY_TASK, async ({ data, error }) => {
  if (error || !data?.locations?.length) return;
  const run = await store.getJSON<Run | null>(KEYS.dutyTracking, null);
  if (!run || Date.now() > run.stopAt) {
    await stopDutyTracking();
    return;
  }
  const last = data.locations[data.locations.length - 1];
  sink?.(last.coords.latitude, last.coords.longitude, last.coords.heading ?? undefined);

  // Below 15 % the interval widens (PRD 18.15.7 degraded mode). Changing it means re-registering
  // the task, which Android only allows while the app is on screen: in the background this fails
  // and is retried on the next fix, so the switch lands the next time the guard opens the app.
  const level = await Battery.getBatteryLevelAsync().catch(() => -1);
  const saver = level >= 0 && level < LOW_BATTERY;
  if (saver !== run.saver) await register(run.stopAt, saver).catch(() => {});
});

async function register(stopAt: number, saver: boolean, text?: { title: string; body: string }) {
  const prev = await store.getJSON<(Run & { title?: string; body?: string }) | null>(KEYS.dutyTracking, null);
  const title = text?.title ?? prev?.title ?? 'On duty';
  const body = text?.body ?? prev?.body ?? 'Location active until your shift ends';
  // The hard stop must be on disk before the first fix arrives; the interval mode is recorded
  // only once the new registration has actually taken effect.
  await store.setJSON(KEYS.dutyTracking, { stopAt, saver: prev?.saver ?? saver, title, body });
  await Location.startLocationUpdatesAsync(DUTY_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: (saver ? PING_INTERVAL_SEC.batterySaver : PING_INTERVAL_SEC.stationaryInGeofence) * 1000,
    // No distance filter: a guard standing at the gate is exactly the one whose presence has to
    // keep being reported. (With 25 m, a phone seen on a device test sent nothing while still.)
    distanceInterval: 0,
    pausesUpdatesAutomatically: false,
    foregroundService: {
      notificationTitle: title,
      notificationBody: body,
      notificationColor: '#16a34a',
      killServiceOnDestroy: false,
    },
  });
  await store.setJSON(KEYS.dutyTracking, { stopAt, saver, title, body });
}

/**
 * Start (or keep) the service for a shift ending at `endAt`. Returns false when it could not be
 * started — the caller then falls back to foreground-only updates.
 */
export async function startDutyTracking(
  endAt: string | undefined,
  graceMin: number,
  text: { title: string; body: string }
): Promise<boolean> {
  try {
    const end = endAt ? Date.parse(endAt) : NaN;
    // No known end (on-demand booking): cap at 14 h so a missed check-out cannot track for days.
    const stopAt = (Number.isFinite(end) ? end : Date.now() + 14 * 3600_000) + Math.max(graceMin, 30) * 60_000;
    if (Date.now() > stopAt) return false;
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== 'granted') return false;
    const level = await Battery.getBatteryLevelAsync().catch(() => -1);
    await register(stopAt, level >= 0 && level < LOW_BATTERY, text);
    return true;
  } catch {
    return false;
  }
}

export async function stopDutyTracking(): Promise<void> {
  await store.del(KEYS.dutyTracking);
  try {
    if (await Location.hasStartedLocationUpdatesAsync(DUTY_TASK)) {
      await Location.stopLocationUpdatesAsync(DUTY_TASK);
    }
  } catch {
    /* not running */
  }
}

export async function dutyTrackingActive(): Promise<boolean> {
  try {
    return await Location.hasStartedLocationUpdatesAsync(DUTY_TASK);
  } catch {
    return false;
  }
}
