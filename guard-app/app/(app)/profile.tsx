import { goBack } from '@/lib/navigation';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Platform,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Button, Card, H1, H2, Muted, Screen } from '@/components/ui';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { resolveMediaUrl } from '@/lib/media';
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

  // Profile Selfie State
  const [cameraOpen, setCameraOpen] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [profileImageError, setProfileImageError] = useState(false);

  const resolvedPhoto = resolveMediaUrl(guard?.profilePhoto || guard?.selfieUrl || guard?.docPhoto);

  useEffect(() => {
    setProfileImageError(false);
  }, [guard?._id, guard?.profilePhoto, guard?.selfieUrl]);

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

  const openCamera = async () => {
    setCameraOpen(true);
    setCameraReady(false);
    setCameraError('');
    setPreviewUri(null);
    if (!permission?.granted) {
      void requestPermission().catch(() =>
        setCameraError('Could not open the camera. Check camera permission.')
      );
    }
  };

  const capturePhoto = async () => {
    if (!cameraReady || capturing) return;
    setCapturing(true);
    setCameraError('');
    try {
      const shot = await cameraRef.current?.takePictureAsync({ quality: 0.65, skipProcessing: true });
      if (!shot?.uri) throw new Error('Camera did not return a photo. Please try again.');
      const manipulated = await ImageManipulator.manipulateAsync(
        shot.uri,
        [{ resize: { width: 720 } }],
        { compress: 0.65, format: ImageManipulator.SaveFormat.JPEG, base64: true }
      );
      if (!manipulated.base64) throw new Error('Could not process photo.');
      setPreviewUri(`data:image/jpeg;base64,${manipulated.base64}`);
    } catch (err: any) {
      setCameraError(err.message || 'Could not capture photo.');
    } finally {
      setCapturing(false);
    }
  };

  const saveProfilePhoto = async () => {
    if (!previewUri || !id) return;
    setUploading(true);
    try {
      const res = await api.uploadProfilePhoto(id, previewUri);
      if (res.success && res.profilePhoto) {
        const updatedGuard = {
          ...guard!,
          profilePhoto: res.profilePhoto,
          selfieUrl: res.profilePhoto,
          docPhoto: res.profilePhoto,
        };
        await useAuth.getState().setGuard(updatedGuard);
        setCameraOpen(false);
        setPreviewUri(null);
        Alert.alert('Profile Photo Updated', 'Your official profile selfie has been saved and will be shown to clients.');
      } else {
        throw new Error((res as any)?.message || 'Upload failed');
      }
    } catch (err: any) {
      Alert.alert('Upload Error', err?.message || 'Failed to save profile photo');
    } finally {
      setUploading(false);
    }
  };

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
        <Pressable onPress={openCamera} style={styles.avatarWrap} accessibilityLabel="Change Profile Photo">
          <View style={styles.avatar}>
            {resolvedPhoto && !profileImageError ? (
              <Image
                source={{ uri: resolvedPhoto }}
                style={styles.avatarImg}
                resizeMode="cover"
                onError={() => setProfileImageError(true)}
              />
            ) : (
              <View style={styles.initialsBox}>
                <Text style={styles.avatarText}>{(guard?.name ?? 'G').slice(0, 1).toUpperCase()}</Text>
              </View>
            )}
          </View>
          <View style={styles.cameraIconBadge}>
            <Ionicons name="camera" size={16} color="#0B0D0F" />
          </View>
        </Pressable>
        <View style={{ alignItems: 'center', gap: 2 }}>
          <H2>{guard?.name ?? 'Guard'}</H2>
          <Text style={{ fontSize: 13, color: colors.textMuted }}>
            {guard?.type ?? 'Security Guard'} · {guard?.agencyName || guard?.branch || 'Suraksha'}
          </Text>
        </View>
        <Pressable onPress={openCamera} style={styles.takePhotoBtn}>
          <Ionicons name="camera-outline" size={16} color={colors.primary} />
          <Text style={styles.takePhotoBtnText}>
            {resolvedPhoto ? 'Retake Official Selfie' : 'Take Official Profile Selfie'}
          </Text>
        </Pressable>
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

      {/* Profile Selfie Capture Modal */}
      <Modal visible={cameraOpen} animationType="slide" onRequestClose={() => { if (!capturing && !uploading) setCameraOpen(false); }}>
        <Screen>
          <H1>Official Profile Selfie</H1>
          <Muted>Look directly at the front camera. This photo is set as your official profile picture and displayed to clients when you are assigned.</Muted>
          {cameraError ? <Text style={{ color: colors.danger, fontWeight: '700' }}>{cameraError}</Text> : null}

          {previewUri ? (
            <View style={{ gap: space.md }}>
              <Image source={{ uri: previewUri }} style={styles.cameraPreview} resizeMode="contain" />
              <Button label="Save as Profile Photo" onPress={saveProfilePhoto} loading={uploading} variant="success" />
              <Button label="Retake photo" variant="ghost" disabled={uploading} onPress={() => { setPreviewUri(null); setCameraReady(false); }} />
            </View>
          ) : cameraOpen && permission?.granted ? (
            <View style={{ gap: space.md }}>
              <View style={styles.cameraPreviewWrap}>
                <CameraView
                  ref={cameraRef}
                  style={styles.cameraPreview}
                  facing="front"
                  onCameraReady={() => setCameraReady(true)}
                  onMountError={() => {
                    setCameraReady(false);
                    setCameraError('Camera could not start. Please check camera permissions and retry.');
                  }}
                />
                <View style={styles.cameraOval} pointerEvents="none" />
              </View>
              <Button label="Capture Selfie" onPress={capturePhoto} loading={capturing} disabled={!cameraReady || capturing} />
            </View>
          ) : (
            <View style={{ gap: space.md, paddingVertical: space.xl }}>
              <Muted>Allow camera access to capture your official profile photo.</Muted>
              <Button label="Grant Camera Permission" onPress={() => {
                if (Platform.OS !== 'web' && permission?.canAskAgain === false) void Linking.openSettings();
                else void requestPermission().catch(() => setCameraError('Could not request camera permission.'));
              }} />
            </View>
          )}

          <Button label="Cancel" variant="ghost" disabled={capturing || uploading} onPress={() => setCameraOpen(false)} />
        </Screen>
      </Modal>
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
  avatarWrap: { position: 'relative' },
  avatar: {
    width: 92,
    height: 92,
    borderRadius: 46,
    backgroundColor: '#1C2028',
    borderWidth: 2.5,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImg: { width: 92, height: 92, borderRadius: 46 },
  initialsBox: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(245, 198, 35, 0.15)',
  },
  avatarText: { color: colors.primary, fontWeight: '900', fontSize: font.h1 },
  cameraIconBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#0B0D0F',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
    elevation: 3,
  },
  takePhotoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.full,
    backgroundColor: 'rgba(245,198,35,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(245,198,35,0.3)',
    marginTop: 2,
  },
  takePhotoBtnText: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: '800',
  },
  cameraPreviewWrap: { position: 'relative', width: '100%', height: 380, borderRadius: radius.md, overflow: 'hidden' },
  cameraPreview: { width: '100%', height: 380, borderRadius: radius.md, backgroundColor: colors.card },
  cameraOval: {
    position: 'absolute',
    alignSelf: 'center',
    top: 40,
    width: 220,
    height: 300,
    borderRadius: 150,
    borderWidth: 3,
    borderColor: colors.primary,
    opacity: 0.85,
  },
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
