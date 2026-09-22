import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter, usePathname } from 'expo-router';
import { useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '@/theme';

/**
 * Persistent SOS control (PRD 18.9). Long-press ~2s to trigger, so it cannot fire from an
 * accidental tap. Present on every authenticated screen via the (app) layout.
 */
export function SosButton() {
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const bottom = 28 + insets.bottom;
  const [holding, setHolding] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (pathname?.startsWith('/sos')) return null; // don't overlay the SOS screen itself

  const start = () => {
    setHolding(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    Animated.timing(progress, { toValue: 1, duration: 2000, useNativeDriver: false }).start();
    timer.current = setTimeout(() => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      reset();
      router.push('/sos?fired=1');
    }, 2000);
  };

  const reset = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
    progress.setValue(0);
  };

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom }]}>
      <Pressable onPressIn={start} onPressOut={reset} style={styles.btn}>
        <Animated.View
          style={[
            styles.ring,
            { transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] }) }], opacity: holding ? 0.6 : 0 },
          ]}
        />
        <Ionicons name="warning" size={26} color="#fff" />
        <Text style={styles.label}>SOS</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', right: 16, bottom: 28, zIndex: 100 },
  btn: {
    width: 72, height: 72, borderRadius: 36, backgroundColor: colors.danger,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: colors.danger, shadowOpacity: 0.6, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 10,
  },
  ring: { position: 'absolute', width: 72, height: 72, borderRadius: 36, backgroundColor: colors.danger },
  label: { color: '#fff', fontWeight: '900', fontSize: 11, letterSpacing: 1 },
});
