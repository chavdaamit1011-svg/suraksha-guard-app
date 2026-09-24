import { goBack } from '@/lib/navigation';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useKeepAwake } from 'expo-keep-awake';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, Vibration, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Muted } from '@/components/ui';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { fireSos, stopSiren, watchAcknowledgement, type SosRung, type SosState } from '@/lib/sos';
import { guardId, useAuth } from '@/store/auth';
import { useDuty } from '@/store/duty';
import { colors, font, radius, space } from '@/theme';

const VIBRATE_PATTERN = [0, 400, 200, 400, 200];

/** The rungs, in the order PRD 18.9 §9 lists them. */
const LADDER: { key: SosRung; label: string }[] = [
  { key: 'capture', label: 'sos.stepQueue' },
  { key: 'siren', label: 'sos.stepSiren' },
  { key: 'socket', label: 'sos.stepSocket' },
  { key: 'rest', label: 'sos.stepRest' },
  { key: 'sms', label: 'sos.stepSms' },
  { key: 'supervisorSms', label: 'sos.stepSupervisorSms' },
  { key: 'call', label: 'sos.stepCall' },
];

/**
 * SOS (PRD 18.9, SUR-GAP-017/018).
 *
 * Once fired the screen becomes a full red "help is coming" state: the ladder's progress, an
 * elapsed timer, the responder's name once an operator acknowledges, and a Cancel that requires
 * the guard's PIN — so an attacker holding a snatched phone cannot call the alarm off.
 *
 * The siren and the torch run for as long as this screen is up. They are the only two rungs that
 * work with no radio at all, so they are also the only two that are unconditional.
 */
export default function Sos() {
  const t = useT();
  const router = useRouter();
  const { fired } = useLocalSearchParams<{ fired?: string }>();

  const guard = useAuth((s) => s.guard);
  const verifyPin = useAuth((s) => s.verifyPin);
  const { current, booking } = useDuty();

  const [phase, setPhase] = useState<'confirm' | 'active'>(fired ? 'active' : 'confirm');
  const [state, setState] = useState<SosState | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [torchOn, setTorchOn] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [pin, setPin] = useState('');
  const [pinErr, setPinErr] = useState('');

  const [camPerm, requestCamPerm] = useCameraPermissions();
  const started = useRef(false);
  const stopAckWatch = useRef<(() => void) | null>(null);

  useKeepAwake();

  const sirenEnabled = current?.site.sirenEnabled ?? true;

  const fire = useCallback(async () => {
    if (started.current) return;
    started.current = true;

    Vibration.vibrate(VIBRATE_PATTERN, true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});

    // The torch flashes alongside the siren: deterrence, and something to find the guard by.
    if (!camPerm?.granted) await requestCamPerm();
    setTorchOn(true);

    const s = await fireSos({
      guardId: guardId(guard),
      guardName: guard?.name ?? 'Guard',
      rosterId: current?.rosterId,
      bookingId: booking?.bookingId,
      siteId: current?.siteId,
      siteName: current?.siteName,
      escalationContacts: current?.site.escalationContacts ?? [],
      sosSmsNumber: undefined,
      sirenEnabled,
      triggerMethod: 'long_press',
      onUpdate: setState,
    });
    setState(s);

    stopAckWatch.current = watchAcknowledgement(guardId(guard), s.sosId, (responder) =>
      setState((prev) => (prev ? { ...prev, serverAcked: true, responder } : prev))
    );
  }, [guard, current, booking, camPerm?.granted, requestCamPerm, sirenEnabled]);

  useEffect(() => {
    if (phase === 'active') fire();
  }, [phase, fire]);

  // Everything the alarm turned on gets turned off exactly once, when the screen goes away.
  useEffect(
    () => () => {
      stopSiren();
      Vibration.cancel();
      stopAckWatch.current?.();
    },
    []
  );

  useEffect(() => {
    if (phase !== 'active') return;
    const iv = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(iv);
  }, [phase]);

  const doCancel = async () => {
    if (!(await verifyPin(pin))) {
      setPinErr(t('pin.wrong'));
      return;
    }
    stopSiren();
    Vibration.cancel();
    setTorchOn(false);
    if (state?.sosId) api.sosCancel(guardId(guard), state.sosId, 'cancelled_by_guard').catch(() => {});
    router.replace('/home');
  };

  const mmss = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;

  if (phase === 'confirm') {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.center}>
          <View style={styles.pulse}>
            <Ionicons name="warning" size={64} color="#fff" />
          </View>
          <Text style={styles.title}>{t('sos.title')}</Text>
          <Muted style={{ textAlign: 'center', color: '#fff' }}>{t('sos.confirmBody')}</Muted>
        </View>
        <View style={styles.foot}>
          <Button label={t('sos.sendNow')} variant="danger" size="huge" onPress={() => setPhase('active')} />
          <Button label={t('common.cancel')} variant="ghost" onPress={() => goBack()} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      {/* A 1x1 camera is the only way to hold the torch on; it is never shown. */}
      {torchOn && camPerm?.granted ? (
        <CameraView style={styles.hiddenCam} facing="back" enableTorch />
      ) : null}

      <View style={styles.center}>
        <View style={[styles.pulse, state?.serverAcked && { backgroundColor: colors.onDuty }]}>
          <Ionicons name={state?.serverAcked ? 'checkmark' : 'warning'} size={64} color="#fff" />
        </View>

        <Text style={styles.title}>{state?.serverAcked ? t('sos.received') : t('sos.helpComing')}</Text>
        <Text style={styles.timer}>{mmss}</Text>

        {state?.responder ? (
          <View style={styles.responder}>
            <Ionicons name="person-circle" size={22} color={colors.onDuty} />
            <Text style={styles.responderText}>
              {t('sos.responder')}: {state.responder}
            </Text>
          </View>
        ) : null}

        {state?.trimmed ? (
          <View style={styles.rowGap}>
            <Ionicons name="battery-dead" size={16} color={colors.warning} />
            <Muted style={{ color: colors.warning }}>{t('sos.lowBattery')}</Muted>
          </View>
        ) : null}

        <View style={styles.ladder}>
          {LADDER.map(({ key, label }) => {
            const s = state?.rungs[key] ?? 'pending';
            const icon =
              s === 'done'
                ? 'checkmark-circle'
                : s === 'skipped'
                  ? 'remove-circle'
                  : s === 'failed'
                    ? 'close-circle'
                    : s === 'doing'
                      ? 'ellipse'
                      : 'ellipse-outline';
            const color =
              s === 'done'
                ? colors.onDuty
                : s === 'failed'
                  ? colors.warning
                  : s === 'doing'
                    ? colors.warning
                    : colors.textFaint;
            return (
              <View key={key} style={styles.step}>
                <Ionicons name={icon as any} size={18} color={color} />
                <Text style={[styles.stepText, (s === 'skipped' || s === 'pending') && { color: colors.textFaint }]}>
                  {t(label)}
                </Text>
              </View>
            );
          })}
        </View>
      </View>

      <View style={styles.foot}>
        <Pressable onPress={() => setTorchOn((v) => !v)} style={styles.torchToggle}>
          <Ionicons name={torchOn ? 'flashlight' : 'flashlight-outline'} size={20} color="#fff" />
          <Text style={styles.torchText}>{torchOn ? t('sos.torchOn') : t('sos.torchOff')}</Text>
        </Pressable>

        {!cancelling ? (
          <Button label={t('sos.cancel')} variant="ghost" onPress={() => setCancelling(true)} />
        ) : (
          <View style={{ gap: space.sm }}>
            <Muted style={{ textAlign: 'center', color: '#fff' }}>{t('sos.cancelPin')}</Muted>
            <TextInput
              value={pin}
              onChangeText={(v) => {
                setPin(v.replace(/\D/g, '').slice(0, 4));
                setPinErr('');
              }}
              keyboardType="number-pad"
              secureTextEntry
              placeholder="••••"
              placeholderTextColor={colors.textFaint}
              style={styles.pin}
            />
            {pinErr ? <Text style={styles.err}>{pinErr}</Text> : null}
            <Button label={t('sos.confirmCancel')} variant="ghost" onPress={doCancel} disabled={pin.length !== 4} />
            <Button label={t('sos.keepActive')} variant="danger" onPress={() => setCancelling(false)} />
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#2A0A0A' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xl },
  foot: { padding: space.lg, gap: space.md },
  pulse: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { color: '#fff', fontSize: font.h1, fontWeight: '900', textAlign: 'center' },
  timer: { color: '#fff', fontSize: font.h2, fontWeight: '900', letterSpacing: 2 },
  responder: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.onDutyDim,
    borderRadius: radius.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
  },
  responderText: { color: colors.onDuty, fontSize: font.body, fontWeight: '800' },
  ladder: { alignSelf: 'stretch', gap: space.sm, marginTop: space.md },
  step: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  stepText: { color: '#fff', fontSize: font.label, fontWeight: '600' },
  rowGap: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  torchToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    minHeight: 48,
  },
  torchText: { color: '#fff', fontSize: font.label, fontWeight: '700' },
  pin: {
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    color: '#fff',
    fontSize: 24,
    letterSpacing: 8,
    textAlign: 'center',
    paddingVertical: space.md,
  },
  err: { color: colors.warning, textAlign: 'center', fontWeight: '700' },
  // Off-screen, sized so Android still initialises the camera and holds the torch.
  hiddenCam: { position: 'absolute', width: 1, height: 1, opacity: 0, top: -10, left: -10 },
});
