import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Body, Card, H2, Muted, Screen } from '@/components/ui';
import { useT } from '@/i18n';
import { api, type GuardReviewItem } from '@/lib/api';
import { guardId, useAuth } from '@/store/auth';
import { colors, font, radius, space } from '@/theme';

export default function Profile() {
  const t = useT();
  const router = useRouter();
  const guard = useAuth((s) => s.guard);

  const [loading, setLoading] = useState(true);
  const [averageRating, setAverageRating] = useState<number | null>(null);
  const [totalReviews, setTotalReviews] = useState<number>(0);
  const [reviews, setReviews] = useState<GuardReviewItem[]>([]);
  const [completedCount, setCompletedCount] = useState<number>(0);
  const [totalEarned, setTotalEarned] = useState<number>(0);

  const loadData = useCallback(async () => {
    const id = guardId(guard);
    if (!id) return;
    try {
      setLoading(true);
      const res = await api.me(id);
      if (res.success) {
        setAverageRating(res.reviews?.averageRating ?? null);
        setTotalReviews(res.reviews?.totalReviews ?? 0);
        setReviews(res.reviews?.items ?? []);
        setCompletedCount(res.earnings?.history?.length ?? 0);
        setTotalEarned(res.earnings?.totalEarnings ?? 0);
      }
    } catch (e) {
      console.warn('Failed to load guard me info:', e);
    } finally {
      setLoading(false);
    }
  }, [guard]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  return (
    <Screen>
      <View style={styles.head}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <H2>{t('profile.title')}</H2>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* Guard Hero */}
        <View style={styles.hero}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{(guard?.name ?? 'G').slice(0, 1).toUpperCase()}</Text>
          </View>
          <H2>{guard?.name ?? 'Guard'}</H2>

          {/* Real Rating Pill */}
          <View style={styles.ratingBadge}>
            <Ionicons name="star" size={16} color="#F5C623" />
            <Text style={styles.ratingScore}>
              {averageRating ? `${averageRating.toFixed(1)} / 5.0` : '5.0'}
            </Text>
            <Text style={styles.ratingCount}>
              ({totalReviews} {totalReviews === 1 ? 'Verified Review' : 'Verified Reviews'})
            </Text>
          </View>

          {/* KPI Strip */}
          <View style={styles.kpiRow}>
            <View style={styles.kpiCard}>
              <Text style={styles.kpiVal}>{completedCount}</Text>
              <Text style={styles.kpiLbl}>Completed Duties</Text>
            </View>
            <View style={styles.kpiCard}>
              <Text style={[styles.kpiVal, { color: colors.onDuty }]}>₹{totalEarned.toLocaleString('en-IN')}</Text>
              <Text style={styles.kpiLbl}>Total Earned</Text>
            </View>
          </View>
        </View>

        {/* Guard Details */}
        <Card>
          <Row icon="call" label={t('profile.phone')} value={guard?.phone ?? '—'} />
          <Row icon="location" label={t('profile.city')} value={guard?.city ?? '—'} />
          <Row icon="shield" label={t('profile.type')} value={guard?.type ?? '—'} />
          <Row icon="business" label={t('profile.agency')} value={guard?.agencyName ?? '—'} />
          <Row icon="cash" label={t('profile.wage')} value={guard?.wage ?? '—'} />
        </Card>

        {/* Client Reviews Section */}
        <Card style={styles.reviewsCard}>
          <View style={styles.reviewsHeader}>
            <View>
              <Text style={styles.sectionTitle}>Client Reviews & Ratings</Text>
              <Muted style={{ fontSize: 11 }}>Real feedback from clients on completed orders</Muted>
            </View>
            {averageRating && (
              <View style={styles.scoreChip}>
                <Ionicons name="star" size={13} color="#F5C623" />
                <Text style={styles.scoreChipText}>{averageRating.toFixed(1)}</Text>
              </View>
            )}
          </View>

          {loading ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : reviews.length === 0 ? (
            <View style={styles.emptyReviews}>
              <Ionicons name="chatbubble-ellipses-outline" size={32} color={colors.textFaint} />
              <Body style={{ fontSize: 13, fontWeight: '700', textAlign: 'center', marginTop: space.xs }}>
                No Client Reviews Yet
              </Body>
              <Muted style={{ fontSize: 11, textAlign: 'center' }}>
                When customers rate your completed duty, their reviews and star ratings will show here.
              </Muted>
            </View>
          ) : (
            <View style={{ gap: space.sm, marginTop: space.xs }}>
              {reviews.map((r, i) => (
                <View key={r.bookingId || i} style={styles.reviewItem}>
                  <View style={styles.reviewTop}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.reviewerName}>{r.customerName}</Text>
                      <Muted style={{ fontSize: 10 }}>
                        {r.serviceType}{r.city ? ` · ${r.city}` : ''}
                      </Muted>
                    </View>
                    <View style={styles.starsRow}>
                      {[1, 2, 3, 4, 5].map((s) => (
                        <Ionicons
                          key={s}
                          name={s <= r.score ? 'star' : 'star-outline'}
                          size={13}
                          color={s <= r.score ? '#F5C623' : colors.textFaint}
                        />
                      ))}
                    </View>
                  </View>

                  {r.review ? (
                    <Text style={styles.reviewBody}>"{r.review}"</Text>
                  ) : null}

                  <Text style={styles.reviewDate}>
                    Booking #{r.bookingId} · {new Date(r.ratedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </Card>
      </ScrollView>
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
  scrollContent: { gap: space.md, paddingBottom: space.xxl },
  hero: { alignItems: 'center', gap: space.xs, marginTop: space.xs },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: colors.card,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.primary, fontWeight: '900', fontSize: font.h1 },
  ratingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(245, 198, 35, 0.12)',
    paddingHorizontal: space.md,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(245, 198, 35, 0.3)',
    marginTop: 2,
  },
  ratingScore: { color: '#F5C623', fontWeight: '900', fontSize: font.body },
  ratingCount: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },
  kpiRow: { flexDirection: 'row', gap: space.sm, width: '100%', marginTop: space.xs },
  kpiCard: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    alignItems: 'center',
  },
  kpiVal: { color: colors.text, fontSize: font.h3, fontWeight: '900' },
  kpiLbl: { color: colors.textMuted, fontSize: 11, fontWeight: '700', marginTop: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.xs },
  rowLabel: { color: colors.textMuted, fontSize: font.body, flex: 1 },
  rowValue: { color: colors.text, fontSize: font.body, fontWeight: '800', flexShrink: 1, textAlign: 'right' },
  reviewsCard: { gap: space.xs },
  reviewsHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', borderBottomWidth: 1, borderBottomColor: colors.border, paddingBottom: space.sm },
  sectionTitle: { color: colors.text, fontSize: font.label + 1, fontWeight: '900' },
  scoreChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(245,198,35,0.15)',
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(245,198,35,0.3)',
  },
  scoreChipText: { color: '#F5C623', fontSize: 11, fontWeight: '900' },
  loadingBox: { paddingVertical: space.xl, alignItems: 'center' },
  emptyReviews: { alignItems: 'center', paddingVertical: space.lg, gap: 4 },
  reviewItem: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.md,
    padding: space.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 4,
  },
  reviewTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  reviewerName: { color: colors.text, fontSize: font.label, fontWeight: '800' },
  starsRow: { flexDirection: 'row', gap: 2, alignItems: 'center' },
  reviewBody: { color: colors.text, fontSize: font.label, fontStyle: 'italic', marginTop: 2, lineHeight: 18 },
  reviewDate: { color: colors.textFaint, fontSize: 10, fontFamily: 'monospace', marginTop: 2 },
});
