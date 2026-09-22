import * as Brightness from 'expo-brightness';
import { useEffect } from 'react';

/**
 * Full brightness while this screen is up (PRD 18.17.1 rule 13: check-in in sunlight, wake
 * check in a dark cabin). Only this app's window is changed — no system setting, no permission —
 * and the phone's own level comes back when the screen closes.
 */
export function useBrightScreen(): void {
  useEffect(() => {
    Brightness.setBrightnessAsync(1).catch(() => {});
    return () => {
      Brightness.restoreSystemBrightnessAsync().catch(() => {});
    };
  }, []);
}
