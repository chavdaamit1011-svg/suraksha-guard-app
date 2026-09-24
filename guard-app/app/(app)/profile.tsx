import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { Card, H2, Screen } from '@/components/ui';
import { useT } from '@/i18n';
import { useAuth } from '@/store/auth';
import { goBack } from '@/lib/navigation';
import { colors, font, space } from '@/theme';

/**
 * The guard's own record, read-only. Navigation (My details, language, logout and the rest) is
 * in the side menu only, so nothing here repeats it.
 */
export default function Profile() {
  const t = useT();
  const router = useRouter();
  const guard = useAuth((s) => s.guard);

  return (
    <Screen>
      <View style={styles.head}>
        <Ionicons name="arrow-back" size={24} color={colors.text} onPress={() => goBack()} />
        <H2>{t('profile.title')}</H2>
        <View style={{ width: 24 }} />
      </View>

      <View style={styles.hero}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{(guard?.name ?? 'G').slice(0, 1).toUpperCase()}</Text>
        </View>
        <H2>{guard?.name ?? 'Guard'}</H2>
      </View>

      <Card>
        <Row icon="call" label={t('profile.phone')} value={guard?.phone ?? '—'} />
        <Row icon="location" label={t('profile.city')} value={guard?.city ?? '—'} />
        <Row icon="shield" label={t('profile.type')} value={guard?.type ?? '—'} />
        <Row icon="business" label={t('profile.agency')} value={guard?.agencyName ?? '—'} />
        <Row icon="cash" label={t('profile.wage')} value={guard?.wage ?? '—'} />
      </Card>
    </Screen>
  );
}

function Row({ icon, label, value }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Ionicons name={icon} size={20} color={colors.primary} />
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  hero: { alignItems: 'center', gap: space.sm },
  avatar: { width: 88, height: 88, borderRadius: 44, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.primary, fontWeight: '900', fontSize: font.h1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.xs },
  rowLabel: { color: colors.textMuted, fontSize: font.body, flex: 1 },
  rowValue: { color: colors.text, fontSize: font.body, fontWeight: '800', flexShrink: 1, textAlign: 'right' },
});
