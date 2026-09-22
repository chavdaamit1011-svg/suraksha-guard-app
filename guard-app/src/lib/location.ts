import * as Location from 'expo-location';

/**
 * A location fix that never holds up the guard (PRD 18.17.1 rule 12).
 *
 * `getCurrentPositionAsync` has no timeout of its own, and indoors a high-accuracy fix may never
 * arrive — a scan or report that waits on it simply never happens. This tries the requested
 * accuracy for `timeoutMs`, then a quick network fix, then the last known position (if recent),
 * and otherwise returns null so the caller records the event without coordinates.
 */
export async function quickFix(opts: {
  accuracy?: Location.Accuracy;
  timeoutMs?: number;
  maxLastKnownAgeMs?: number;
} = {}): Promise<Location.LocationObject | null> {
  const accuracy = opts.accuracy ?? Location.Accuracy.High;
  const timeoutMs = opts.timeoutMs ?? 8_000;

  const attempt = (a: Location.Accuracy, ms: number) =>
    Promise.race([
      Location.getCurrentPositionAsync({ accuracy: a }).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
    ]);

  try {
    const perm = await Location.getForegroundPermissionsAsync();
    if (!perm.granted) return null;

    let pos = await attempt(accuracy, timeoutMs);
    if (!pos && accuracy > Location.Accuracy.Balanced) pos = await attempt(Location.Accuracy.Balanced, 5_000);
    if (!pos) {
      pos = await Location.getLastKnownPositionAsync({ maxAge: opts.maxLastKnownAgeMs ?? 300_000 }).catch(() => null);
    }
    return pos;
  } catch {
    return null;
  }
}
