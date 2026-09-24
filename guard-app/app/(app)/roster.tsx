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
 * The guard's roster & duty orders (PRD 18.4).
 * Cleanly displays scheduled duties, client orders, payouts, and client ratings.
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
  const [filter, setFilter] = useState<'all' | 'completed' | 'scheduled'>('all');

  const load = useCallback(async () => {
    const id = guardId(guard);
    if (!id) return;
    try {
      const res = await api.roster(id, { days: 60 });
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

  const completedShifts = shifts.filter((s) => s.status === 'Completed');
  const scheduledShifts = shifts.filter((s) => s.status !== 'Completed');
  const totalEarned = completedShifts.reduce((acc, s) => acc + (s.payout || 0), 0);
  const ratedShifts = completedShifts.filter((s) => typeof s.clientRating === 'number' && s.clientRating >= 1 && s.clientRating <= 5);
  const avgRating = ratedShifts.length > 0
    ? (ratedShifts.reduce((acc, s) => acc + (s.clientRating || 5), 0) / ratedShifts.length).toFixed(1)
    : '5.0';

  const visibleShifts = filter === 'completed'
    ? completedShifts
    : filter === 'scheduled'
    ? scheduledShifts
    : shifts;

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

      {/* KPI Summary Cards */}
      <View style={styles.kpiRow}>
        <Card style={styles.kpiCard}>
          <Ionicons name="checkmark-done-circle" size={18} color={colors.onDuty} />
          <Text style={styles.kpiVal}>{completedShifts.length}</Text>
          <Muted style={styles.kpiLbl}>Completed</Muted>
        </Card>
        <Card style={styles.kpiCard}>
          <Ionicons name="wallet" size={18} color={colors.primary} />
          <Text style={styles.kpiVal}>₹{totalEarned.toLocaleString('en-IN')}</Text>
          <Muted style={styles.kpiLbl}>Earned</Muted>
        </Card>
        <Card style={styles.kpiCard}>
          <Ionicons name="star" size={18} color={colors.warning} />
          <Text style={styles.kpiVal}>⭐ {avgRating}</Text>
          <Muted style={styles.kpiLbl}>Rating</Muted>
        </Card>
      </View>

      {/* Filter Tabs */}
      <View style={styles.tabsRow}>
        <Pressable
          style={[styles.tabBtn, filter === 'all' && styles.tabBtnActive]}
          onPress={() => setFilter('all')}
        >
          <Text style={[styles.tabTxt, filter === 'all' && styles.tabTxtActive]}>
            All ({shifts.length})
          </Text>
        </Pressable>
        <Pressable
          style={[styles.tabBtn, filter === 'completed' && styles.tabBtnActive]}
          onPress={() => setFilter('completed')}
        >
          <Text style={[styles.tabTxt, filter === 'completed' && styles.tabTxtActive]}>
            Completed ({completedShifts.length})
          </Text>
        </Pressable>
        <Pressable
          style={[styles.tabBtn, filter === 'scheduled' && styles.tabBtnActive]}
          onPress={() => setFilter('scheduled')}
        >
          <Text style={[styles.tabTxt, filter === 'scheduled' && styles.tabTxtActive]}>
            Upcoming ({scheduledShifts.length})
          </Text>
        </Pressable>
      </View>

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
        ) : visibleShifts.length === 0 ? (
          <Card style={styles.center}>
            <Ionicons name="calendar-outline" size={36} color={colors.textFaint} />
            <Muted style={{ textAlign: 'center' }}>{t('duty.noShifts')}</Muted>
          </Card>
        ) : (
          visibleShifts.map((s) => {
            const tone = STATUS_TONE[s.status] ?? STATUS_TONE.Scheduled;
            const isToday = s.date === today;
            const isDone = s.status === 'Completed';

            return (
              <Card
                key={s.rosterId}
                style={{
                  ...styles.orderCard,
                  ...(isToday ? { borderColor: colors.primary } : null),
                }}
              >
                {/* Header: Date + Payout + Status */}
                <View style={styles.cardHeader}>
                  <View style={styles.dateBadge}>
                    <Ionicons name="calendar-outline" size={13} color={colors.primary} />
                    <Text style={[styles.dayText, isToday && { color: colors.primary }]}>
                      {dayLabel(s.date)} · {s.start}–{s.end}
                    </Text>
                  </View>

                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
                    {s.payout ? (
                      <View style={styles.payoutBadge}>
                        <Text style={styles.payoutText}>+₹{s.payout.toLocaleString('en-IN')}</Text>
                      </View>
                    ) : null}
                    <View style={[styles.statusBadge, { backgroundColor: `${tone.color}20` }]}>
                      <Ionicons name={tone.icon} size={12} color={tone.color} />
                      <Text style={[styles.statusText, { color: tone.color }]}>{s.status}</Text>
                    </View>
                  </View>
                </View>

                {/* Duty / Service Details */}
                <View style={{ gap: 2 }}>
                  <Text style={styles.orderTitle} numberOfLines={1}>
                    {s.bookingId ? `Order #${s.bookingId}` : s.siteName}
                  </Text>
                  <Text style={styles.serviceName}>
                    {s.shiftType || 'Security Guard Duty'}
                  </Text>
                  {s.address ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                      <Ionicons name="location-outline" size={13} color={colors.textFaint} />
                      <Muted numberOfLines={1} style={{ flex: 1 }}>{s.address}</Muted>
                    </View>
                  ) : null}
                </View>

                {/* Checked in info */}
                {s.checkedInAt ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Ionicons name="time-outline" size={12} color={colors.onDuty} />
                    <Muted style={{ color: colors.onDuty }}>
                      {t('duty.checkedInAt')} {istTime(s.checkedInAt)}
                      {s.checkedOutAt ? ` · Completed ${istTime(s.checkedOutAt)}` : ''}
                    </Muted>
                  </View>
                ) : null}

                {/* Client Review & Rating if present */}
                {s.clientRating ? (
                  <View style={styles.reviewBox}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                      <Text style={styles.reviewHeading}>Client Review</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                        {Array.from({ length: 5 }).map((_, i) => (
                          <Ionicons
                            key={i}
                            name={i < (s.clientRating ?? 0) ? 'star' : 'star-outline'}
                            size={12}
                            color={colors.warning}
                          />
                        ))}
                        <Text style={styles.ratingNumber}>{s.clientRating}.0</Text>
                      </View>
                    </View>
                    {s.clientReview ? (
                      <Text style={styles.reviewComment}>&quot;{s.clientReview}&quot;</Text>
                    ) : null}
                  </View>
                ) : null}
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
    marginBottom: space.sm,
    padding: space.md,
  },
  offlineText: { color: colors.warning, fontSize: font.tiny, fontWeight: '700', flex: 1 },
  kpiRow: {
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.lg,
    marginBottom: space.sm,
  },
  kpiCard: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: space.sm,
    paddingHorizontal: space.xs,
    gap: 2,
  },
  kpiVal: { color: colors.text, fontSize: font.body, fontWeight: '900' },
  kpiLbl: { fontSize: font.tiny, textTransform: 'uppercase', letterSpacing: 0.5 },
  tabsRow: {
    flexDirection: 'row',
    gap: space.xs,
    paddingHorizontal: space.lg,
    marginBottom: space.xs,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: space.sm,
    alignItems: 'center',
    borderRadius: radius.sm,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  tabBtnActive: {
    backgroundColor: 'rgba(234,179,8,0.12)',
    borderColor: colors.primary,
  },
  tabTxt: {
    color: colors.textMuted,
    fontSize: font.tiny,
    fontWeight: '700',
  },
  tabTxtActive: {
    color: colors.primary,
    fontWeight: '900',
  },
  list: { padding: space.lg, gap: space.md },
  center: { alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingVertical: space.xxl },
  orderCard: { gap: space.sm, padding: space.md },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: space.xs,
    paddingBottom: space.xs,
    borderBottomWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  dateBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  dayText: { color: colors.textMuted, fontSize: font.tiny, fontWeight: '800' },
  payoutBadge: {
    backgroundColor: 'rgba(5,150,105,0.15)',
    paddingHorizontal: space.xs + 2,
    paddingVertical: 2,
    borderRadius: 4,
  },
  payoutText: { color: colors.onDuty, fontSize: font.tiny, fontWeight: '900' },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: space.xs + 2,
    paddingVertical: 2,
    borderRadius: 4,
  },
  statusText: { fontSize: font.tiny, fontWeight: '800' },
  orderTitle: { color: colors.text, fontSize: font.body, fontWeight: '900' },
  serviceName: { color: colors.primary, fontSize: font.label, fontWeight: '700' },
  reviewBox: {
    backgroundColor: 'rgba(217,119,6,0.08)',
    borderRadius: radius.sm,
    padding: space.sm,
    gap: 2,
    marginTop: 2,
  },
  reviewHeading: { color: colors.text, fontSize: font.tiny, fontWeight: '800' },
  ratingNumber: { color: colors.warning, fontSize: font.tiny, fontWeight: '800', marginLeft: 2 },
  reviewComment: { color: colors.textMuted, fontSize: font.tiny, fontStyle: 'italic', marginTop: 2 },
});
