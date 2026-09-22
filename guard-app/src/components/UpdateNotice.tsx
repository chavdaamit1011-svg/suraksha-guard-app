import { Ionicons } from '@expo/vector-icons';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useT } from '@/i18n';
import { useVersion } from '@/store/version';
import { colors, font, radius, space, touch } from '@/theme';

/**
 * The update prompt (PRD SUR-GAP-040).
 *
 * `degraded` is loud and persistent — some features are switched off and the guard needs to know
 * why. `nudge` is quiet: nothing is wrong, there is simply a newer build. `ok` renders nothing.
 */
export function UpdateNotice() {
  const t = useT();
  const tier = useVersion((s) => s.tier);
  const storeUrl = useVersion((s) => s.storeUrl);

  if (tier !== 'degraded' && tier !== 'nudge') return null;
  const degraded = tier === 'degraded';

  return (
    <Pressable onPress={() => storeUrl && Linking.openURL(storeUrl)}>
      <View style={[styles.box, degraded ? styles.degraded : styles.nudge]}>
        <Ionicons
          name={degraded ? 'cloud-download' : 'sparkles'}
          size={18}
          color={degraded ? colors.warning : colors.info}
        />
        <Text style={[styles.text, { color: degraded ? colors.warning : colors.info }]}>
          {degraded ? t('version.degraded') : t('version.nudge')}
        </Text>
        <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
      </View>
    </Pressable>
  );
}

/**
 * Shown in place of a feature that degraded mode has switched off. It says what happened and how
 * to fix it, rather than leaving a button that silently does nothing.
 */
export function FeatureOffNotice() {
  const t = useT();
  const storeUrl = useVersion((s) => s.storeUrl);
  return (
    <View style={[styles.box, styles.degraded, styles.block]}>
      <Ionicons name="lock-closed" size={28} color={colors.warning} />
      <Text style={[styles.text, { color: colors.warning, textAlign: 'center' }]}>{t('version.featureOff')}</Text>
      <Pressable onPress={() => storeUrl && Linking.openURL(storeUrl)} style={styles.button}>
        <Text style={styles.buttonText}>{t('version.updateNow')}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderRadius: radius.sm,
    padding: space.md,
    minHeight: touch.minTap,
  },
  degraded: { backgroundColor: colors.warningDim },
  nudge: { backgroundColor: 'rgba(59,130,246,0.12)' },
  block: { flexDirection: 'column', paddingVertical: space.xl },
  text: { flex: 1, fontSize: font.label, fontWeight: '700' },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingHorizontal: space.xl,
    minHeight: touch.minTap,
    justifyContent: 'center',
  },
  buttonText: { color: colors.onPrimary, fontWeight: '900', fontSize: font.body },
});
