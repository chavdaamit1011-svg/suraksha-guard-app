import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as Speech from 'expo-speech';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, H1, Muted, Screen } from '@/components/ui';
import { LANGUAGES } from '@/i18n/translations';
import { useI18n } from '@/i18n';
import { useAuth } from '@/store/auth';
import { colors, font, radius, space, touch } from '@/theme';

export default function LanguageScreen() {
  const router = useRouter();
  const { lang, setLang, t } = useI18n();
  const [selected, setSelected] = useState(lang || 'hi');

  return (
    <Screen>
      <H1>{t('lang.title')}</H1>
      <View style={styles.grid}>
        {LANGUAGES.map((l) => {
          const active = selected === l.code;
          return (
            <Pressable
              key={l.code}
              onPress={() => setSelected(l.code)}
              style={[styles.tile, active && styles.tileActive]}
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.endonym, active && { color: colors.onPrimary }]}>{l.endonym}</Text>
                <Text style={[styles.english, active && { color: 'rgba(11,13,15,0.7)' }]}>{l.english}</Text>
              </View>
              <Pressable
                hitSlop={10}
                onPress={() => Speech.speak(l.endonym, { language: l.code === 'en' ? 'en-IN' : 'hi-IN' })}
                style={styles.listen}
              >
                <Ionicons name="volume-medium" size={20} color={active ? colors.onPrimary : colors.primary} />
              </Pressable>
            </Pressable>
          );
        })}
      </View>
      <Muted style={{ textAlign: 'center' }}>{t('lang.listen')}</Muted>
      <Button
        label={t('common.continue')}
        onPress={async () => {
          await setLang(selected);
          // First run goes on to login; a signed-in guard changing language from Profile goes
          // straight back, without signing in again (SUR-GAP-002: "switch without re-login").
          if (!useAuth.getState().guard) router.replace('/login');
          else if (router.canGoBack()) router.back();
          else router.replace('/home');
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  tile: {
    width: '48%',
    minHeight: touch.tile,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  tileActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  endonym: { color: colors.text, fontSize: font.h3, fontWeight: '800' },
  english: { color: colors.textMuted, fontSize: font.tiny },
  listen: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.25)' },
});
