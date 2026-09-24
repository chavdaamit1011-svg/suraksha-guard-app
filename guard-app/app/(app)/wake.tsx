import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import * as ImageManipulator from 'expo-image-manipulator';
import { useKeepAwake } from 'expo-keep-awake';
import * as Location from 'expo-location';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, Vibration, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Card, Muted, Screen } from '@/components/ui';
import { goBack } from '@/lib/navigation';
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

type VerticalPos = 'flex-start' | 'center' | 'flex-end';
const POSITIONS: VerticalPos[] = ['flex-start', 'center', 'flex-end'];

/** Continuous buzz while the prompt is up — a sleeping guard is not reading the screen. */
const VIBRATE_PATTERN = [0, 600, 400];

type Mode = 'schedule' | 'prompt' | 'selfie' | 'confirmed' | 'missed';

/**
 * Night anti-sleep wake check (PRD 18.8, SUR-GAP-015/016).
 *
 * The schedule is the server's: randomised times generated per shift and pushed in the duty
 * bundle, armed as local alarms so they fire with no network. This screen is the other half —
 * the full-screen prompt itself, with a countdown, a randomly repositioned button so it cannot
 * be dismissed from muscle memory, and an optional selfie for high-value sites.
 *
 * A miss is recorded, never lost: if the window closes the app writes the miss to the outbox,
 * and the server independently sweeps for prompts that were never answered at all.
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
  /** 1 for the scheduled prompt, 2 for the re-prompt a minute after a miss (PRD 18.8 §9). */
  const attempt = Math.max(1, parseInt(params.attempt ?? '1', 10) || 1);

  const guard = useAuth((s) => s.guard);
  const current = useDuty((s) => s.current);
  const refresh = useDuty((s) => s.refresh);

  const ackWindow = Math.max(30, parseInt(params.ackWindowSec ?? '', 10) || 120);
  const selfieRequired = params.selfie === '1';

  const [mode, setMode] = useState<Mode>(params.prompt ? 'prompt' : 'schedule');
  const [remaining, setRemaining] = useState(ackWindow);
  const [btnPos, setBtnPos] = useState<VerticalPos>('center');

  const [perm, requestPerm] = useCameraPermissions();
  const cam = useRef<CameraView>(null);

  const shownAt = useRef(Date.now());
  const resolved = useRef(false);

  // The screen must not sleep while a wake prompt is up, and must be readable in a dark cabin.
  useKeepAwake();
  useBrightScreen();

  const startPrompt = useCallback(() => {
    resolved.current = false;
    shownAt.current = Date.now();
    setRemaining(ackWindow);
    setBtnPos(POSITIONS[Math.floor(Math.random() * POSITIONS.length)]);
    setMode('prompt');
    Vibration.vibrate(VIBRATE_PATTERN, true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
  }, [ackWindow]);

  useEffect(() => {
    if (params.prompt) {
      // Opened by the alarm over a locked phone: stay visible and switch the screen on.
      showOverLockScreen(true);
      startPrompt();
    }
    return () => {
      Vibration.cancel();
      showOverLockScreen(false);
    };
  }, [params.prompt, startPrompt]);

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
        // Where the guard was when they answered — the acknowledgement is evidence of presence,
        // not just of wakefulness (PRD 18.8 §9 "response capture"). Bounded, and skipped for a miss.
        const pos = missed ? null : await quickFix({ accuracy: Location.Accuracy.Balanced, timeoutMs: 4_000 });
        const event = await enqueue(id, 'wake_check', {
          wakeId: params.wakeId,
          rosterId: current?.rosterId,
          siteId: current?.siteId,
          missed,
          attempt,
          respondedMs: missed ? undefined : respondedMs,
          lat: pos?.coords.latitude,
          lng: pos?.coords.longitude,
        });

        // First miss: give the guard one more chance a minute later before anyone is called
        // (PRD 18.8 §9 — the 60 s re-prompt absorbs a guard who was simply on a round or in the
        // toilet). A second miss is what the server escalates.
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
        /* queued; it will sync */
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

  // Countdown. At zero the miss is recorded locally — nothing is lost to a sleeping guard.
  useEffect(() => {
    if (mode !== 'prompt') return;
    if (remaining <= 0) {
      record(true);
      return;
    }
    const timer = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(timer);
  }, [mode, remaining, record]);

  const onAwake = async () => {
    Vibration.cancel();
    if (!selfieRequired) return record(false);

    // High-value sites want proof of a face, not just a tap.
    if (!perm?.granted) {
      const res = await requestPerm();
      if (!res.granted) return record(false); // never block the acknowledgement on a permission
    }
    setMode('selfie');
    setTimeout(async () => {
      try {
        const shot = await cam.current?.takePictureAsync({ quality: 0.5, skipProcessing: true });
        if (shot?.uri) {
          const c = await ImageManipulator.manipulateAsync(shot.uri, [{ resize: { width: 640 } }], {
            compress: 0.5,
            format: ImageManipulator.SaveFormat.JPEG,
          });
          return record(false, c.uri);
        }
      } catch {
        /* fall through — the acknowledgement still counts */
      }
      record(false);
    }, 1200);
  };

  if (mode === 'confirmed' || mode === 'missed') {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.center}>
          <View style={[styles.circle, { backgroundColor: mode === 'confirmed' ? colors.onDuty : colors.danger }]}>
            <Ionicons name={mode === 'confirmed' ? 'checkmark' : 'close'} size={72} color="#fff" />
          </View>
          <Text style={styles.title}>{mode === 'confirmed' ? t('wake.confirmed') : t('wake.missed')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (mode === 'selfie') {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.center}>
          <Text style={styles.title}>{t('wake.selfiePrompt')}</Text>
          <View style={styles.selfieWrap}>
            <CameraView ref={cam} style={styles.selfieCam} facing="front" />
          </View>
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

  // --- Idle: show tonight's schedule. The guard does not arm this; the roster does. ---
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

      {!current?.wakeCheckEnabled ? (
        <Card style={styles.emptyCard}>
          <Ionicons name="sunny" size={36} color={colors.textFaint} />
          <Muted style={{ textAlign: 'center' }}>{t('wake.notEnabled')}</Muted>
        </Card>
      ) : checks.length === 0 ? (
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
  selfieWrap: { width: 260, height: 340, borderRadius: 24, overflow: 'hidden', borderWidth: 3, borderColor: colors.primary },
  selfieCam: { flex: 1 },
  emptyCard: { alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingVertical: space.xl },
  rowGap: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardText: { color: colors.text, fontSize: font.body, fontWeight: '800' },
  status: { fontSize: font.tiny, fontWeight: '800', textTransform: 'uppercase' },
});
