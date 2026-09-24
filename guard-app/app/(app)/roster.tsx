import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Card, H2, Muted, Body } from '@/components/ui';
import { useT } from '@/i18n';
import { api, type RosterShift, type GuardCompletedOrder } from '@/lib/api';
import { istTime } from '@/lib/duty';
import { KEYS, store } from '@/lib/storage';
import { guardId, useAuth } from '@/store/auth';
import { colors, font, radius, space } from '@/theme';

const CACHE_KEY = 'sg.roster';
const ME_CACHE_KEY = 'sg.roster.me';

const STATUS_TONE: Record<RosterShift['status'], { color: string; icon: keyof typeof Ionicons.glyphMap }> = {
  Scheduled: { color: colors.textMuted, icon: 'ellipse-outline' },
  'On duty': { color: colors.onDuty, icon: 'shield-checkmark' },
  Late: { color: colors.warning, icon: 'alert-circle' },
  Completed: { color: colors.onDuty, icon: 'checkmark-circle' },
  Absent: { color: colors.danger, icon: 'close-circle' },
};

export default function Roster() {
  const t = useT();
  const router = useRouter();
  const guard = useAuth((s) => s.guard);

  const [tab, setTab] = useState<'orders' | 'shifts'>('orders');
  const [shifts, setShifts] = useState<RosterShift[]>([]);
  const [completedOrders, setCompletedOrders] = useState<GuardCompletedOrder[]>([]);
  const [totalEarnings, setTotalEarnings] = useState<number>(0);
  const [averageRating, setAverageRating] = useState<number | null>(null);
  const [totalReviews, setTotalReviews] = useState<number>(0);

  const [today, setToday] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [offline, setOffline] = useState(false);

  const load = useCallback(async () => {
    const id = guardId(guard);
    if (!id) return;
    try {
      const [resRoster, resMe] = await Promise.all([
        api.roster(id, { days: 9 }).catch(() => null),
        api.me(id).catch(() => null),
      ]);

      if (resRoster) {
        setShifts(resRoster.shifts ?? []);
        setToday(resRoster.today);
        await store.setJSON(CACHE_KEY, { shifts: resRoster.shifts, today: resRoster.today });
      }

      if (resMe?.success) {
        setCompletedOrders(resMe.earnings?.history ?? []);
        setTotalEarnings(resMe.earnings?.totalEarnings ?? 0);
        setAverageRating(resMe.reviews?.averageRating ?? null);
        setTotalReviews(resMe.reviews?.totalReviews ?? 0);
        await store.setJSON(ME_CACHE_KEY, resMe);
      }

      setOffline(false);
    } catch {
      const [cachedRoster, cachedMe] = await Promise.all([
        store.getJSON<{ shifts: RosterShift[]; today: string } | null>(CACHE_KEY, null),
        store.getJSON<any | null>(ME_CACHE_KEY, null),
      ]);

      if (cachedRoster) {
        setShifts(cachedRoster.shifts ?? []);
        setToday(cachedRoster.today);
      }
      if (cachedMe) {
        setCompletedOrders(cachedMe.earnings?.history ?? []);
        setTotalEarnings(cachedMe.earnings?.totalEarnings ?? 0);
        setAverageRating(cachedMe.reviews?.averageRating ?? null);
        setTotalReviews(cachedMe.reviews?.totalReviews ?? 0);
      }
      setOffline(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [guard]);

  useEffect(() => {
    Promise.all([
      store.getJSON<{ shifts: RosterShift[]; today: string } | null>(CACHE_KEY, null),
      store.getJSON<any | null>(ME_CACHE_KEY, null),
    ]).then(([cachedRoster, cachedMe]) => {
      if (cachedRoster) {
        setShifts(cachedRoster.shifts ?? []);
        setToday(cachedRoster.today);
      }
      if (cachedMe) {
        setCompletedOrders(cachedMe.earnings?.history ?? []);
        setTotalEarnings(cachedMe.earnings?.totalEarnings ?? 0);
        setAverageRating(cachedMe.reviews?.averageRating ?? null);
        setTotalReviews(cachedMe.reviews?.totalReviews ?? 0);
      }
      if (cachedRoster || cachedMe) setLoading(false);
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
      {/* Top Header */}
      <View style={styles.head}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <H2>My Roster & Orders</H2>
        <Pressable onPress={() => router.push('/earnings')} hitSlop={12} style={styles.walletIconBtn}>
          <Ionicons name="wallet-outline" size={22} color={colors.primary} />
        </Pressable>
      </View>

      {offline ? (
        <View style={styles.offline}>
          <Ionicons name="cloud-offline" size={14} color={colors.warning} />
          <Text style={styles.offlineText}>{t('offlineBanner')}</Text>
        </View>
      ) : null}

      {/* KPI Overview Strip */}
      <View style={styles.kpiContainer}>
        <View style={styles.kpiBox}>
          <Text style={styles.kpiNumber}>{completedOrders.length}</Text>
          <Text style={styles.kpiLabel}>Orders Completed</Text>
        </View>
        <View style={styles.kpiDivider} />
        <View style={styles.kpiBox}>
          <Text style={[styles.kpiNumber, { color: colors.onDuty }]}>₹{totalEarnings.toLocaleString('en-IN')}</Text>
          <Text style={styles.kpiLabel}>Total Earned</Text>
        </View>
        <View style={styles.kpiDivider} />
        <View style={styles.kpiBox}>
          <View style={styles.ratingRow}>
            <Ionicons name="star" size={14} color="#F5C623" />
            <Text style={[styles.kpiNumber, { color: '#F5C623' }]}>
              {averageRating ? averageRating.toFixed(1) : '5.0'}
            </Text>
          </View>
          <Text style={styles.kpiLabel}>{totalReviews} Reviews</Text>
        </View>
      </View>

      {/* Segmented Tab Controls */}
      <View style={styles.tabsWrapper}>
        <Pressable
          onPress={() => setTab('orders')}
          style={[styles.tabButton, tab === 'orders' && styles.tabButtonActive]}
        >
          <Ionicons
            name="checkmark-done-circle"
            size={16}
            color={tab === 'orders' ? colors.primary : colors.textMuted}
          />
          <Text style={[styles.tabText, tab === 'orders' && styles.tabTextActive]}>
            Completed Orders ({completedOrders.length})
          </Text>
        </Pressable>

        <Pressable
          onPress={() => setTab('shifts')}
          style={[styles.tabButton, tab === 'shifts' && styles.tabButtonActive]}
        >
          <Ionicons
            name="calendar"
            size={16}
            color={tab === 'shifts' ? colors.primary : colors.textMuted}
          />
          <Text style={[styles.tabText, tab === 'shifts' && styles.tabTextActive]}>
            Scheduled Shifts ({shifts.length})
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
        {loading && shifts.length === 0 && completedOrders.length === 0 ? (
          <Card style={styles.center}>
            <ActivityIndicator color={colors.primary} />
            <Muted>{t('common.loading')}</Muted>
          </Card>
        ) : tab === 'orders' ? (
          /* ============================================================== */
          /* COMPLETED ORDERS & REVIEWS VIEW                                */
          /* ============================================================== */
          completedOrders.length === 0 ? (
            <Card style={styles.center}>
              <Ionicons name="briefcase-outline" size={40} color={colors.textFaint} />
              <Body style={{ fontWeight: '800', textAlign: 'center', marginTop: space.xs }}>
                No Completed Orders Yet
              </Body>
              <Muted style={{ textAlign: 'center', fontSize: 12 }}>
                As you accept client requests and complete security duties, your order history, earnings, and client ratings will appear here.
              </Muted>
            </Card>
          ) : (
            completedOrders.map((order) => {
              const hasRating = order.rating && typeof order.rating.score === 'number';
              return (
                <Card key={order.bookingId} style={styles.orderCard}>
                  {/* Card Header */}
                  <View style={styles.rowBetween}>
                    <View style={styles.orderIdBadge}>
                      <Text style={styles.orderIdText}>#{order.bookingId}</Text>
                    </View>
                    <View style={styles.orderPayoutBadge}>
                      <Text style={styles.orderPayoutText}>+₹{order.earned.toLocaleString('en-IN')}</Text>
                    </View>
                  </View>

                  {/* Customer and Service Info */}
                  <View style={{ gap: 2, marginTop: 4 }}>
                    <Text style={styles.orderCustomer}>{order.customerName}</Text>
                    <Text style={styles.orderService}>{order.serviceType}</Text>
                  </View>

                  {/* Meta Details */}
                  <View style={styles.metaBox}>
                    <View style={styles.metaItem}>
                      <Ionicons name="time-outline" size={13} color={colors.textMuted} />
                      <Text style={styles.metaItemText}>
                        {order.scheduledDate ? `${order.scheduledDate} · ` : ''}
                        {order.duration} hrs duty
                      </Text>
                    </View>
                    <View style={styles.metaItem}>
                      <Ionicons name="location-outline" size={13} color={colors.textMuted} />
                      <Text style={styles.metaItemText} numberOfLines={1}>
                        {order.location}
                      </Text>
                    </View>
                  </View>

                  {/* Client Review & Rating Box */}
                  <View style={[styles.reviewBox, hasRating ? styles.reviewBoxRated : styles.reviewBoxUnrated]}>
                    {hasRating ? (
                      <View style={{ gap: 4 }}>
                        <View style={styles.rowBetween}>
                          <View style={styles.starsRow}>
                            {[1, 2, 3, 4, 5].map((s) => (
                              <Ionicons
                                key={s}
                                name={s <= (order.rating?.score || 5) ? 'star' : 'star-outline'}
                                size={14}
                                color={s <= (order.rating?.score || 5) ? '#F5C623' : colors.textFaint}
                              />
                            ))}
                            <Text style={styles.ratingNumberText}>
                              {order.rating?.score}.0 Client Rating
                            </Text>
                          </View>
                          <Text style={styles.verifiedBadge}>Verified</Text>
                        </View>

                        {order.rating?.review ? (
                          <Text style={styles.reviewComment}>"{order.rating.review}"</Text>
                        ) : null}

                        {order.rating?.ratedAt ? (
                          <Text style={styles.reviewTime}>
                            Reviewed on {new Date(order.rating.ratedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                          </Text>
                        ) : null}
                      </View>
                    ) : (
                      <View style={styles.unratedRow}>
                        <Ionicons name="hourglass-outline" size={14} color={colors.textFaint} />
                        <Text style={styles.unratedText}>Awaiting client rating & review</Text>
                      </View>
                    )}
                  </View>
                </Card>
              );
            })
          )
        ) : (
          /* ============================================================== */
          /* SCHEDULED ROSTER SHIFTS VIEW                                   */
          /* ============================================================== */
          shifts.length === 0 ? (
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
          )
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
  walletIconBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
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
  kpiContainer: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    marginHorizontal: space.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: space.md,
    alignItems: 'center',
  },
  kpiBox: { flex: 1, alignItems: 'center', gap: 2 },
  kpiNumber: { color: colors.text, fontSize: font.h3, fontWeight: '900' },
  kpiLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '700' },
  kpiDivider: { width: 1, height: 32, backgroundColor: colors.border },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  tabsWrapper: {
    flexDirection: 'row',
    marginHorizontal: space.lg,
    marginTop: space.sm,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 3,
    gap: 4,
  },
  tabButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    borderRadius: radius.sm,
  },
  tabButtonActive: {
    backgroundColor: 'rgba(245, 198, 35, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(245, 198, 35, 0.3)',
  },
  tabText: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },
  tabTextActive: { color: colors.primary, fontWeight: '900' },
  list: { padding: space.lg, gap: space.md },
  center: { alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingVertical: space.xxl },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  orderCard: { gap: space.xs },
  orderIdBadge: {
    backgroundColor: colors.bgElevated,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  orderIdText: { color: colors.textMuted, fontSize: 11, fontFamily: 'monospace', fontWeight: '800' },
  orderPayoutBadge: {
    backgroundColor: colors.onDutyDim,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.onDuty,
  },
  orderPayoutText: { color: colors.onDuty, fontSize: 12, fontWeight: '900' },
  orderCustomer: { color: colors.text, fontSize: font.h3, fontWeight: '900' },
  orderService: { color: colors.primary, fontSize: font.label, fontWeight: '700' },
  metaBox: {
    flexDirection: 'row',
    gap: space.lg,
    flexWrap: 'wrap',
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaItemText: { color: colors.textMuted, fontSize: 11, fontWeight: '600' },
  reviewBox: {
    borderRadius: radius.md,
    padding: space.sm + 2,
    marginTop: 4,
  },
  reviewBoxRated: {
    backgroundColor: 'rgba(245, 198, 35, 0.05)',
    borderWidth: 1,
    borderColor: 'rgba(245, 198, 35, 0.2)',
  },
  reviewBoxUnrated: {
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
  },
  starsRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  ratingNumberText: { color: '#F5C623', fontSize: 11, fontWeight: '800', marginLeft: 4 },
  verifiedBadge: {
    fontSize: 9,
    fontWeight: '800',
    color: colors.onDuty,
    backgroundColor: colors.onDutyDim,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  reviewComment: { color: colors.text, fontSize: 12, fontStyle: 'italic', lineHeight: 17 },
  reviewTime: { color: colors.textFaint, fontSize: 10, fontFamily: 'monospace' },
  unratedRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 },
  unratedText: { color: colors.textFaint, fontSize: 11, fontStyle: 'italic' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  dayCol: { width: 92, gap: 2 },
  day: { color: colors.text, fontSize: font.label, fontWeight: '900' },
  time: { color: colors.textMuted, fontSize: font.label, fontWeight: '700' },
  site: { color: colors.text, fontSize: font.body, fontWeight: '800' },
  statusCol: { alignItems: 'center', gap: 2, width: 72 },
  status: { fontSize: font.tiny, fontWeight: '800', textAlign: 'center' },
});
