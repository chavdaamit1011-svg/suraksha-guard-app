import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Body, Button, Card, H2, Muted, Screen } from '@/components/ui';
import { useT } from '@/i18n';
import { successFeedback } from '@/lib/feedback';
import { api, type ReviewItem, type SupervisorTeam, type TeamMember, type TeamState } from '@/lib/api';
import { quickFix } from '@/lib/location';
import { formatDistance, istTime } from '@/lib/duty';
import { captureMedia } from '@/lib/media';
import { guardId, useAuth } from '@/store/auth';
import { goBack } from '@/lib/navigation';
import { colors, font, radius, space, touch } from '@/theme';

const STATE_TONE: Record<TeamState, { color: string; icon: keyof typeof Ionicons.glyphMap }> = {
  'On duty': { color: colors.onDuty, icon: 'shield-checkmark' },
  Late: { color: colors.warning, icon: 'alert-circle' },
  Absent: { color: colors.danger, icon: 'close-circle' },
  'Not checked in': { color: colors.warning, icon: 'time' },
  'Checked out': { color: colors.textMuted, icon: 'checkmark-done' },
  Scheduled: { color: colors.textMuted, icon: 'ellipse-outline' },
};

const APPROVE_REASONS = ['confirmed_present', 'gps_drift', 'site_boundary_wrong', 'device_fault', 'tag_damaged'] as const;
const REJECT_REASONS = ['not_at_post', 'proven_proxy', 'other'] as const;

type Tab = 'team' | 'review';

/**
 * The supervisor's "My team" tab (PRD 18.16, SUR-GAP-034).
 *
 * A field supervisor carries the same app as their guards, with this one extra surface. It
 * answers two questions: who is where, and what needs my approval — and lets them resolve either
 * without leaving the screen.
 *
 * A plain guard never sees this: the server decides, and returns `isSupervisor: false`.
 */
export default function Team() {
  const t = useT();
  const router = useRouter();
  const guard = useAuth((s) => s.guard);

  const [data, setData] = useState<SupervisorTeam | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('team');
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<ReviewItem | null>(null);
  const [proxyFor, setProxyFor] = useState<TeamMember | null>(null);

  const load = useCallback(async () => {
    const id = guardId(guard);
    if (!id) return;
    try {
      setData(await api.supervisorTeam(id));
    } catch {
      /* offline — keep whatever we last showed */
    } finally {
      setLoading(false);
    }
  }, [guard]);

  useEffect(() => {
    load();
  }, [load]);

  const decide = async (item: ReviewItem, decision: 'approved' | 'rejected', reason: string) => {
    const id = guardId(guard);
    if (!id) return;
    setBusyItem(item.itemId);
    try {
      await api.supervisorVerify({
        supervisorId: id,
        itemId: item.itemId,
        kind: item.kind,
        decision,
        reason,
      });
      successFeedback();
      setReviewing(null);
      await load();
    } catch {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    } finally {
      setBusyItem(null);
    }
  };

  if (loading) {
    return (
      <Screen>
        <Header onBack={() => goBack()} title={t('team.title')} />
        <Card style={styles.center}>
          <ActivityIndicator color={colors.primary} />
          <Muted>{t('common.loading')}</Muted>
        </Card>
      </Screen>
    );
  }

  if (!data?.isSupervisor) {
    return (
      <Screen>
        <Header onBack={() => goBack()} title={t('team.title')} />
        <Card style={styles.center}>
          <Ionicons name="people-outline" size={36} color={colors.textFaint} />
          <Muted style={{ textAlign: 'center' }}>{t('team.notSupervisor')}</Muted>
        </Card>
      </Screen>
    );
  }

  if (proxyFor) {
    return <ProxySheet member={proxyFor} onDone={() => { setProxyFor(null); load(); }} onCancel={() => setProxyFor(null)} />;
  }

  if (reviewing) {
    return (
      <Screen>
        <Header onBack={() => setReviewing(null)} title={t('team.reviewTitle')} />
        <ReviewDetail
          item={reviewing}
          team={data.team}
          busy={busyItem === reviewing.itemId}
          onDecide={(decision, reason) => decide(reviewing, decision, reason)}
        />
      </Screen>
    );
  }

  const c = data.counts;

  return (
    <Screen>
      <Header onBack={() => goBack()} title={t('team.title')} />

      {/* The numbers a supervisor scans first */}
      <View style={styles.stats}>
        <Stat label={t('team.onDuty')} value={c?.onDuty ?? 0} color={colors.onDuty} />
        <Stat label={t('team.notIn')} value={c?.notCheckedIn ?? 0} color={colors.warning} />
        <Stat label={t('team.absent')} value={c?.absent ?? 0} color={colors.danger} />
        <Stat label={t('team.toReview')} value={c?.pendingReview ?? 0} color={colors.primary} />
      </View>

      <View style={styles.tabs}>
        <TabButton active={tab === 'team'} label={`${t('team.tabTeam')} (${data.team.length})`} onPress={() => setTab('team')} />
        <TabButton
          active={tab === 'review'}
          label={`${t('team.tabReview')} (${data.reviewQueue.length})`}
          onPress={() => setTab('review')}
        />
      </View>

      {tab === 'team' ? (
        data.team.length === 0 ? (
          <Card style={styles.center}>
            <Ionicons name="people-outline" size={32} color={colors.textFaint} />
            <Muted style={{ textAlign: 'center' }}>{t('team.empty')}</Muted>
          </Card>
        ) : (
          data.team.map((m) => {
            const tone = STATE_TONE[m.state];
            return (
              <Card key={`${m.rosterId}:${m.guardId}`} style={styles.memberCard}>
                <View style={styles.rowBetween}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name}>{m.name}</Text>
                    <Muted>
                      {m.siteName} · {m.start}–{m.end}
                    </Muted>
                  </View>
                  <View style={styles.stateChip}>
                    <Ionicons name={tone.icon} size={18} color={tone.color} />
                    <Text style={[styles.stateText, { color: tone.color }]}>{m.state}</Text>
                  </View>
                </View>

                {m.checkedInAt ? (
                  <Muted>
                    {t('duty.checkedInAt')} {istTime(m.checkedInAt)}
                    {m.lateByMin > 0 ? ` · +${m.lateByMin}m` : ''}
                  </Muted>
                ) : null}
                {m.proxyBy ? <Muted style={{ color: colors.warning }}>{t('team.markedByProxy')}</Muted> : null}
                {m.isReliever ? <Muted style={{ color: colors.info }}>{t('duty.reliever')}</Muted> : null}

                <View style={styles.memberActions}>
                  {m.phone ? (
                    <Pressable onPress={() => Linking.openURL(`tel:${m.phone}`)} style={styles.action}>
                      <Ionicons name="call" size={18} color={colors.onDuty} />
                      <Text style={styles.actionText}>{t('team.call')}</Text>
                    </Pressable>
                  ) : null}
                  {data.canProxy && !m.checkedInAt && m.state !== 'Scheduled' ? (
                    <Pressable onPress={() => setProxyFor(m)} style={styles.action}>
                      <Ionicons name="person-add" size={18} color={colors.primary} />
                      <Text style={[styles.actionText, { color: colors.primary }]}>{t('team.markPresent')}</Text>
                    </Pressable>
                  ) : null}
                </View>
              </Card>
            );
          })
        )
      ) : data.reviewQueue.length === 0 ? (
        <Card style={styles.center}>
          <Ionicons name="checkmark-done-circle" size={32} color={colors.onDuty} />
          <Muted style={{ textAlign: 'center' }}>{t('team.nothingToReview')}</Muted>
        </Card>
      ) : (
        data.reviewQueue.map((item) => {
          const who = data.team.find((m) => m.guardId === item.guardId);
          return (
            <Pressable key={item.itemId} onPress={() => setReviewing(item)}>
              <Card style={{ ...styles.memberCard, borderColor: colors.warning }}>
                <View style={styles.rowBetween}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name}>{who?.name ?? item.guardId.slice(-6)}</Text>
                    <Muted>
                      {t(`team.kind.${item.kind}`)} · {item.siteName} · {istTime(item.at)}
                    </Muted>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color={colors.textFaint} />
                </View>
                <View style={styles.flags}>
                  {item.flags.slice(0, 3).map((f) => (
                    <View key={f} style={styles.flag}>
                      <Text style={styles.flagText}>{t(`team.flag.${f}`)}</Text>
                    </View>
                  ))}
                </View>
              </Card>
            </Pressable>
          );
        })
      )}
    </Screen>
  );
}

/** Two taps to a decision: pick a reason, approve or reject (PRD 18.6 §16). */
function ReviewDetail({
  item,
  team,
  busy,
  onDecide,
}: {
  item: ReviewItem;
  team: TeamMember[];
  busy: boolean;
  onDecide: (decision: 'approved' | 'rejected', reason: string) => void;
}) {
  const t = useT();
  const [reason, setReason] = useState<string>('');
  const [mode, setMode] = useState<'approve' | 'reject'>('approve');
  const who = team.find((m) => m.guardId === item.guardId);
  const reasons = mode === 'approve' ? APPROVE_REASONS : REJECT_REASONS;

  return (
    <>
      <Card>
        <Text style={styles.name}>{who?.name ?? item.guardId.slice(-6)}</Text>
        <Muted>
          {t(`team.kind.${item.kind}`)} · {item.siteName}
        </Muted>
        <Row label={t('team.when')} value={istTime(item.at)} />
        {item.distanceM !== null ? <Row label={t('team.distance')} value={formatDistance(item.distanceM)} /> : null}
        {item.geofenceResult ? <Row label={t('checkin.location')} value={item.geofenceResult} /> : null}
        {item.outsideReason ? <Row label={t('team.guardSaid')} value={item.outsideReason} /> : null}
        {item.checkpointCode ? <Row label={t('patrol.enterCode')} value={item.checkpointCode} /> : null}
        {item.trustScore !== null ? <Row label={t('team.trust')} value={`${item.trustScore}/100`} /> : null}
      </Card>

      <View style={{ gap: space.sm }}>
        <Muted>{t('team.whyFlagged')}</Muted>
        <View style={styles.flags}>
          {item.flags.map((f) => (
            <View key={f} style={styles.flag}>
              <Text style={styles.flagText}>{t(`team.flag.${f}`)}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.tabs}>
        <TabButton active={mode === 'approve'} label={t('team.approve')} onPress={() => { setMode('approve'); setReason(''); }} />
        <TabButton active={mode === 'reject'} label={t('team.reject')} onPress={() => { setMode('reject'); setReason(''); }} />
      </View>

      <View style={{ gap: space.sm }}>
        <Muted>{t('team.pickReason')}</Muted>
        <View style={styles.flags}>
          {reasons.map((r) => (
            <Pressable
              key={r}
              onPress={() => setReason(r)}
              style={[styles.reason, reason === r && { borderColor: colors.primary, backgroundColor: 'rgba(245,198,35,0.12)' }]}
            >
              <Text style={[styles.reasonText, reason === r && { color: colors.text }]}>{t(`team.reason.${r}`)}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <Button
        label={mode === 'approve' ? t('team.approve') : t('team.reject')}
        variant={mode === 'approve' ? 'success' : 'danger'}
        size="huge"
        loading={busy}
        // Approving without a reason is allowed; rejecting takes pay away, so it is not.
        disabled={busy || (mode === 'reject' && !reason)}
        onPress={() => onDecide(mode === 'approve' ? 'approved' : 'rejected', reason)}
      />
      <Muted style={{ textAlign: 'center' }}>{t('team.decisionNote')}</Muted>
    </>
  );
}

/**
 * Proxy attendance. The supervisor's own selfie and location are what get recorded — the whole
 * point is that someone accountable stood there and saw the guard (PRD 18.5 §9).
 */
function ProxySheet({
  member,
  onDone,
  onCancel,
}: {
  member: TeamMember;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const guard = useAuth((s) => s.guard);
  const [perm, requestPerm] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const [selfie, setSelfie] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!perm?.granted) requestPerm();
  }, [perm?.granted]);

  const capture = async () => {
    try {
      const shot = await cam.current?.takePictureAsync({ quality: 0.5, skipProcessing: true });
      if (!shot?.uri) return;
      const c = await ImageManipulator.manipulateAsync(shot.uri, [{ resize: { width: 640 } }], {
        compress: 0.5,
        format: ImageManipulator.SaveFormat.JPEG,
      });
      setSelfie(c.uri);
    } catch {
      setError(t('checkin.cameraError'));
    }
  };

  const submit = async () => {
    const id = guardId(guard);
    if (!reason) return setError(t('team.pickReason'));
    setBusy(true);
    setError('');
    try {
      const pos = await quickFix();
      const res = await api.supervisorProxy({
        supervisorId: id,
        subjectGuardId: member.guardId,
        rosterId: member.rosterId,
        eventType: 'check_in',
        reason,
        deviceTime: new Date().toISOString(),
        lat: pos?.coords.latitude,
        lng: pos?.coords.longitude,
        accuracyM: pos?.coords.accuracy ?? undefined,
      });
      if (selfie) {
        captureMedia({
          guardId: id,
          uri: selfie,
          kind: 'selfie',
          clientEventUuid: res.clientEventUuid,
          rosterId: member.rosterId,
        }).catch(() => {});
      }
      onDone();
    } catch (e: any) {
      setError(e?.message ?? t('team.proxyFailed'));
    } finally {
      setBusy(false);
    }
  };

  const PROXY_REASONS = ['phone_dead', 'phone_broken', 'no_smartphone', 'app_not_working'] as const;

  return (
    <Screen>
      <Header onBack={onCancel} title={t('team.markPresent')} />

      <Card>
        <Text style={styles.name}>{member.name}</Text>
        <Muted>
          {member.siteName} · {member.start}–{member.end}
        </Muted>
      </Card>

      <View style={styles.warnBox}>
        <Ionicons name="information-circle" size={20} color={colors.warning} />
        <Body style={{ flex: 1, color: colors.warning }}>{t('team.proxyNote')}</Body>
      </View>

      <View style={{ gap: space.sm }}>
        <Muted>{t('team.proxyWhy')}</Muted>
        <View style={styles.flags}>
          {PROXY_REASONS.map((r) => (
            <Pressable
              key={r}
              onPress={() => setReason(r)}
              style={[styles.reason, reason === r && { borderColor: colors.primary, backgroundColor: 'rgba(245,198,35,0.12)' }]}
            >
              <Text style={[styles.reasonText, reason === r && { color: colors.text }]}>{t(`team.proxyReason.${r}`)}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <Card style={{ padding: 0, overflow: 'hidden' }}>
        {selfie ? (
          <View style={styles.center}>
            <Ionicons name="checkmark-circle" size={44} color={colors.onDuty} />
            <Muted>{t('team.yourPhotoTaken')}</Muted>
            <Button label={t('common.retry')} variant="ghost" size="small" onPress={() => setSelfie(null)} />
          </View>
        ) : perm?.granted ? (
          <View>
            <CameraView ref={cam} style={styles.camera} facing="front" />
            <View style={{ padding: space.md, gap: space.sm }}>
              <Muted style={{ textAlign: 'center' }}>{t('team.takeYourPhoto')}</Muted>
              <Button label={t('checkin.captureNow')} onPress={capture} />
            </View>
          </View>
        ) : (
          <View style={styles.center}>
            <Muted>{t('checkin.noCameraOk')}</Muted>
          </View>
        )}
      </Card>

      {error ? <Text style={styles.err}>{error}</Text> : null}

      <Button
        label={t('team.confirmProxy')}
        variant="primary"
        size="huge"
        loading={busy}
        disabled={busy || !reason}
        onPress={submit}
      />
    </Screen>
  );
}

function Header({ onBack, title }: { onBack: () => void; title: string }) {
  return (
    <View style={styles.head}>
      <Pressable onPress={onBack} hitSlop={12}>
        <Ionicons name="arrow-back" size={24} color={colors.text} />
      </Pressable>
      <H2>{title}</H2>
      <View style={{ width: 24 }} />
    </View>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function TabButton({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.tab, active && styles.tabActive]}>
      <Text style={[styles.tabText, active && { color: colors.onPrimary }]}>{label}</Text>
    </Pressable>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.rowBetween}>
      <Muted>{label}</Muted>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  center: { alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingVertical: space.xl },
  stats: { flexDirection: 'row', gap: space.sm },
  stat: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    paddingVertical: space.md,
    gap: 2,
  },
  statValue: { fontSize: font.h2, fontWeight: '900' },
  statLabel: { color: colors.textMuted, fontSize: font.tiny, fontWeight: '700', textAlign: 'center' },
  tabs: { flexDirection: 'row', gap: space.sm },
  tab: {
    flex: 1,
    minHeight: touch.minTap,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tabActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  tabText: { color: colors.text, fontSize: font.label, fontWeight: '800' },
  memberCard: { gap: space.xs },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowValue: { color: colors.text, fontSize: font.body, fontWeight: '800' },
  name: { color: colors.text, fontSize: font.h3, fontWeight: '800' },
  stateChip: { alignItems: 'center', gap: 2, width: 92 },
  stateText: { fontSize: font.tiny, fontWeight: '800', textAlign: 'center' },
  memberActions: { flexDirection: 'row', gap: space.lg, marginTop: space.xs },
  action: { flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: touch.minTap },
  actionText: { color: colors.onDuty, fontSize: font.label, fontWeight: '800' },
  flags: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  flag: {
    backgroundColor: colors.warningDim,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
  },
  flagText: { color: colors.warning, fontSize: font.tiny, fontWeight: '700' },
  reason: {
    minHeight: touch.minTap,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  reasonText: { color: colors.textMuted, fontSize: font.label, fontWeight: '700' },
  warnBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.warningDim,
    borderRadius: radius.md,
    padding: space.md,
  },
  camera: { width: '100%', height: 300 },
  err: { color: colors.danger, fontWeight: '700' },
});
