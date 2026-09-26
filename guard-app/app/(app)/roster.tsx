import { goBack } from '@/lib/navigation';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Card, H2, Muted } from '@/components/ui';
import { useT } from '@/i18n';
import { api, type ContractOffer, type RosterShift } from '@/lib/api';
import { istTime } from '@/lib/duty';
import { KEYS, store } from '@/lib/storage';
import { guardId, useAuth } from '@/store/auth';
import { colors, font, radius, space } from '@/theme';

const CACHE_KEY = 'sg.roster';

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

  const [shifts, setShifts] = useState<RosterShift[]>([]);
  const [completedContracts, setCompletedContracts] = useState<ContractOffer[]>([]);
  const [activeContracts, setActiveContracts] = useState<ContractOffer[]>([]);
  const [totalEarned, setTotalEarned] = useState<number>(0);
  const [today, setToday] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [offline, setOffline] = useState(false);
  const [activeTab, setActiveTab] = useState<'contracts' | 'shifts'>('contracts');
  const [expandedContractId, setExpandedContractId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const id = guardId(guard);
    if (!id) return;
    try {
      const res = await api.roster(id, { days: 14 });
      setShifts(res.shifts ?? []);
      setCompletedContracts(res.completedContracts ?? []);
      setActiveContracts(res.activeContracts ?? []);
      setTotalEarned(res.totalEarned ?? 0);
      setToday(res.today);
      setOffline(false);

      if ((res.completedContracts?.length ?? 0) === 0 && (res.shifts?.length ?? 0) > 0) {
        setActiveTab('shifts');
      }

      await store.setJSON(CACHE_KEY, {
        shifts: res.shifts,
        completedContracts: res.completedContracts,
        activeContracts: res.activeContracts,
        totalEarned: res.totalEarned,
        today: res.today,
      });
    } catch {
      const cached = await store.getJSON<{
        shifts: RosterShift[];
        completedContracts?: ContractOffer[];
        activeContracts?: ContractOffer[];
        totalEarned?: number;
        today: string;
      } | null>(CACHE_KEY, null);
      if (cached) {
        setShifts(cached.shifts ?? []);
        setCompletedContracts(cached.completedContracts ?? []);
        setActiveContracts(cached.activeContracts ?? []);
        setTotalEarned(cached.totalEarned ?? 0);
        setToday(cached.today);
      }
      setOffline(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [guard]);

  useEffect(() => {
    store.getJSON<{
      shifts: RosterShift[];
      completedContracts?: ContractOffer[];
      activeContracts?: ContractOffer[];
      totalEarned?: number;
      today: string;
    } | null>(CACHE_KEY, null).then((cached) => {
      if (cached) {
        setShifts(cached.shifts ?? []);
        setCompletedContracts(cached.completedContracts ?? []);
        setActiveContracts(cached.activeContracts ?? []);
        setTotalEarned(cached.totalEarned ?? 0);
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

  const calculatedTotalEarnings = completedContracts.length > 0
    ? completedContracts.reduce((sum, c) => sum + (c.totalEarnings || ((c.completedDaysCount || c.totalDays || 1) * (c.ratePerGuard || 600))), 0)
    : totalEarned;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={styles.head}>
        <Pressable onPress={() => goBack()} hitSlop={12} accessibilityLabel="Back">
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
        {/* Earnings & Roster Summary Card */}
        <Card style={styles.summaryCard}>
          <View style={styles.summaryRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.summaryLabel}>TOTAL CONTRACT EARNINGS</Text>
              <Text style={styles.summaryAmount}>₹{calculatedTotalEarnings.toLocaleString('en-IN')}</Text>
            </View>
            <View style={styles.summaryIconWrapper}>
              <Ionicons name="wallet" size={28} color={colors.primary} />
            </View>
          </View>
          <View style={styles.summaryStatsRow}>
            <View style={styles.statBox}>
              <Text style={styles.statVal}>{completedContracts.length}</Text>
              <Text style={styles.statLabel}>Completed Contracts</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statBox}>
              <Text style={styles.statVal}>
                {shifts.filter((s) => s.status === 'Completed').length}
              </Text>
              <Text style={styles.statLabel}>Shifts Worked</Text>
            </View>
          </View>
        </Card>

        {/* Tab Switcher */}
        <View style={styles.tabs}>
          <Pressable
            style={[styles.tab, activeTab === 'contracts' && styles.tabActive]}
            onPress={() => setActiveTab('contracts')}
          >
            <Ionicons
              name="briefcase"
              size={16}
              color={activeTab === 'contracts' ? '#0B0D0F' : colors.textMuted}
            />
            <Text style={[styles.tabText, activeTab === 'contracts' && styles.tabTextActive]}>
              Completed Contracts ({completedContracts.length})
            </Text>
          </Pressable>

          <Pressable
            style={[styles.tab, activeTab === 'shifts' && styles.tabActive]}
            onPress={() => setActiveTab('shifts')}
          >
            <Ionicons
              name="calendar"
              size={16}
              color={activeTab === 'shifts' ? '#0B0D0F' : colors.textMuted}
            />
            <Text style={[styles.tabText, activeTab === 'shifts' && styles.tabTextActive]}>
              Daily Shifts ({shifts.length})
            </Text>
          </Pressable>
        </View>

        {/* Loading State */}
        {loading && shifts.length === 0 && completedContracts.length === 0 ? (
          <Card style={styles.center}>
            <ActivityIndicator color={colors.primary} />
            <Muted>{t('common.loading')}</Muted>
          </Card>
        ) : activeTab === 'contracts' ? (
          /* COMPLETED CONTRACTS TAB */
          completedContracts.length === 0 ? (
            <Card style={styles.center}>
              <Ionicons name="briefcase-outline" size={38} color={colors.textFaint} />
              <Text style={styles.emptyTitle}>No Completed Contracts Yet</Text>
              <Muted style={{ textAlign: 'center' }}>
                When you finish all days of an assigned contract, it will appear here with your total earnings summary.
              </Muted>
            </Card>
          ) : (
            completedContracts.map((c) => {
              const totalDays = c.totalDays || 1;
              const completedDays = c.completedDaysCount || totalDays;
              const rate = c.ratePerGuard || 600;
              const earnings = c.totalEarnings || (completedDays * rate);
              const isExpanded = expandedContractId === c.contractId;

              return (
                <Card key={c.contractId} style={styles.contractCard}>
                  {/* Card Header */}
                  <View style={styles.contractHeader}>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Ionicons name="shield-checkmark" size={18} color={colors.primary} />
                        <Text style={styles.clientName} numberOfLines={1}>
                          {c.client}
                        </Text>
                      </View>
                      <Text style={styles.contractCode}>{c.contractCode || `CNT-${c.contractId.slice(-4).toUpperCase()}`}</Text>
                    </View>

                    <View style={styles.completedBadge}>
                      <Ionicons name="checkmark-circle" size={14} color="#000" />
                      <Text style={styles.completedBadgeText}>COMPLETED</Text>
                    </View>
                  </View>

                  {/* Dates & Shift Info */}
                  <View style={styles.contractInfoRow}>
                    <Ionicons name="calendar-outline" size={14} color={colors.textMuted} />
                    <Text style={styles.contractInfoText}>
                      {c.startDate} to {c.endDate} · {c.shiftTiming}
                    </Text>
                  </View>

                  {/* Progress Bar 100% */}
                  <View style={styles.progressContainer}>
                    <View style={styles.progressLabels}>
                      <Text style={styles.progressLabel}>Contract Progress</Text>
                      <Text style={styles.progressVal}>
                        {completedDays}/{totalDays} Days (100%)
                      </Text>
                    </View>
                    <View style={styles.progressBarTrack}>
                      <View style={[styles.progressBarFill, { width: '100%' }]} />
                    </View>
                  </View>

                  {/* Earnings Highlight Box */}
                  <View style={styles.earningsBox}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rateDetailText}>Rate: ₹{rate}/day ({completedDays} Days Completed)</Text>
                      <Text style={styles.totalEarningsText}>Total Earned: ₹{earnings.toLocaleString('en-IN')}</Text>
                    </View>
                    <Ionicons name="cash" size={24} color={colors.primary} />
                  </View>

                  {/* Toggle History Breakdown */}
                  {c.dailyBreakdown && c.dailyBreakdown.length > 0 ? (
                    <Pressable
                      style={styles.toggleHistoryBtn}
                      onPress={() => setExpandedContractId(isExpanded ? null : c.contractId)}
                    >
                      <Text style={styles.toggleHistoryText}>
                        {isExpanded ? 'Hide Daily Attendance' : 'View Daily Attendance History'}
                      </Text>
                      <Ionicons
                        name={isExpanded ? 'chevron-up' : 'chevron-down'}
                        size={16}
                        color={colors.primary}
                      />
                    </Pressable>
                  ) : null}

                  {/* Expanded Breakdown */}
                  {isExpanded && c.dailyBreakdown ? (
                    <View style={styles.breakdownList}>
                      {c.dailyBreakdown.map((item, idx) => (
                        <View key={idx} style={styles.breakdownRow}>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.breakdownDate}>Day {idx + 1}: {item.date}</Text>
                            {item.checkInTime || item.checkOutTime ? (
                              <Text style={styles.breakdownTime}>
                                In: {item.checkInTime ? istTime(item.checkInTime) : '—'} | Out: {item.checkOutTime ? istTime(item.checkOutTime) : '—'}
                              </Text>
                            ) : null}
                          </View>
                          <View style={styles.dayStatusBadge}>
                            <Ionicons name="checkmark-circle" size={13} color={colors.onDuty} />
                            <Text style={styles.dayStatusText}>{item.status}</Text>
                          </View>
                        </View>
                      ))}
                    </View>
                  ) : null}
                </Card>
              );
            })
          )
        ) : (
          /* DAILY SHIFTS TAB */
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
                    {s.status === 'Completed' && s.payout ? (
                      <Text style={styles.shiftEarned}>+ ₹{s.payout} Earned</Text>
                    ) : null}
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

  // Summary Card
  summaryCard: {
    backgroundColor: '#16191E',
    borderColor: 'rgba(255, 193, 7, 0.25)',
    borderWidth: 1,
    padding: space.lg,
    gap: space.md,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  summaryLabel: {
    color: colors.primary,
    fontSize: font.tiny,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  summaryAmount: {
    color: '#FFF',
    fontSize: 26,
    fontWeight: '900',
    marginTop: 2,
  },
  summaryIconWrapper: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255, 193, 7, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  summaryStatsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.08)',
    paddingTop: space.md,
  },
  statBox: {
    flex: 1,
    alignItems: 'center',
  },
  statVal: {
    color: colors.text,
    fontSize: font.body,
    fontWeight: '900',
  },
  statLabel: {
    color: colors.textMuted,
    fontSize: font.tiny,
    fontWeight: '700',
    marginTop: 2,
  },
  statDivider: {
    width: 1,
    height: 24,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },

  // Tabs
  tabs: {
    flexDirection: 'row',
    backgroundColor: '#121418',
    borderRadius: radius.md,
    padding: 4,
    gap: 6,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: radius.sm,
  },
  tabActive: {
    backgroundColor: colors.primary,
  },
  tabText: {
    color: colors.textMuted,
    fontSize: font.label,
    fontWeight: '800',
  },
  tabTextActive: {
    color: '#0B0D0F',
    fontWeight: '900',
  },

  // Contract Card
  contractCard: {
    backgroundColor: '#16191E',
    borderColor: 'rgba(255, 255, 255, 0.08)',
    padding: space.lg,
    gap: space.md,
  },
  contractHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  clientName: {
    color: colors.text,
    fontSize: font.h3,
    fontWeight: '900',
  },
  contractCode: {
    color: colors.textMuted,
    fontSize: font.tiny,
    fontWeight: '800',
    marginTop: 2,
  },
  completedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.primary,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  completedBadgeText: {
    color: '#0B0D0F',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  contractInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  contractInfoText: {
    color: colors.textMuted,
    fontSize: font.label,
    fontWeight: '600',
  },
  progressContainer: {
    gap: 6,
  },
  progressLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  progressLabel: {
    color: colors.textMuted,
    fontSize: font.tiny,
    fontWeight: '700',
  },
  progressVal: {
    color: colors.primary,
    fontSize: font.tiny,
    fontWeight: '900',
  },
  progressBarTrack: {
    height: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
  },
  earningsBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(255, 193, 7, 0.08)',
    borderColor: 'rgba(255, 193, 7, 0.25)',
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: space.md,
  },
  rateDetailText: {
    color: colors.textMuted,
    fontSize: font.tiny,
    fontWeight: '700',
  },
  totalEarningsText: {
    color: colors.primary,
    fontSize: font.body,
    fontWeight: '900',
    marginTop: 2,
  },
  toggleHistoryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: space.xs,
  },
  toggleHistoryText: {
    color: colors.primary,
    fontSize: font.label,
    fontWeight: '800',
  },
  breakdownList: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.08)',
    paddingTop: space.sm,
    gap: space.sm,
  },
  breakdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1C2026',
    borderRadius: radius.sm,
    padding: space.sm,
  },
  breakdownDate: {
    color: colors.text,
    fontSize: font.label,
    fontWeight: '800',
  },
  breakdownTime: {
    color: colors.textMuted,
    fontSize: font.tiny,
    fontWeight: '600',
    marginTop: 2,
  },
  dayStatusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  dayStatusText: {
    color: colors.onDuty,
    fontSize: 10,
    fontWeight: '800',
  },

  // Shifts List
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  dayCol: { width: 92, gap: 2 },
  day: { color: colors.text, fontSize: font.label, fontWeight: '900' },
  time: { color: colors.textMuted, fontSize: font.label, fontWeight: '700' },
  site: { color: colors.text, fontSize: font.body, fontWeight: '800' },
  statusCol: { alignItems: 'center', gap: 2, width: 72 },
  status: { fontSize: font.tiny, fontWeight: '800', textAlign: 'center' },
  shiftEarned: {
    color: colors.primary,
    fontSize: font.tiny,
    fontWeight: '800',
    marginTop: 2,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: font.body,
    fontWeight: '900',
    marginTop: space.xs,
  },
});

