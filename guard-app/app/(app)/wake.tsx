import { goBack } from '@/lib/navigation';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import * as ImageManipulator from 'expo-image-manipulator';
import { useKeepAwake } from 'expo-keep-awake';
import * as Location from 'expo-location';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, Vibration, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Card, Muted, Screen } from '@/components/ui';
import { useT } from '@/i18n';
import type { WakeCheck } from '@/lib/api';
import { useBrightScreen } from '@/lib/brightness';
import { istTime } from '@/lib/duty';
import { successFeedback } from '@/lib/feedback';
import { captureMedia } from '@/lib/media';
import { quickFix } from '@/lib/location';
import { showOverLockScreen } from '@/lib/native';
import { disarmWakeCheck, scheduleWakeReprompt, silenceWakeAlarm } from '@/lib/notifications';
import { enqueue } from '@/lib/queue';
import { guardId, useAuth } from '@/store/auth';
import { useDuty } from '@/store/duty';
import { colors, font, space } from '@/theme';
import { API_BASE_URL } from '@/config';
import { isAuditCompleted, markAuditCompleted } from '@/lib/auditTracker';

type VerticalPos = 'flex-start' | 'center' | 'flex-end';
const POSITIONS: VerticalPos[] = ['flex-start', 'center', 'flex-end'];

/** Continuous buzz while the prompt is up — a sleeping guard is not reading the screen. */
const VIBRATE_PATTERN = [0, 600, 400];

type Mode = 'schedule' | 'prompt' | 'selfie' | 'confirmed' | 'missed';

/**
 * Night anti-sleep wake check (PRD 18.8, SUR-GAP-015/016).
 */
export default function Wake() {
  const t = useT();
  const router = useRouter();
  const params = useLocalSearchParams<{
    prompt?: string;
    wakeId?: string;
    ackWindowSec?: string;
    selfie?: string;
    attempt?: string;
  }>();
  const attempt = Math.max(1, parseInt(params.attempt ?? '1', 10) || 1);

  const guard = useAuth((s) => s.guard);
  const current = useDuty((s) => s.current);
  const refresh = useDuty((s) => s.refresh);

  const rawWindow = parseInt(params.ackWindowSec ?? '', 10);
  const ackWindow = rawWindow > 0 && rawWindow <= 60 ? rawWindow : 60;
  const selfieRequired = params.selfie === '1';

  // Open DIRECTLY into selfie mode if selfie is required
  const [mode, setMode] = useState<Mode>(
    params.prompt ? (selfieRequired ? 'selfie' : 'prompt') : 'schedule'
  );
  const [remaining, setRemaining] = useState(ackWindow);
  const [btnPos, setBtnPos] = useState<VerticalPos>('center');
  const [capturing, setCapturing] = useState(false);

  const [perm, requestPerm] = useCameraPermissions();
  const cam = useRef<CameraView>(null);

  const shownAt = useRef(Date.now());
  const resolved = useRef(false);

  useKeepAwake();
  useBrightScreen();

  const startPrompt = useCallback(() => {
    resolved.current = false;
    shownAt.current = Date.now();
    setRemaining(ackWindow);
    setBtnPos(POSITIONS[Math.floor(Math.random() * POSITIONS.length)]);
    setMode(selfieRequired ? 'selfie' : 'prompt');
    Vibration.vibrate(VIBRATE_PATTERN, true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
  }, [ackWindow, selfieRequired]);

  useEffect(() => {
    if (params.prompt) {
      showOverLockScreen(true);
      startPrompt();
    }
    return () => {
      Vibration.cancel();
      showOverLockScreen(false);
    };
  }, [params.prompt, startPrompt]);

  // Request camera permission on mount if selfie mode
  useEffect(() => {
    if (selfieRequired && !perm?.granted) {
      requestPerm().catch(() => {});
    }
  }, [selfieRequired, perm?.granted, requestPerm]);

  const record = useCallback(
    async (missed: boolean, selfieUri?: string) => {
      if (resolved.current) return;
      resolved.current = true;
      Vibration.cancel();
      setMode(missed ? 'missed' : 'confirmed');
      if (!missed) successFeedback();

      const id = guardId(guard);
      const respondedMs = Date.now() - shownAt.current;

      try {
        const pos = missed ? null : await quickFix({ accuracy: Location.Accuracy.Balanced, timeoutMs: 4_000 });
        const lat = pos?.coords.latitude;
        const lng = pos?.coords.longitude;

        // Directly post to /api/guard/wake-check for immediate server update
        fetch(`${API_BASE_URL}/api/guard/wake-check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            guardId: id,
            wakeId: params.wakeId,
            rosterId: current?.rosterId,
            bookingId: (current as any)?.bookingId,
            missed,
            attempt,
            respondedMs: missed ? undefined : respondedMs,
            lat,
            lng,
            selfieUrl: selfieUri,
          }),
        }).catch(() => {});

        const event = await enqueue(id, 'wake_check', {
          wakeId: params.wakeId,
          rosterId: current?.rosterId,
          siteId: current?.siteId,
          missed,
          attempt,
          respondedMs: missed ? undefined : respondedMs,
          lat,
          lng,
        });

        if (missed && attempt === 1 && params.wakeId) {
          scheduleWakeReprompt({
            wakeId: params.wakeId,
            attempt: 2,
            afterSeconds: 60,
            ackWindowSec: ackWindow,
            selfieRequired,
          }).catch(() => {});
        }

        if (selfieUri) {
          captureMedia({
            guardId: id,
            uri: selfieUri,
            kind: 'wake_selfie',
            clientEventUuid: event.client_event_uuid,
            rosterId: current?.rosterId,
          }).catch(() => {});
        }
      } catch {
        /* queued; will sync */
      }

      if (params.wakeId) {
        silenceWakeAlarm(params.wakeId, attempt);
        disarmWakeCheck(params.wakeId, { keepReprompt: missed && attempt === 1 }).catch(() => {});
      }
      refresh().catch(() => {});
      setTimeout(() => router.replace('/home'), missed ? 1800 : 1400);
    },
    [guard, params.wakeId, current, refresh, router, attempt, ackWindow, selfieRequired]
  );

  // Countdown timer: ticks in both prompt and selfie mode
  useEffect(() => {
    if (mode !== 'prompt' && mode !== 'selfie') return;
    if (remaining <= 0) {
      record(true);
      return;
    }
    const timer = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(timer);
  }, [mode, remaining, record]);

  // Click Selfie Handler: takes front picture and acquires GPS
  const onCaptureSelfie = async () => {
    if (capturing || resolved.current) return;
    setCapturing(true);
    Vibration.cancel();

    try {
      if (!perm?.granted) {
        const res = await requestPerm();
        if (!res.granted) {
          return record(false);
        }
      }

      let selfieUri: string | undefined = undefined;
      try {
        const shot = await cam.current?.takePictureAsync({
          quality: 0.5,
          skipProcessing: true,
          base64: true,
        });
        const sourceUri = shot?.uri;
        if (sourceUri) {
          const c = await ImageManipulator.manipulateAsync(
            sourceUri,
            [{ resize: { width: 480 } }],
            {
              compress: 0.45,
              format: ImageManipulator.SaveFormat.JPEG,
              base64: true,
            }
          );
          if (c.base64) {
            selfieUri = `data:image/jpeg;base64,${c.base64}`;
          } else if (Platform.OS === 'web' && (c.uri?.startsWith('blob:') || sourceUri.startsWith('blob:'))) {
            try {
              const blobRes = await fetch(c.uri || sourceUri);
              const blobData = await blobRes.blob();
              selfieUri = await new Promise<string>((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result as string);
                reader.onerror = () => resolve('');
                reader.readAsDataURL(blobData);
              });
            } catch {
              selfieUri = c.uri || sourceUri;
            }
          } else {
            selfieUri = c.uri || sourceUri;
          }
        }
      } catch (camErr) {
        console.warn('Camera snap error, continuing with GPS location:', camErr);
      }

      await record(false, selfieUri);
    } catch {
      await record(false);
    } finally {
      setCapturing(false);
    }
  };

  const onAwake = async () => {
    Vibration.cancel();
    if (!selfieRequired) return record(false);

    if (!perm?.granted) {
      const res = await requestPerm();
      if (!res.granted) return record(false);
    }
    setMode('selfie');
  };

  if (mode === 'confirmed' || mode === 'missed') {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.center}>
          <View style={[styles.circle, { backgroundColor: mode === 'confirmed' ? colors.onDuty : colors.danger }]}>
            <Ionicons name={mode === 'confirmed' ? 'checkmark' : 'close'} size={72} color="#fff" />
          </View>
          <Text style={styles.title}>{mode === 'confirmed' ? t('wake.confirmed') : t('wake.missed')}</Text>
          <Muted style={{ textAlign: 'center' }}>
            {mode === 'confirmed' ? 'Attendance & Location verified successfully' : 'Check missed. Supervisor alerted.'}
          </Muted>
        </View>
      </SafeAreaView>
    );
  }

  // DIRECT SELFIE CAMERA SCREEN
  if (mode === 'selfie') {
    return (
      <SafeAreaView style={styles.screen}>
        {/* Top Header */}
        <View style={styles.selfieTopBar}>
          <View style={styles.rowGap}>
            <Ionicons name="shield-checkmark" size={24} color={colors.primary} />
            <Text style={styles.selfieTopTitle}>Night Alertness Audit</Text>
          </View>
          <View style={[styles.timerBadge, remaining < 30 && styles.timerBadgeUrgent]}>
            <Ionicons name="time-outline" size={16} color={remaining < 30 ? colors.danger : colors.primary} />
            <Text style={[styles.timerText, remaining < 30 && { color: colors.danger }]}>{remaining}s</Text>
          </View>
        </View>

        {/* Camera Center */}
        <View style={styles.selfieContent}>
          <View style={styles.selfieWrap}>
            <CameraView ref={cam} style={styles.selfieCam} facing="front" />
            <View style={styles.faceGuideRing} />
          </View>

          <View style={styles.instructionBox}>
            <Text style={styles.instructionTitle}>Position face clearly in camera</Text>
            <Text style={styles.instructionSub}>GPS Location will be automatically detected on capture</Text>
          </View>

          {/* Large Shutter Button */}
          <Pressable
            onPress={onCaptureSelfie}
            disabled={capturing}
            style={[styles.captureActionBtn, capturing && { opacity: 0.7 }]}
          >
            {capturing ? (
              <ActivityIndicator color={colors.onPrimary} size="small" />
            ) : (
              <>
                <Ionicons name="camera" size={26} color={colors.onPrimary} />
                <Text style={styles.captureActionBtnText}>CLICK SELFIE &amp; VERIFY</Text>
              </>
            )}
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (mode === 'prompt') {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.promptWrap}>
          <Ionicons name="moon" size={44} color={colors.warning} />
          <Text style={styles.title}>{t('wake.title')}</Text>
          <Text style={[styles.countdown, remaining < 30 && { color: colors.danger }]}>{remaining}</Text>
          <Muted style={{ textAlign: 'center' }}>{t('wake.secondsLeft')}</Muted>
          <Muted style={{ textAlign: 'center' }}>{t('wake.respondNow')}</Muted>
          <View style={[styles.btnZone, { justifyContent: btnPos }]}>
            <Pressable onPress={onAwake} style={styles.bigBtn}>
              <Ionicons name="hand-left" size={52} color={colors.onPrimary} />
              <Text style={styles.bigBtnText}>{t('wake.confirm')}</Text>
            </Pressable>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // --- Idle: show tonight's schedule ---
  const checks: WakeCheck[] = current?.wakeChecks ?? [];
  const pending = checks.filter((c) => c.status === 'pending');

  return (
    <Screen>
      <View style={styles.head}>
        <Pressable onPress={() => goBack()} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={styles.headTitle}>{t('wake.title')}</Text>
        <View style={{ width: 24 }} />
      </View>

      {checks.length === 0 ? (
        <Card style={styles.emptyCard}>
          <Ionicons name="moon" size={36} color={colors.textFaint} />
          <Muted style={{ textAlign: 'center' }}>{t('wake.noneScheduled')}</Muted>
        </Card>
      ) : (
        <>
          <Card style={{ borderColor: colors.onDuty, backgroundColor: colors.onDutyDim }}>
            <View style={styles.rowGap}>
              <Ionicons name="alarm" size={22} color={colors.onDuty} />
              <Text style={[styles.cardText, { color: colors.onDuty }]}>
                {pending.length} {t('wake.armedTonight')}
              </Text>
            </View>
            <Muted>{t('wake.armedNote')}</Muted>
          </Card>

          {checks.map((c) => {
            const tone =
              c.status === 'acknowledged' || c.status === 'acknowledged_late' || c.status === 'suppressed'
                ? colors.onDuty
                : c.status === 'missed'
                  ? colors.danger
                  : colors.textMuted;
            const icon =
              c.status === 'missed'
                ? 'close-circle'
                : c.status === 'pending'
                  ? 'ellipse-outline'
                  : 'checkmark-circle';
            return (
              <Card key={c.wakeId}>
                <View style={styles.rowBetween}>
                  <View style={styles.rowGap}>
                    <Ionicons name={icon as any} size={20} color={tone} />
                    <Text style={styles.cardText}>{istTime(c.dueAt)}</Text>
                  </View>
                  <Text style={[styles.status, { color: tone }]}>{t(`wake.status.${c.status}`)}</Text>
                </View>
              </Card>
            );
          })}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0B0D0F' },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headTitle: { color: colors.text, fontSize: font.h2, fontWeight: '800' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.lg, padding: space.xl },
  promptWrap: { flex: 1, alignItems: 'center', paddingHorizontal: space.xl, paddingTop: space.xxl, gap: space.sm },
  circle: { width: 150, height: 150, borderRadius: 75, alignItems: 'center', justifyContent: 'center' },
  title: { color: '#fff', fontSize: font.h1, fontWeight: '900', textAlign: 'center' },
  countdown: { color: '#fff', fontSize: 88, fontWeight: '900', letterSpacing: 2 },
  btnZone: { flex: 1, alignSelf: 'stretch', alignItems: 'center' },
  bigBtn: {
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    shadowColor: colors.primary,
    shadowOpacity: 0.8,
    shadowRadius: 30,
    elevation: 12,
  },
  bigBtnText: { color: colors.onPrimary, fontSize: font.h3, fontWeight: '900', textTransform: 'uppercase', letterSpacing: 0.5 },
  selfieWrap: { width: 280, height: 360, borderRadius: 28, overflow: 'hidden', borderWidth: 3, borderColor: colors.primary, position: 'relative' },
  selfieCam: { flex: 1 },
  faceGuideRing: { position: 'absolute', inset: 20, borderRadius: 100, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.3)', borderStyle: 'dashed' },
  selfieTopBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.md },
  selfieTopTitle: { color: '#fff', fontSize: font.h3, fontWeight: '800' },
  timerBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(245, 198, 35, 0.15)', borderWidth: 1, borderColor: colors.primary, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
  timerBadgeUrgent: { backgroundColor: 'rgba(239, 68, 68, 0.2)', borderColor: colors.danger },
  timerText: { color: colors.primary, fontSize: font.body, fontWeight: '800' },
  selfieContent: { flex: 1, alignItems: 'center', justifyContent: 'space-around', paddingHorizontal: space.lg, paddingBottom: space.xl },
  instructionBox: { alignItems: 'center', gap: 4 },
  instructionTitle: { color: '#fff', fontSize: font.body, fontWeight: '700', textAlign: 'center' },
  instructionSub: { color: colors.textMuted, fontSize: font.label, textAlign: 'center' },
  captureActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    backgroundColor: colors.primary,
    paddingVertical: space.md,
    paddingHorizontal: space.xl,
    borderRadius: 30,
    width: '90%',
    shadowColor: colors.primary,
    shadowOpacity: 0.5,
    shadowRadius: 15,
    elevation: 8,
  },
  captureActionBtnText: { color: colors.onPrimary, fontSize: font.body, fontWeight: '900', letterSpacing: 0.5 },
  emptyCard: { alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingVertical: space.xl },
  rowGap: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardText: { color: colors.text, fontSize: font.body, fontWeight: '800' },
  status: { fontSize: font.tiny, fontWeight: '800', textTransform: 'uppercase' },
});
