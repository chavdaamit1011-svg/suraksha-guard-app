import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button, Card, H1, Muted, Screen } from '@/components/ui';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { guardId, useAuth } from '@/store/auth';
import { colors, font, radius, space } from '@/theme';

type Agency = { id: string; name: string; city?: string };

/** Guard-initiated agency link/search (PRD 17.8 / 18.1). The guard always chooses and consents. */
export default function AgencyLink() {
  const t = useT();
  const router = useRouter();
  const guard = useAuth((s) => s.guard);
  const setGuard = useAuth((s) => s.setGuard);

  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Agency | null>(null);

  useEffect(() => {
    api
      .agenciesApproved()
      .then((r) => setAgencies(r.agencies ?? []))
      .catch(() => setAgencies([]))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? agencies.filter((a) => a.name.toLowerCase().includes(s) || (a.city ?? '').toLowerCase().includes(s)) : agencies;
  }, [q, agencies]);

  const link = async () => {
    if (!picked) return;
    setBusy(true);
    try {
      await api.agencyLink(guardId(guard), picked.id, picked.name).catch(() => {});
      if (guard) await setGuard({ ...guard, agencyId: picked.id, agencyName: picked.name });
    } finally {
      setBusy(false);
      router.replace('/pin?mode=set');
    }
  };

  return (
    <Screen scroll={false}>
      <View style={{ padding: space.lg, gap: space.md, flex: 1 }}>
        <H1>{t('agency.title')}</H1>
        <Muted>{t('agency.subtitle')}</Muted>

        <View style={styles.searchRow}>
          <Ionicons name="search" size={18} color={colors.textFaint} />
          <TextInput value={q} onChangeText={setQ} placeholder={t('agency.search')} placeholderTextColor={colors.textFaint} style={styles.search} />
        </View>

        {loading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: space.xl }} />
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(a) => a.id}
            style={{ flex: 1 }}
            ListEmptyComponent={<Muted style={{ textAlign: 'center', marginTop: space.xl }}>{t('agency.none')}</Muted>}
            renderItem={({ item }) => {
              const active = picked?.id === item.id;
              return (
                <Pressable onPress={() => setPicked(item)} style={[styles.row, active && styles.rowActive]}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.name, active && { color: colors.onPrimary }]}>{item.name}</Text>
                    {item.city ? <Text style={[styles.city, active && { color: 'rgba(11,13,15,0.7)' }]}>{item.city}</Text> : null}
                  </View>
                  {active ? <Ionicons name="checkmark-circle" size={22} color={colors.onPrimary} /> : null}
                </Pressable>
              );
            }}
          />
        )}

        <Button label={picked ? t('agency.link') : t('agency.skip')} onPress={picked ? link : () => router.replace('/pin?mode=set')} loading={busy} variant={picked ? 'success' : 'ghost'} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: 'rgba(0,0,0,0.4)', borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: space.md },
  search: { flex: 1, color: colors.text, paddingVertical: space.md, fontSize: font.body },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: space.lg, marginBottom: space.sm },
  rowActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  name: { color: colors.text, fontSize: font.body, fontWeight: '800' },
  city: { color: colors.textMuted, fontSize: font.tiny },
});
