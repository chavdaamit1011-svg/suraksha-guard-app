import { goBack } from '@/lib/navigation';
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
              <Card key={s.rosterId} style={{ ...styles.cardContainer, ...(isToday ? { borderColor: colors.primary } : null) }}>
                <View style={styles.row}>
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
                    <Ionicons name={tone.icon} size={20} color={tone.color} />
                    <Text style={[styles.status, { color: tone.color }]}>{s.status}</Text>
                    {s.payout ? (
                      <Text style={styles.payoutBadge}>₹{s.payout}</Text>
                    ) : null}
                  </View>
                </View>

                {/* Event Type & Dress Code Tags */}
                {(s.eventType || s.dressRequirement) ? (
                  <View style={styles.tagRow}>
                    {s.eventType ? (
                      <View style={styles.eventTag}>
                        <Ionicons name="calendar-outline" size={12} color={colors.warning} />
                        <Text style={styles.eventTagText}>Event: {s.eventType}</Text>
                      </View>
                    ) : null}
                    {s.dressRequirement ? (
                      <View style={styles.dressTag}>
                        <Ionicons name="shirt-outline" size={12} color={colors.primary} />
                        <Text style={styles.dressTagText}>Uniform: {s.dressRequirement}</Text>
                      </View>
                    ) : null}
                  </View>
                ) : null}

                {/* Special Instructions from Client */}
                {s.specialInstructions ? (
                  <View style={styles.instructionsBox}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 2 }}>
                      <Ionicons name="document-text-outline" size={12} color={colors.warning} />
                      <Text style={styles.instructionsLabel}>Special Instructions</Text>
                    </View>
                    <Text style={styles.instructionsText} numberOfLines={3}>
                      "{s.specialInstructions}"
                    </Text>
                  </View>
                ) : null}

                {/* Client Rating & Review */}
                {s.clientRating ? (
                  <View style={styles.reviewBox}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <Ionicons name="star" size={13} color={colors.warning} />
                      <Text style={styles.ratingScore}>{s.clientRating}.0</Text>
                      <Text style={styles.reviewAuthor}>Client Review</Text>
                    </View>
                    {s.clientReview ? (
                      <Text style={styles.reviewText}>"{s.clientReview}"</Text>
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
    padding: space.md,
  },
  offlineText: { color: colors.warning, fontSize: font.tiny, fontWeight: '700', flex: 1 },
  list: { padding: space.lg, gap: space.md },
  center: { alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingVertical: space.xxl },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  cardContainer: { gap: space.sm, paddingVertical: space.md },
  dayCol: { width: 92, gap: 2 },
  day: { color: colors.text, fontSize: font.label, fontWeight: '900' },
  time: { color: colors.textMuted, fontSize: font.label, fontWeight: '700' },
  site: { color: colors.text, fontSize: font.body, fontWeight: '800' },
  statusCol: { alignItems: 'center', gap: 4, width: 72 },
  status: { fontSize: font.tiny, fontWeight: '800', textAlign: 'center' },
  payoutBadge: { fontSize: 11, fontWeight: '900', color: colors.primary, backgroundColor: 'rgba(245, 198, 35, 0.12)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  eventTag: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(245, 198, 35, 0.1)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1, borderColor: 'rgba(245, 198, 35, 0.25)' },
  eventTagText: { fontSize: 11, fontWeight: '700', color: colors.warning },
  dressTag: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255, 255, 255, 0.06)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.12)' },
  dressTagText: { fontSize: 11, fontWeight: '600', color: colors.text },
  instructionsBox: { backgroundColor: 'rgba(255, 255, 255, 0.04)', borderRadius: 8, padding: 8, marginTop: 4, borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.1)' },
  instructionsLabel: { fontSize: 9, fontWeight: '800', color: colors.warning, textTransform: 'uppercase' },
  instructionsText: { fontSize: 11, color: colors.text, fontStyle: 'italic', lineHeight: 16 },
  reviewBox: { backgroundColor: 'rgba(245, 198, 35, 0.06)', borderRadius: 8, padding: 8, marginTop: 4, borderWidth: 1, borderColor: 'rgba(245, 198, 35, 0.2)' },
  ratingScore: { fontSize: 12, fontWeight: '900', color: colors.warning },
  reviewAuthor: { fontSize: 10, color: colors.textMuted, fontWeight: '700' },
  reviewText: { fontSize: 11, color: colors.text, fontStyle: 'italic', marginTop: 2 },
});
