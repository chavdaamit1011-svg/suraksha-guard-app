import * as Brightness from 'expo-brightness';
import { useEffect } from 'react';
import { Platform } from 'react-native';

export function useBrightScreen(): void {
  useEffect(() => {
    if (Platform.OS === 'web') return;
    try {
      Brightness.setBrightnessAsync(1).catch(() => {});
    } catch {}
    return () => {
      if (Platform.OS === 'web') return;
      try {
        Brightness.restoreSystemBrightnessAsync().catch(() => {});
      } catch {}
    };
  }, []);
}
