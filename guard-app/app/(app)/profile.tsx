import { goBack } from '@/lib/navigation';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Card, H2, Screen } from '@/components/ui';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { guardId, useAuth } from '@/store/auth';
import { colors, font, radius, space } from '@/theme';

type ReviewItem = {
  bookingId: string;
  customerName: string;
  serviceType?: string;
  city?: string;
  score: number;
  review?: string;
  ratedAt: string | Date;
};

export default function Profile() {
  const t = useT();
  const router = useRouter();
  const guard = useAuth((s) => s.guard);
  const id = guard ? guardId(guard) : '';

  const [loading, setLoading] = useState(true);
  const [rating, setRating] = useState<number | null>(null);
  const [totalReviews, setTotalReviews] = useState<number>(0);
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [reviewsExpanded, setReviewsExpanded] = useState(false);

  const loadProfile = async () => {
    if (!id) {
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const res = await api.getMe(id);
      if (res.success) {
        setRating(res.reviews?.averageRating ?? null);
        setTotalReviews(res.reviews?.totalReviews ?? 0);
        setReviews(res.reviews?.items ?? []);
      }
    } catch (err) {
      console.error('Failed to load guard profile reviews:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProfile();
  }, [id]);

  return (
    <Screen>
      <View style={styles.head}>
        <Ionicons name="arrow-back" size={24} color={colors.text} onPress={() => goBack()} />
        <H2>{t('profile.title') || 'Profile'}</H2>
        <Pressable onPress={loadProfile} hitSlop={10}>
          <Ionicons name="refresh" size={22} color={colors.primary} />
        </Pressable>
      </View>

      <View style={styles.hero}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{(guard?.name ?? 'G').slice(0, 1).toUpperCase()}</Text>
        </View>
        <View style={{ alignItems: 'center', gap: 2 }}>
          <H2>{guard?.name ?? 'Guard'}</H2>
          <Text style={{ fontSize: 13, color: colors.textMuted }}>
            {guard?.type ?? 'Security Guard'} · {guard?.agencyName || guard?.branch || 'Suraksha'}
          </Text>
        </View>
      </View>

      {/* ---------------- SECTION 1: RATING & PERFORMANCE ---------------- */}
      <Card style={styles.ratingCard}>
        <View style={styles.rowBetween}>
          <View style={styles.rowGap}>
            <Ionicons name="star" size={20} color={colors.primary} />
            <Text style={styles.cardHeaderTitle}>Performance & Rating</Text>
          </View>
          {totalReviews > 0 ? (
            <View style={styles.ratingBadge}>
              <Ionicons name="star" size={13} color="#0B0D0F" />
              <Text style={styles.ratingBadgeText}>{rating?.toFixed(1) || '5.0'}</Text>
            </View>
          ) : (
            <View style={[styles.ratingBadge, { backgroundColor: 'rgba(34,197,94,0.15)' }]}>
              <Text style={[styles.ratingBadgeText, { color: colors.onDuty }]}>New Guard</Text>
            </View>
          )}
        </View>

        {loading ? (
          <ActivityIndicator size="small" color={colors.primary} style={{ marginVertical: 12 }} />
        ) : totalReviews > 0 ? (
          <View style={styles.ratingStatsBox}>
            <View style={{ alignItems: 'center', flex: 1 }}>
              <Text style={styles.bigRatingScore}>{rating?.toFixed(1)}</Text>
              <View style={{ flexDirection: 'row', gap: 2, marginVertical: 4 }}>
                {[1, 2, 3, 4, 5].map((s) => (
                  <Ionicons
                    key={s}
                    name={s <= Math.round(rating || 5) ? 'star' : 'star-outline'}
                    size={16}
                    color={colors.primary}
                  />
                ))}
              </View>
              <Text style={{ fontSize: 12, color: colors.textMuted, fontWeight: '700' }}>
                Based on {totalReviews} client review{totalReviews > 1 ? 's' : ''}
              </Text>
            </View>
          </View>
        ) : (
          <View style={styles.noRatingBox}>
            <Text style={{ fontSize: 13, color: colors.textMuted, textAlign: 'center' }}>
              No customer ratings yet. Complete duty orders to earn star ratings and reviews from clients!
            </Text>
          </View>
        )}
      </Card>

      {/* ---------------- SECTION 2: CUSTOMER REVIEWS (ACCORDION / DROPDOWN) ---------------- */}
      <View style={{ marginTop: space.xs }}>
        <Pressable
          onPress={() => setReviewsExpanded((prev) => !prev)}
          style={styles.accordionHeader}
        >
          <View style={styles.rowGap}>
            <Ionicons name="chatbubbles" size={18} color={colors.primary} />
            <Text style={styles.sectionTitle}>
              Customer Reviews {totalReviews > 0 ? `(${totalReviews})` : ''}
            </Text>
          </View>
          <View style={styles.rowGap}>
            <Text style={{ fontSize: 12, fontWeight: '800', color: colors.primary }}>
              {reviewsExpanded ? 'Hide' : totalReviews > 0 ? `Show (${totalReviews})` : '0 Reviews'}
            </Text>
            <Ionicons
              name={reviewsExpanded ? 'chevron-up' : 'chevron-down'}
              size={18}
              color={colors.primary}
            />
          </View>
        </Pressable>

        {reviewsExpanded ? (
          <View style={{ marginTop: 8 }}>
            {loading ? (
              <ActivityIndicator size="small" color={colors.primary} style={{ marginVertical: 12 }} />
            ) : reviews.length > 0 ? (
              <View style={{ gap: space.xs }}>
                {reviews.map((rev, idx) => (
                  <Card key={rev.bookingId || idx} style={styles.reviewCard}>
                    <View style={styles.rowBetween}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.reviewerName}>{rev.customerName}</Text>
                        <Text style={styles.reviewService}>
                          {rev.serviceType || 'Security Duty'} {rev.city ? `· ${rev.city}` : ''}
                        </Text>
                      </View>
                      <View style={styles.reviewScorePill}>
                        <Ionicons name="star" size={11} color="#0B0D0F" />
                        <Text style={styles.reviewScoreText}>{rev.score}</Text>
                      </View>
                    </View>

                    {rev.review ? (
                      <View style={styles.reviewTextBox}>
                        <Text style={styles.reviewText}>"{rev.review}"</Text>
                      </View>
                    ) : null}

                    <Text style={styles.reviewDate}>
                      {rev.ratedAt ? new Date(rev.ratedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Recently'}
                    </Text>
                  </Card>
                ))}
              </View>
            ) : (
              <Card style={{ alignItems: 'center', paddingVertical: space.md }}>
                <Ionicons name="chatbubble-ellipses-outline" size={28} color={colors.textFaint} />
                <Text style={{ fontSize: 13, color: colors.textMuted, marginTop: 4 }}>
                  No customer reviews received yet.
                </Text>
              </Card>
            )}
          </View>
        ) : null}
      </View>

      {/* ---------------- SECTION 3: ISSUED GEAR & ASSETS ---------------- */}
      <View style={{ marginTop: space.sm }}>
        <View style={styles.sectionHeaderRow}>
          <Ionicons name="cube-outline" size={18} color={colors.primary} />
          <Text style={styles.sectionTitle}>Issued Equipment & Gear</Text>
        </View>
        <Pressable
          onPress={() => router.push('/assets')}
          style={({ pressed }) => [
            styles.assetLinkCard,
            pressed && { opacity: 0.85, transform: [{ scale: 0.99 }] },
          ]}
        >
          <View style={styles.assetLinkIconWrap}>
            <Ionicons name="shield-checkmark" size={22} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.assetLinkTitle}>My Issued Gear & Handover Log</Text>
            <Text style={styles.assetLinkDesc}>
              View assigned uniform, radios, torches & return gear to store
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.primary} />
        </Pressable>
      </View>

      {/* ---------------- SECTION 4: EMPLOYMENT & PROFILE DETAILS ---------------- */}
      <View style={{ marginTop: space.sm, marginBottom: space.xl }}>
        <View style={styles.sectionHeaderRow}>
          <Ionicons name="person-outline" size={18} color={colors.primary} />
          <Text style={styles.sectionTitle}>Details</Text>
        </View>
        <Card>
          <Row icon="call" label={t('profile.phone') || 'Phone'} value={guard?.phone ?? '—'} />
          <Row icon="location" label={t('profile.city') || 'City'} value={guard?.city ?? '—'} />
          <Row icon="shield" label={t('profile.type') || 'Guard type'} value={guard?.type ?? '—'} />
          <Row icon="business" label={t('profile.agency') || 'Agency'} value={guard?.agencyName ?? '—'} />
          <Row icon="cash" label={t('profile.wage') || 'Wage'} value={guard?.wage ?? '—'} />
          {guard?.empId ? <Row icon="id-card" label="Employee ID" value={guard.empId} /> : null}
        </Card>
      </View>
    </Screen>
  );
}

function Row({ icon, label, value }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Ionicons name={icon} size={18} color={colors.primary} />
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.sm },
  hero: { alignItems: 'center', gap: space.sm, marginBottom: space.md },
  avatar: { width: 84, height: 84, borderRadius: 42, backgroundColor: colors.card, borderWidth: 2, borderColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.primary, fontWeight: '900', fontSize: font.h1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.04)' },
  rowLabel: { color: colors.textMuted, fontSize: font.body - 1, flex: 1 },
  rowValue: { color: colors.text, fontSize: font.body - 1, fontWeight: '800', flexShrink: 1, textAlign: 'right' },
  rowGap: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardHeaderTitle: { fontSize: 15, fontWeight: '900', color: colors.text },
  ratingCard: { borderColor: 'rgba(245,198,35,0.3)', borderWidth: 1.5, gap: space.sm },
  ratingBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.primary, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.sm },
  ratingBadgeText: { fontSize: 12, fontWeight: '900', color: '#0B0D0F' },
  ratingStatsBox: { backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: radius.md, padding: space.md, alignItems: 'center', marginTop: 4 },
  bigRatingScore: { fontSize: 36, fontWeight: '900', color: colors.primary, fontVariant: ['tabular-nums'] },
  noRatingBox: { backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: radius.md, padding: space.md, marginTop: 4 },
  accordionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    marginTop: 4,
  },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8, marginTop: 4 },
  sectionTitle: { fontSize: 14, fontWeight: '900', color: colors.text, textTransform: 'uppercase', letterSpacing: 0.5 },
  reviewCard: { gap: 4, backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, paddingVertical: space.sm, paddingHorizontal: space.md },
  reviewerName: { fontSize: 13, fontWeight: '800', color: colors.text },
  reviewService: { fontSize: 11, color: colors.textMuted },
  reviewScorePill: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: colors.primary, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  reviewScoreText: { fontSize: 11, fontWeight: '900', color: '#0B0D0F' },
  reviewTextBox: { backgroundColor: 'rgba(245,198,35,0.06)', borderRadius: radius.sm, padding: 6, borderLeftWidth: 3, borderLeftColor: colors.primary, marginTop: 2 },
  reviewText: { fontSize: 12, color: colors.text, fontStyle: 'italic' },
  reviewDate: { fontSize: 10, color: colors.textFaint, textAlign: 'right', marginTop: 2 },
  assetLinkCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: '#14171C',
    borderWidth: 1,
    borderColor: 'rgba(245,198,35,0.3)',
    borderRadius: radius.md,
    padding: space.md,
    marginTop: 4,
  },
  assetLinkIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(245,198,35,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  assetLinkTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.text,
  },
  assetLinkDesc: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 2,
    lineHeight: 15,
  },
});
