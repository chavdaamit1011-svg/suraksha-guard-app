import Constants from 'expo-constants';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Button, H1, Muted } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useAuth } from '@/store/auth';
import { useVersion } from '@/store/version';
import { colors, space } from '@/theme';

/** Upper bound on how long the splash may wait for the version check before the app opens anyway. */
const VERSION_CHECK_BUDGET_MS = 4000;

export default function RootLayout() {
  const hydrate = useAuth((s) => s.hydrate);
  const initI18n = useI18n((s) => s.init);
  const t = useI18n((s) => s.t);
  const tier = useVersion((s) => s.tier);
  const storeUrl = useVersion((s) => s.storeUrl);
  const checkVersion = useVersion((s) => s.check);
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    (async () => {
      await Promise.all([hydrate(), initI18n()]);
      // Never let a slow network hold the guard on a blank splash. The check keeps running in
      // the background and the tier updates when it lands (SUR-GAP-040).
      await Promise.race([checkVersion(), new Promise((r) => setTimeout(r, VERSION_CHECK_BUDGET_MS))]);
      setBooted(true);
    })();
  }, [hydrate, initI18n, checkVersion]);

  if (!booted) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;

  // The hard block is reserved for a build with a known defect. Even here a guard in danger must
  // be able to reach help, so the emergency number stays one tap away.
  if (tier === 'blocked') {
    return (
      <SafeAreaProvider>
        <StatusBar style="light" />
        <View
          style={{
            flex: 1,
            backgroundColor: colors.bg,
            alignItems: 'center',
            justifyContent: 'center',
            padding: space.xl,
            gap: space.lg,
          }}
        >
          <H1>{t('version.blockedTitle')}</H1>
          <Muted style={{ textAlign: 'center' }}>{t('version.blockedBody')}</Muted>
          <Text style={{ color: colors.textFaint }}>v{Constants.expoConfig?.version}</Text>
          <Button label={t('version.updateNow')} onPress={() => storeUrl && Linking.openURL(storeUrl)} />
          <Button
            label={t('version.emergencyCall')}
            variant="danger"
            onPress={() => Linking.openURL('tel:112')}
          />
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.bg },
            animation: 'fade',
          }}
        />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
