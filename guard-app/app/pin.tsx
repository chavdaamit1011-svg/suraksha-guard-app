import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { H1, Muted, Screen } from '@/components/ui';
import { useT } from '@/i18n';
import { useAuth } from '@/store/auth';
import { colors, font, radius, space } from '@/theme';

export default function Pin() {
  const t = useT();
  const router = useRouter();
  const { mode } = useLocalSearchParams<{ mode: 'set' | 'enter' }>();
  const setPin = useAuth((s) => s.setPin);
  const verifyPin = useAuth((s) => s.verifyPin);

  const [stage, setStage] = useState<'first' | 'confirm'>('first');
  const [first, setFirst] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  const title = mode === 'set' ? (stage === 'first' ? t('pin.setTitle') : t('pin.confirm')) : t('pin.enterTitle');

  const onDigit = async (d: string) => {
    if (value.length >= 4) return;
    const next = value + d;
    setValue(next);
    setError('');
    if (next.length === 4) {
      setTimeout(() => handleComplete(next), 120);
    }
  };

  const handleComplete = async (pin: string) => {
    if (mode === 'set') {
      if (stage === 'first') {
        setFirst(pin);
        setValue('');
        setStage('confirm');
      } else {
        if (pin !== first) {
          setError(t('pin.mismatch'));
          setValue('');
          setStage('first');
          setFirst('');
          return;
        }
        await setPin(pin);
        router.replace('/home');
      }
    } else {
      const ok = await verifyPin(pin);
      if (ok) router.replace('/home');
      else {
        setError(t('pin.wrong'));
        setValue('');
      }
    }
  };

  return (
    <Screen scroll={false}>
      <View style={styles.wrap}>
        <View style={styles.badge}>
          <Ionicons name="lock-closed" size={30} color={colors.primary} />
        </View>
        <H1>{title}</H1>
        {mode === 'set' && stage === 'first' ? <Muted>{t('pin.setSubtitle')}</Muted> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.dots}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={[styles.dot, i < value.length && styles.dotFilled]} />
          ))}
        </View>

        <View style={styles.pad}>
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].map((k, i) => (
            <Pressable
              key={i}
              disabled={k === ''}
              onPress={() => (k === 'del' ? setValue((v) => v.slice(0, -1)) : k && onDigit(k))}
              style={({ pressed }) => [styles.key, k === '' && { opacity: 0 }, pressed && k !== '' && styles.keyPressed]}
            >
              {k === 'del' ? (
                <Ionicons name="backspace-outline" size={26} color={colors.text} />
              ) : (
                <Text style={styles.keyText}>{k}</Text>
              )}
            </Pressable>
          ))}
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.lg, padding: space.xl },
  badge: {
    width: 60, height: 60, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(245,198,35,0.1)', borderWidth: 1, borderColor: 'rgba(245,198,35,0.2)',
  },
  error: { color: colors.danger, fontWeight: '700' },
  dots: { flexDirection: 'row', gap: space.lg, marginVertical: space.lg },
  dot: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: colors.borderStrong },
  dotFilled: { backgroundColor: colors.primary, borderColor: colors.primary },
  pad: { width: 300, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: space.md },
  key: { width: 84, height: 60, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  keyPressed: { backgroundColor: colors.bgElevated },
  keyText: { color: colors.text, fontSize: 28, fontWeight: '700' },
});
