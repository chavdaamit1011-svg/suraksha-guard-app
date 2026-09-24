import { goBack } from '@/lib/navigation';
import { Ionicons } from '@expo/vector-icons';
import NetInfo from '@react-native-community/netinfo';
import * as Battery from 'expo-battery';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Location from 'expo-location';
import * as Speech from 'expo-speech';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button, Card, H2, Muted, Screen } from '@/components/ui';
import { DUTY } from '@/config';
import { useI18n, useT } from '@/i18n';
import { api } from '@/lib/api';
import { useBrightScreen } from '@/lib/brightness';
import { deviceMeta, getDeviceId, integritySignals } from '@/lib/device';
import { formatDistance, geofenceHint } from '@/lib/duty';
import { successFeedback } from '@/lib/feedback';
import { captureMedia, hashFile } from '@/lib/media';
import { checkFace, type FaceVerdict } from '@/lib/native';
import { enqueue } from '@/lib/queue';
import { guardId, useAuth } from '@/store/auth';
import { useDuty } from '@/store/duty';
import { colors, font, radius, space, touch } from '@/theme';

type Fix = { lat: number; lng: number; acc: number; mock: boolean; provider: string };
type LocState = 'finding' | 'inside' | 'outside' | 'unknown';

/** PRD 18.17.2: the out-of-geofence exception adds exactly one screen — chips, not free text. */
const OUTSIDE_REASONS = ['traffic', 'wrongGate', 'siteEmergency', 'other'] as const;
const EARLY_OUT_REASONS = ['relieved', 'unwell', 'siteEmergency', 'other'] as const;

/**
 * GPS check-in / check-out (PRD 18.5, SUR-GAP-010/011/012/036).
 *
 * The target is two taps and zero typing: tap CHECK IN, the sheet opens with location already
 * warming and the camera live, the selfie auto-captures on the first good frame, tap CONFIRM.
 * Everything else — geofence verdict, trust scoring, late calculation — is the server's job.
 *
 * Nothing here blocks duty (18.5 §8). A missing fix, a refused camera, a failed upload: the
 * event is still written to the outbox and the guard is still checked in. Verification failures
 * downgrade the record's confidence and raise a review task; they never stop a guard working.
 */
export default function CheckIn() {
  const t = useT();
  const lang = useI18n((s) => s.lang);
  const router = useRouter();
  const { mode } = useLocalSearchParams<{ mode: 'in' | 'out' }>();
  const isIn = mode !== 'out';

  const guard = useAuth((s) => s.guard);
  const { current, duty, booking, refresh, markAttendance } = useDuty();

  const [perm, requestPerm] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const autoShotDone = useRef(false);

  const [fix, setFix] = useState<Fix | null>(null);
  const [locState, setLocState] = useState<LocState>('finding');
  const [distance, setDistance] = useState<number | null>(null);
  const [selfie, setSelfie] = useState<string | null>(null);
  const [camReady, setCamReady] = useState(false);
  const [reason, setReason] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<null | { at: string; queued: boolean }>(null);

  // Two-tap check-in KPI (PRD SUR-GAP-036): the CHECK IN tap on home is tap 1; every tap on this
  // screen adds one. The median across guards should be 2 (CHECK IN, CONFIRM).
  const taps = useRef(1);
  const openedAt = useRef(Date.now());
  const manualShot = useRef(false);

  useBrightScreen();

  const faceRetries = useRef(0);
  const faceVerdict = useRef<FaceVerdict>('unchecked');
  const [faceHint, setFaceHint] = useState('');
  const tap = () => {
    taps.current += 1;
  };

  /**
   * The on-demand B2C flow still needs the client's arrival/check-out code — that is the client
   * confirming the guard is physically there. Rostered duty has the geofence instead, so asking
   * for a code would be one more thing to type for no added evidence.
   */
  const needsOtp = !current && !!booking;

  // --- Location: start warming immediately; the guard opened this screen to check in ---
  // Runs once. It used to depend on the duty bundle, which the background refresh replaces every
  // few seconds — each replacement cancelled the fix in flight, so a slow GPS never finished.
  useEffect(() => {
    let cancelled = false;
    const toFix = (pos: Location.LocationObject): Fix => ({
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      acc: pos.coords.accuracy ?? 999,
      mock: (pos as any).mocked ?? false,
      provider: (pos.coords.accuracy ?? 999) <= 30 ? 'gps' : 'fused',
    });
    const withTimeout = <T,>(p: Promise<T>, ms: number) =>
      Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);

    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return setLocState('unknown');

        // A recent fix shows something at once; the fresh reading replaces it.
        const recent = await Location.getLastKnownPositionAsync({ maxAge: 120_000 }).catch(() => null);
        if (recent && !cancelled) setFix(toFix(recent));

        // Indoors a high-accuracy fix may never come. Never leave the guard waiting on it
        // (PRD 18.17.1 rule 12): fall back to a network fix, then to "unknown", which the server
        // routes to supervisor verification.
        let pos = await withTimeout(Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }), 15_000).catch(
          () => null
        );
        if (!pos) {
          pos = await withTimeout(Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }), 10_000).catch(
            () => null
          );
        }
        if (cancelled) return;
        if (pos) setFix(toFix(pos));
        else if (!recent) setLocState('unknown');
      } catch {
        if (!cancelled) setLocState('unknown');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Client-side hint only — the server re-evaluates against the site on ingest.
  useEffect(() => {
    if (!fix) return;
    const targetSite = current
      ? current
      : booking?.location?.lat != null && booking?.location?.lng != null
      ? { lat: booking.location.lat, lng: booking.location.lng, radiusM: 200 }
      : null;
    const hint = geofenceHint(targetSite as any, fix.lat, fix.lng);
    setDistance(hint.distanceM);
    setLocState(hint.result);
  }, [fix, current, booking]);

  // For on-demand bookings in check-out mode: ensure checkout is initiated on the server so the client has the OTP
  useEffect(() => {
    if (!isIn && booking && booking.bookingStatus === 'ACTIVE') {
      const id = guardId(guard);
      if (id) {
        api.initiateCheckout(booking.bookingId, id).catch(() => {});
      }
    }
  }, [isIn, booking?.bookingId, booking?.bookingStatus, guard]);

  useEffect(() => {
    if (!perm?.granted) requestPerm();
  }, [perm?.granted]);

  const capture = useCallback(async () => {
    try {
      const shot = await cam.current?.takePictureAsync({ quality: 0.5, skipProcessing: true });
      if (!shot?.uri) return;
      // 400 KB target after compression (PRD 18.1 §8) — a selfie needs recognisability, not detail.
      const compressed = await ImageManipulator.manipulateAsync(shot.uri, [{ resize: { width: 640 } }], {
        compress: 0.5,
        format: ImageManipulator.SaveFormat.JPEG,
      });
      // On-device face check: a frame with no face, two faces or closed eyes is retaken
      // automatically, twice at most. After that the photo is kept anyway — a poor selfie is
      // flagged for review on the server, it never stops the check-in (PRD 18.5 §10).
      const { verdict } = await checkFace(compressed.uri);
      faceVerdict.current = verdict;
      if (verdict !== 'ok' && verdict !== 'unchecked' && faceRetries.current < 2) {
        faceRetries.current += 1;
        setFaceHint(t(`face.${verdict}`));
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
        autoShotDone.current = false; // the auto-capture effect takes the next shot
        setCamReady(false);
        setTimeout(() => setCamReady(true), 1200);
        return;
      }
      setFaceHint('');
      setSelfie(compressed.uri);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    } catch {
      setError(t('checkin.cameraError'));
    }
  }, [t]);

  /**
   * Auto-capture: no shutter button (PRD 18.5 §5). The shot is taken once the camera settles,
   * then checked on the device for a single, open-eyed, front-on face (see `capture`).
   */
  useEffect(() => {
    if (!camReady || selfie || autoShotDone.current) return;
    autoShotDone.current = true;
    try {
      Speech.speak(t('checkin.lookAtCamera'), { language: lang === 'en' ? 'en-IN' : 'hi-IN' });
    } catch {
      /* no TTS voice for this language — the oval guide carries the instruction */
    }
    const timer = setTimeout(capture, 1500);
    return () => clearTimeout(timer);
  }, [camReady, selfie, capture, lang, t]);

  const reasonRequired = (isIn && locState === 'outside') || (!isIn && duty.earlyOutReasonRequired);

  const confirm = async () => {
    if (!guard) return;
    if (reasonRequired && !reason) return setError(t('checkin.pickReason'));
    if (needsOtp && otp.length !== 6) return setError(isIn ? t('duty.arrivalOtp') : t('duty.checkoutOtp'));

    setBusy(true);
    setError('');
    const id = guardId(guard);

    try {
      const [batteryPct, batteryState, net, photoHash, integrity] = await Promise.all([
        Battery.getBatteryLevelAsync().catch(() => -1),
        Battery.getBatteryStateAsync().catch(() => Battery.BatteryState.UNKNOWN),
        NetInfo.fetch().catch(() => null),
        selfie ? hashFile(selfie) : Promise.resolve(''),
        integritySignals(),
      ]);
      const isOnline = !!net?.isConnected;

      // 1. Metadata to the durable outbox first — this is the record that must survive.
      const event = await enqueue(id, isIn ? 'check_in' : 'check_out', {
        rosterId: current?.rosterId,
        bookingId: booking?.bookingId,
        siteId: current?.siteId,
        device_id: await getDeviceId(),
        device: deviceMeta,
        lat: fix?.lat,
        lng: fix?.lng,
        accuracy_m: fix?.acc,
        provider: fix?.provider,
        battery_pct: batteryPct >= 0 ? Math.round(batteryPct * 100) : undefined,
        is_charging: batteryState === Battery.BatteryState.CHARGING || batteryState === Battery.BatteryState.FULL,
        network_state: isOnline ? 'online' : 'offline',
        is_mock_location: fix?.mock ?? false,
        // Integrity hints (PRD 18.6 §9). Sent, scored, and invisible to the guard unless a
        // supervisor later needs the context — a rooted budget phone is not misconduct.
        ...integrity,
        geofence_result: locState === 'finding' ? 'unknown' : locState,
        outside_reason: isIn && reason ? reason : undefined,
        early_out_reason: !isIn && reason ? reason : undefined,
        photo_hash: photoHash,
        face_check: selfie ? faceVerdict.current : undefined,
      });

      // 2. Evidence trails it (PRD 18.15.3), tagged with the same uuid so the server binds them.
      if (selfie) {
        captureMedia({
          guardId: id,
          uri: selfie,
          kind: 'selfie',
          clientEventUuid: event.client_event_uuid,
          rosterId: current?.rosterId,
          bookingId: booking?.bookingId,
        }).catch(() => {});
      }

      api.track(isIn ? 'gap_check_in' : 'gap_check_out', {
        geofence: locState,
        distanceM: distance,
        mock: fix?.mock ?? false,
        acc: fix?.acc,
        rostered: !!current,
      });
      api.track('checkin_taps', {
        kind: isIn ? 'in' : 'out',
        taps: taps.current,
        seconds: Math.round((Date.now() - openedAt.current) / 1000),
        reasonRequired,
        autoCapture: !!selfie && !manualShot.current,
        geofence: locState,
      });

      // 3. Drive the on-demand booking state machine when this is a B2C duty.
      if (booking && needsOtp) {
        try {
          if (isIn) {
            await api.startDuty(booking.bookingId, id, otp);
          } else {
            await api.completeDuty(booking.bookingId, id, otp);
          }
        } catch (apiErr: any) {
          setError(apiErr?.message || (isIn ? t('duty.arrivalOtp') : t('duty.checkoutOtp')));
          setBusy(false);
          return;
        }
      }

      // 4. Move the UI now — the record is safe either way.
      markAttendance(isIn ? 'in' : 'out');
      successFeedback();
      setSaved({ at: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }), queued: !isOnline });

      refresh().catch(() => {});
      setTimeout(() => router.replace('/home'), 2200);
    } catch {
      // The record could not even be written to the phone (storage full or locked).
      setError(t('checkin.notSaved'));
    } finally {
      setBusy(false);
    }
  };

  if (saved) {
    return (
      <Screen scroll={false}>
        <View style={styles.successWrap}>
          <View style={styles.successCircle}>
            <Ionicons name="checkmark" size={72} color="#fff" />
          </View>
          <H2>{isIn ? t('checkin.checkedIn') : t('checkin.checkedOut')}</H2>
          <Text style={styles.successMeta}>
            {saved.at}
            {current?.siteName
              ? ` · ${current.siteName}`
              : booking?.location?.address || booking?.location?.city
              ? ` · ${booking.location.address || booking.location.city}`
              : ''}
          </Text>
          {saved.queued ? (
            <View style={styles.rowGap}>
              <Ionicons name="cloud-offline" size={16} color={colors.warning} />
              <Muted style={{ color: colors.warning }}>{t('checkin.savedOffline')}</Muted>
            </View>
          ) : null}
        </View>
      </Screen>
    );
  }

  const loc = {
    finding: { icon: 'locate' as const, color: colors.warning, text: t('checkin.finding') },
    inside: {
      icon: 'checkmark-circle' as const,
      color: colors.onDuty,
      text: current?.siteName
        ? `${t('checkin.inArea')} · ${current.siteName}`
        : booking?.location?.address || booking?.location?.city
        ? `${t('checkin.inArea')} · ${booking.location.address || booking.location.city}`
        : t('checkin.inArea'),
    },
    outside: {
      icon: 'alert-circle' as const,
      color: colors.warning,
      text: distance !== null ? `${t('checkin.outOfArea')} · ${formatDistance(distance)}` : t('checkin.outOfArea'),
    },
    unknown: { icon: 'help-circle' as const, color: colors.textMuted, text: t('checkin.locationUnknown') },
  }[locState];

  const reasonSet = isIn ? OUTSIDE_REASONS : EARLY_OUT_REASONS;

  return (
    <Screen>
      <View style={styles.head}>
        <Pressable onPress={() => goBack()} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <H2>{isIn ? t('duty.checkIn') : t('duty.checkOut')}</H2>
        <View style={{ width: 24 }} />
      </View>

      {/* The three status rows: Location · Time · Face (PRD 18.5 §5) */}
      <Card>
        <Row icon={loc.icon} color={loc.color} label={t('checkin.location')} value={loc.text} />
        <Row
          icon="time"
          color={colors.onDuty}
          label={t('checkin.time')}
          value={new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
        />
        <Row
          icon={selfie ? 'checkmark-circle' : 'camera'}
          color={selfie ? colors.onDuty : colors.textFaint}
          label={t('checkin.face')}
          value={selfie ? t('checkin.captured') : t('checkin.capturing')}
        />
      </Card>

      {/* Face capture — auto, with a manual fallback if auto-capture missed */}
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        {selfie ? (
          <View style={styles.faceDone}>
            <Ionicons name="checkmark-circle" size={48} color={colors.onDuty} />
            <Muted>{t('checkin.captured')}</Muted>
            <Button
              label={t('common.retry')}
              variant="ghost"
              size="small"
              onPress={() => {
                tap();
                manualShot.current = true;
                autoShotDone.current = false;
                faceRetries.current = 0;
                setSelfie(null);
              }}
            />
          </View>
        ) : perm?.granted ? (
          <View>
            <View style={styles.ovalWrap}>
              <CameraView ref={cam} style={styles.camera} facing="front" onCameraReady={() => setCamReady(true)} />
              <View style={styles.oval} pointerEvents="none" />
            </View>
            <View style={{ padding: space.md, gap: space.sm }}>
              <Muted style={{ textAlign: 'center' }}>{t('checkin.lookAtCamera')}</Muted>
              {faceHint ? <Text style={styles.faceHint}>{faceHint}</Text> : null}
              <Button label={t('checkin.captureNow')} variant="ghost" size="small" onPress={() => {
                  tap();
                  manualShot.current = true;
                  capture();
                }} />
            </View>
          </View>
        ) : (
          <View style={styles.faceDone}>
            <Ionicons name="camera-outline" size={40} color={colors.textFaint} />
            <Muted style={{ textAlign: 'center' }}>{t('checkin.noCameraOk')}</Muted>
          </View>
        )}
      </Card>

      {/* The exception path: one chip row, no typing (PRD 18.17.2) */}
      {reasonRequired ? (
        <View style={{ gap: space.sm }}>
          <Text style={styles.fieldLabel}>{isIn ? t('checkin.outsideReason') : t('checkin.earlyOutReason')}</Text>
          <View style={styles.chips}>
            {reasonSet.map((r) => {
              const active = reason === r;
              return (
                <Pressable
                  key={r}
                  onPress={() => {
                    tap();
                    setReason(r);
                  }}
                  style={[styles.chip, active && { borderColor: colors.warning, backgroundColor: colors.warningDim }]}
                >
                  <Text style={[styles.chipText, { color: active ? colors.text : colors.textMuted }]}>
                    {t(`checkin.reason.${r}`)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      {needsOtp ? (
        <View style={{ gap: space.xs }}>
          <Muted>{isIn ? t('duty.arrivalOtp') : t('duty.checkoutOtp')}</Muted>
          <TextInput
            value={otp}
            onChangeText={(v) => setOtp(v.replace(/\D/g, '').slice(0, 6))}
            keyboardType="number-pad"
            placeholder="------"
            placeholderTextColor={colors.textFaint}
            style={styles.otp}
          />
        </View>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Button
        label={isIn ? t('checkin.confirm') : t('checkin.confirmOut')}
        size="huge"
        variant={isIn ? 'success' : 'primary'}
        onPress={() => {
          tap();
          confirm();
        }}
        loading={busy}
        // Deliberately NOT gated on the selfie or the fix: a guard with a broken camera or no GPS
        // still has to be able to mark duty (PRD 18.17.1 rule 12).
        disabled={busy || (needsOtp && otp.length !== 6) || (reasonRequired && !reason)}
      />

      {fix?.mock ? (
        <View style={styles.rowGap}>
          <Ionicons name="warning" size={16} color={colors.warning} />
          <Muted style={{ flex: 1, color: colors.warning }}>{t('checkin.mockWarning')}</Muted>
        </View>
      ) : null}
    </Screen>
  );
}

function Row({
  icon,
  color,
  label,
  value,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.row}>
      <Ionicons name={icon} size={22} color={color} />
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, { color }]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.xs },
  rowLabel: { color: colors.text, fontSize: font.body, width: 86 },
  rowValue: { flex: 1, fontWeight: '800', fontSize: font.label, textAlign: 'right' },
  camera: { width: '100%', height: 340 },
  ovalWrap: { position: 'relative' },
  oval: {
    position: 'absolute',
    alignSelf: 'center',
    top: 30,
    width: 210,
    height: 280,
    borderRadius: 140,
    borderWidth: 3,
    borderColor: colors.primary,
    opacity: 0.85,
  },
  faceDone: { height: 200, alignItems: 'center', justifyContent: 'center', gap: space.sm, padding: space.lg },
  fieldLabel: { color: colors.textFaint, fontSize: font.tiny, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    minHeight: touch.minTap,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  chipText: { fontSize: font.body, fontWeight: '700' },
  otp: {
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: 28,
    fontWeight: '900',
    letterSpacing: 10,
    textAlign: 'center',
    paddingVertical: space.md,
  },
  error: { color: colors.danger, fontWeight: '700' },
  faceHint: { color: colors.warning, fontWeight: '800', textAlign: 'center' },
  rowGap: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  successWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.lg, padding: space.xl },
  successCircle: {
    width: 150,
    height: 150,
    borderRadius: 75,
    backgroundColor: colors.onDuty,
    alignItems: 'center',
    justifyContent: 'center',
  },
  successMeta: { color: colors.textMuted, fontSize: font.body, fontWeight: '700', textAlign: 'center' },
});
