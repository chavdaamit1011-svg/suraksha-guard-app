import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Card, H2, Muted } from '@/components/ui';
import { useT } from '@/i18n';
import { api, type RosterShift } from '@/lib/api';
import { istTime } from '@/lib/duty';
import { KEYS, store } from '@/lib/storage';
import { guardId, useAuth } from '@/store/auth';
import { goBack } from '@/lib/navigation';
import { colors, font, radius, space } from '@/theme';

const CACHE_KEY = 'sg.roster';

const STATUS_TONE: Record<RosterShift['status'], { color: string; icon: keyof typeof Ionicons.glyphMap }> = {
  Scheduled: { color: colors.textMuted, icon: 'ellipse-outline' },
  'On duty': { color: colors.onDuty, icon: 'shield-checkmark' },
  Late: { color: colors.warning, icon: 'alert-circle' },
  Completed: { color: colors.onDuty, icon: 'checkmark-circle' },
  Absent: { color: colors.danger, icon: 'close-circle' },
};

/**
 * The guard's 7-day roster (PRD 18.4 GAP-S-014).
 *
 * A vertical list of days, not a calendar grid — a month view is unreadable on a 720×1280 screen
 * held one-handed at a gate, and the only question this screen answers is "when and where am I
 * next working?".
 *
 * Cached, so it still renders offline like every other duty surface (18.15.2).
 */
export default function Roster() {
  const t = useT();
  const router = useRouter();
  const guard = useAuth((s) => s.guard);

  const [shifts, setShifts] = useState<RosterShift[]>([]);
  const [today, setToday] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [offline, setOffline] = useState(false);

  const load = useCallback(async () => {
    const id = guardId(guard);
    if (!id) return;
    try {
      const res = await api.roster(id, { days: 9 });
      setShifts(res.shifts ?? []);
      setToday(res.today);
      setOffline(false);
      await store.setJSON(CACHE_KEY, { shifts: res.shifts, today: res.today });
    } catch {
      const cached = await store.getJSON<{ shifts: RosterShift[]; today: string } | null>(CACHE_KEY, null);
      if (cached) {
        setShifts(cached.shifts ?? []);
        setToday(cached.today);
      }
      setOffline(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [guard]);

  useEffect(() => {
    store.getJSON<{ shifts: RosterShift[]; today: string } | null>(CACHE_KEY, null).then((cached) => {
      if (cached) {
        setShifts(cached.shifts ?? []);
        setToday(cached.today);
        setLoading(false);
      }
    });
    load();
  }, [load]);

  const dayLabel = (date: string) => {
    if (!today) return date;
    if (date === today) return t('duty.today');
    const diff = Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000);
    if (diff === 1) return t('duty.tomorrow');
    return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.head}>
        <Pressable onPress={() => goBack()} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <H2>{t('duty.roster')}</H2>
        <View style={{ width: 24 }} />
      </View>

      {offline ? (
        <View style={styles.offline}>
          <Ionicons name="cloud-offline" size={14} color={colors.warning} />
          <Text style={styles.offlineText}>{t('offlineBanner')}</Text>
        </View>
      ) : null}

      <ScrollView
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
            tintColor={colors.primary}
          />
        }
      >
        {loading && shifts.length === 0 ? (
          <Card style={styles.center}>
            <ActivityIndicator color={colors.primary} />
            <Muted>{t('common.loading')}</Muted>
          </Card>
        ) : shifts.length === 0 ? (
          <Card style={styles.center}>
            <Ionicons name="calendar-outline" size={36} color={colors.textFaint} />
            <Muted style={{ textAlign: 'center' }}>{t('duty.noShifts')}</Muted>
          </Card>
        ) : (
          shifts.map((s) => {
            const tone = STATUS_TONE[s.status] ?? STATUS_TONE.Scheduled;
            const isToday = s.date === today;
            return (
              <Card key={s.rosterId} style={{ ...styles.row, ...(isToday ? { borderColor: colors.primary } : null) }}>
                <View style={styles.dayCol}>
                  <Text style={[styles.day, isToday && { color: colors.primary }]}>{dayLabel(s.date)}</Text>
                  <Text style={styles.time}>
                    {s.start}–{s.end}
                  </Text>
                  {s.crossesMidnight ? <Muted>{t('roster.overnight')}</Muted> : null}
                </View>

                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.site} numberOfLines={1}>
                    {s.siteName}
                  </Text>
                  {s.shiftType ? <Muted>{s.shiftType}</Muted> : null}
                  {s.checkedInAt ? (
                    <Muted style={{ color: colors.onDuty }}>
                      {t('duty.checkedInAt')} {istTime(s.checkedInAt)}
                      {s.lateByMin > 0 ? ` · +${s.lateByMin}m` : ''}
                    </Muted>
                  ) : null}
                  {s.isReliever ? <Muted style={{ color: colors.info }}>{t('duty.reliever')}</Muted> : null}
                </View>

                <View style={styles.statusCol}>
                  <Ionicons name={tone.icon} size={22} color={tone.color} />
                  <Text style={[styles.status, { color: tone.color }]}>{s.status}</Text>
                </View>
              </Card>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  offline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.warningDim,
    borderRadius: radius.sm,
    marginHorizontal: space.lg,
    padding: space.md,
  },
  offlineText: { color: colors.warning, fontSize: font.tiny, fontWeight: '700', flex: 1 },
  list: { padding: space.lg, gap: space.md },
  center: { alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingVertical: space.xxl },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  dayCol: { width: 92, gap: 2 },
  day: { color: colors.text, fontSize: font.label, fontWeight: '900' },
  time: { color: colors.textMuted, fontSize: font.label, fontWeight: '700' },
  site: { color: colors.text, fontSize: font.body, fontWeight: '800' },
  statusCol: { alignItems: 'center', gap: 2, width: 72 },
  status: { fontSize: font.tiny, fontWeight: '800', textAlign: 'center' },
});
