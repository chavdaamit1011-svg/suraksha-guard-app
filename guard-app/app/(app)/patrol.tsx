import { Ionicons } from '@expo/vector-icons';
import { AudioModule, RecordingPresets, useAudioRecorder } from 'expo-audio';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Location from 'expo-location';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Image, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Body, Button, Card, H2, Muted, Screen } from '@/components/ui';
import { useT } from '@/i18n';
import { successFeedback } from '@/lib/feedback';
import { api, type Checkpoint, type PatrolRound } from '@/lib/api';
import { formatCountdown, istTime } from '@/lib/duty';
import { captureMedia } from '@/lib/media';
import { quickFix } from '@/lib/location';
import { nfcState, openNfcSettings, startNfc, type NfcState } from '@/lib/native';
import { enqueue } from '@/lib/queue';
import { guardId, useAuth } from '@/store/auth';
import { useDuty } from '@/store/duty';
import { colors, font, radius, space, touch } from '@/theme';

type Method = 'qr' | 'nfc' | 'manual';
type LocalScan = { checkpointId: string; code: string; at: string; method: Method; verified: boolean };

/**
 * Patrol & checkpoint scanning (PRD 18.7, SUR-GAP-014).
 *
 * A round is a list of checkpoints with big state icons and a "next round in 00:23" timer. The
 * scanner opens straight to the camera — no mode selector — and auto-detects the QR, so a full
 * 8-checkpoint round with no observations is about ten taps.
 *
 * Nothing is ever rejected here. A damaged tag goes down the manual path with a photo of where
 * it should have been; an unverifiable code is still recorded and flagged. Blocking the round
 * would only teach guards to stop scanning it.
 */
export default function Patrol() {
  const t = useT();
  const router = useRouter();
  const guard = useAuth((s) => s.guard);
  const { current, refresh } = useDuty();

  const [perm, requestPerm] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [localScans, setLocalScans] = useState<LocalScan[]>([]);
  const [last, setLast] = useState<{ name: string; verified: boolean; flags: string[]; scanUuid: string } | null>(null);
  const [now, setNow] = useState(Date.now());

  // Photo capture (tag photo for a manual scan, or an observation photo).
  const [photoFor, setPhotoFor] = useState<null | 'tag' | 'obs'>(null);
  const [tagPhoto, setTagPhoto] = useState<string | null>(null);
  const photoCam = useRef<CameraView>(null);

  // Observation on the last scan (PRD 18.7 §6).
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [recording, setRecording] = useState(false);
  const [obsType, setObsType] = useState<null | 'issue' | 'note'>(null);
  const [obsNote, setObsNote] = useState('');
  const [obsPhoto, setObsPhoto] = useState<string | null>(null);
  const [obsVoice, setObsVoice] = useState<string | null>(null);
  const [obsBusy, setObsBusy] = useState(false);
  const [obsSaved, setObsSaved] = useState(false);

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  // NFC tags (PRD 18.7): read in the background while this screen is in front, so tapping a tag
  // is the whole interaction. Phones without NFC, or builds without the native module, use QR.
  const [nfc, setNfc] = useState<NfcState>(() => nfcState());
  const recordRef = useRef<(code: string, method: Method) => void>(() => {});
  useFocusEffect(
    useCallback(() => {
      let stop: () => void = () => {};
      const arm = () => {
        stop();
        stop = () => {};
        const state = nfcState();
        setNfc(state);
        if (state === 'enabled') stop = startNfc((code) => recordRef.current(code, 'nfc'));
      };
      arm();
      // Coming back from the NFC settings page does not refocus the screen, but it does make the
      // app active again.
      const sub = AppState.addEventListener('change', (s) => {
        if (s === 'active') arm();
      });
      return () => {
        sub.remove();
        stop();
      };
    }, [])
  );

  const checkpoints: Checkpoint[] = current?.checkpoints ?? [];
  const rounds: PatrolRound[] = current?.patrolRounds ?? [];

  /** The round in progress, or the next one due. */
  const activeRound = useMemo(() => {
    const open = rounds.find((r) => r.status === 'In progress');
    if (open) return open;
    const upcoming = rounds
      .filter((r) => r.status === 'Scheduled' && Date.parse(r.scheduledTime) >= now - 30 * 60_000)
      .sort((a, b) => Date.parse(a.scheduledTime) - Date.parse(b.scheduledTime));
    return upcoming[0] ?? null;
  }, [rounds, now]);

  const nextRoundSec = activeRound?.scheduledTime
    ? Math.max(0, Math.round((Date.parse(activeRound.scheduledTime) - now) / 1000))
    : null;

  /** Server-recorded scans for this round, plus anything scanned locally since the last bundle. */
  const scannedIds = useMemo(() => {
    const ids = new Set<string>((activeRound?.scans ?? []).map((s) => String(s.checkpointId)));
    localScans.forEach((s) => s.checkpointId && ids.add(s.checkpointId));
    return ids;
  }, [activeRound, localScans]);

  const openScanner = async () => {
    if (!perm?.granted) {
      const res = await requestPerm();
      if (!res.granted) return;
    }
    setLast(null);
    setManualOpen(false);
    setScanning(true);
  };

  const resetObservation = () => {
    setObsType(null);
    setObsNote('');
    setObsPhoto(null);
    setObsVoice(null);
    setObsSaved(false);
  };

  const openPhoto = async (purpose: 'tag' | 'obs') => {
    if (!perm?.granted) {
      const res = await requestPerm();
      if (!res.granted) return;
    }
    setPhotoFor(purpose);
  };

  const takePhoto = async () => {
    try {
      const shot = await photoCam.current?.takePictureAsync({ quality: 0.6, skipProcessing: true });
      if (!shot?.uri) return;
      const small = await ImageManipulator.manipulateAsync(shot.uri, [{ resize: { width: 1280 } }], {
        compress: 0.6,
        format: ImageManipulator.SaveFormat.JPEG,
      });
      if (photoFor === 'tag') setTagPhoto(small.uri);
      else setObsPhoto(small.uri);
    } finally {
      setPhotoFor(null);
    }
  };

  const toggleVoice = async () => {
    try {
      if (recording) {
        await recorder.stop();
        setObsVoice(recorder.uri ?? null);
        setRecording(false);
        return;
      }
      const p = await AudioModule.requestRecordingPermissionsAsync();
      if (!p.granted) return;
      await recorder.prepareToRecordAsync();
      recorder.record();
      setRecording(true);
    } catch {
      setRecording(false);
    }
  };

  /**
   * Attach what the guard saw to the scan just recorded. Evidence is uploaded against the scan's
   * uuid, so it joins the scan whether this call or the outbox delivers the observation.
   */
  const saveObservation = async (type: 'all_ok' | 'issue' | 'note') => {
    if (!last?.scanUuid) return;
    if (recording) await toggleVoice();
    const id = guardId(guard);
    const scanUuid = last.scanUuid;
    setObsBusy(true);
    try {
      const mediaIds: string[] = [];
      for (const [uri, kind] of [
        [obsPhoto, 'incident_photo'],
        [obsVoice, 'voice'],
      ] as const) {
        if (!uri) continue;
        const mediaId = await captureMedia({ guardId: id, uri, kind, clientEventUuid: scanUuid, rosterId: current?.rosterId }).catch(
          () => null
        );
        if (mediaId) mediaIds.push(mediaId);
      }
      const note = obsNote.trim();
      try {
        await api.patrolObservation({ guardId: id, scanUuid, observationType: type, note, mediaIds });
      } catch {
        await enqueue(id, 'patrol_observation', { scanUuid, observation_type: type, note, mediaIds });
      }
      successFeedback();
      setObsSaved(true);
    } finally {
      setObsBusy(false);
    }
  };

  const record = async (raw: string, method: Method, tagPhotoUri?: string) => {
    const code = raw.trim();
    if (busy || !code) return;
    setBusy(true);
    setScanning(false);
    setManualOpen(false);
    setManualCode('');
    setTagPhoto(null);
    resetObservation();

    const id = guardId(guard);
    const at = new Date().toISOString();

    let coords: { lat?: number; lng?: number; accuracy_m?: number } = {};
    // Bounded wait: a stairwell with no GPS records the scan without coords rather than hanging.
    const pos = await quickFix({ timeoutMs: 6_000, maxLastKnownAgeMs: 60_000 });
    if (pos) coords = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy_m: pos.coords.accuracy ?? undefined };

    const payload = {
      rosterId: current?.rosterId,
      siteId: current?.siteId,
      roundId: activeRound?.roundId,
      checkpointCode: code,
      method,
      observation_type: 'all_ok',
      ...coords,
    };

    const event = await enqueue(id, 'patrol_scan', payload);

    // A manual scan must carry a photo of the tag location (PRD 18.7 §8).
    if (tagPhotoUri) {
      captureMedia({
        guardId: id,
        uri: tagPhotoUri,
        kind: 'incident_photo',
        clientEventUuid: event.client_event_uuid,
        rosterId: current?.rosterId,
      }).catch(() => {});
    }

    // Ask the server what it concluded — but the scan already counts locally either way.
    const res = await api
      .patrolScan({ guardId: id, clientEventUuid: event.client_event_uuid, at, ...payload })
      .catch(() => null);

    const matched = checkpoints.find((c) => c.scanCode === code || c.checkpointId === res?.checkpointId);
    setLocalScans((prev) => [
      { checkpointId: res?.checkpointId ?? matched?.checkpointId ?? '', code, at, method, verified: !!res?.verified },
      ...prev,
    ]);
    setLast({
      name: res?.checkpointName || matched?.name || code,
      verified: !!res?.verified,
      flags: res?.flags ?? [],
      scanUuid: event.client_event_uuid,
    });

    Haptics.notificationAsync(
      res?.verified ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning
    ).catch(() => {});

    refresh().catch(() => {});
    setBusy(false);
  };

  /** Server flags in the guard's language; a flag with no translation is left out, never shown raw. */
  const flagText = (flags: string[]) =>
    [...new Set(flags)]
      .map((f) => {
        for (const k of [`patrol.flag.${f}`, `team.flag.${f}`]) {
          const s = t(k);
          if (s !== k) return s;
        }
        return '';
      })
      .filter(Boolean)
      .join(' · ');

  recordRef.current = (code, method) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    record(code, method);
  };

  // --- Scanner ---
  if (scanning) {
    return (
      <Screen scroll={false}>
        <View style={{ flex: 1 }}>
          <CameraView
            style={{ flex: 1 }}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => record(data, 'qr')}
          />
          <View style={styles.scannerFoot}>
            <Muted style={{ textAlign: 'center' }}>{t('patrol.pointAtTag')}</Muted>
            <Button label={t('common.cancel')} variant="ghost" onPress={() => setScanning(false)} />
          </View>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={styles.head}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <H2>{t('patrol.title')}</H2>
        <View style={{ width: 24 }} />
      </View>

      {busy ? (
        <Card style={styles.center}>
          <ActivityIndicator color={colors.primary} />
          <Muted>{t('common.loading')}</Muted>
        </Card>
      ) : last ? (
        <Card
          style={
            last.verified
              ? { borderColor: colors.onDuty, backgroundColor: colors.onDutyDim }
              : { borderColor: colors.warning, backgroundColor: colors.warningDim }
          }
        >
          <View style={styles.rowGap}>
            <Ionicons
              name={last.verified ? 'checkmark-circle' : 'alert-circle'}
              size={22}
              color={last.verified ? colors.onDuty : colors.warning}
            />
            <Body style={{ fontWeight: '800', color: last.verified ? colors.onDuty : colors.warning, flex: 1 }}>
              {last.verified ? t('patrol.verified') : t('patrol.unverified')}
            </Body>
          </View>
          <Text style={styles.code}>{last.name}</Text>
          {flagText(last.flags) ? <Muted>{flagText(last.flags)}</Muted> : null}
        </Card>
      ) : null}

      {/* What did you see? — one tap for the common case (PRD 18.7 §6) */}
      {!busy && last ? (
        obsSaved ? (
          <View style={styles.rowGap}>
            <Ionicons name="checkmark-done" size={18} color={colors.onDuty} />
            <Muted style={{ color: colors.onDuty }}>{t('patrol.obs.saved')}</Muted>
          </View>
        ) : (
          <Card style={{ gap: space.md }}>
            <Muted>{t('patrol.obs.title')}</Muted>
            <View style={styles.obsRow}>
              <ObsButton icon="checkmark-circle" label={t('patrol.obs.allOk')} tone={colors.onDuty} onPress={() => { setObsSaved(true); }} />
              <ObsButton
                icon={obsPhoto ? 'image' : 'camera'}
                label={obsPhoto ? t('patrol.obs.photoAdded') : t('patrol.obs.photo')}
                active={!!obsPhoto}
                onPress={() => { setObsType((o) => o ?? 'note'); openPhoto('obs'); }}
              />
              <ObsButton
                icon={recording ? 'stop-circle' : obsVoice ? 'checkmark-circle' : 'mic'}
                label={recording ? t('patrol.obs.stop') : obsVoice ? t('patrol.obs.voiceAdded') : t('patrol.obs.voice')}
                active={recording || !!obsVoice}
                tone={recording ? colors.danger : undefined}
                onPress={() => { setObsType((o) => o ?? 'note'); toggleVoice(); }}
              />
              <ObsButton
                icon="warning"
                label={t('patrol.obs.issue')}
                tone={colors.danger}
                active={obsType === 'issue'}
                onPress={() => setObsType('issue')}
              />
            </View>

            {obsType ? (
              <>
                {obsPhoto ? <Image source={{ uri: obsPhoto }} style={styles.obsThumb} /> : null}
                <TextInput
                  value={obsNote}
                  onChangeText={setObsNote}
                  placeholder={obsType === 'issue' ? t('patrol.obs.issueHint') : t('patrol.obs.noteHint')}
                  placeholderTextColor={colors.textFaint}
                  multiline
                  style={[styles.input, { minHeight: 64, textAlignVertical: 'top' }]}
                />
                <Button
                  label={obsType === 'issue' ? t('patrol.obs.sendIssue') : t('patrol.obs.save')}
                  variant={obsType === 'issue' ? 'danger' : 'primary'}
                  loading={obsBusy}
                  disabled={obsBusy || (obsType === 'issue' && !obsNote.trim() && !obsPhoto && !obsVoice)}
                  onPress={() => saveObservation(obsType)}
                />
                {obsType === 'issue' ? (
                  <Button
                    label={t('patrol.obs.fullIncident')}
                    variant="ghost"
                    size="small"
                    onPress={() => router.push('/incident')}
                  />
                ) : null}
              </>
            ) : null}
          </Card>
        )
      ) : null}

      {/* Next-round timer (PRD 18.7 §5) */}
      {activeRound && nextRoundSec !== null && nextRoundSec > 0 ? (
        <Card style={{ borderColor: colors.warning }}>
          <View style={styles.rowBetween}>
            <View style={styles.rowGap}>
              <Ionicons name="time" size={20} color={colors.warning} />
              <Muted>{t('patrol.nextRound')}</Muted>
            </View>
            <Text style={styles.timer}>{formatCountdown(nextRoundSec)}</Text>
          </View>
        </Card>
      ) : activeRound ? (
        <Card style={{ borderColor: colors.onDuty }}>
          <View style={styles.rowGap}>
            <Ionicons name="walk" size={20} color={colors.onDuty} />
            <Body style={{ fontWeight: '800', flex: 1 }}>{t('patrol.roundInProgress')}</Body>
            <Text style={styles.progress}>
              {scannedIds.size}/{checkpoints.length || activeRound.checkpointIds.length}
            </Text>
          </View>
        </Card>
      ) : null}

      <Button
        label={t('patrol.scan')}
        size="huge"
        variant="primary"
        icon={<Ionicons name="qr-code" size={26} color={colors.onPrimary} />}
        onPress={openScanner}
      />

      {nfc === 'enabled' ? (
        <View style={styles.nfcRow}>
          <Ionicons name="radio" size={18} color={colors.onDuty} />
          <Muted style={{ flex: 1, color: colors.onDuty }}>{t('patrol.nfcReady')}</Muted>
        </View>
      ) : nfc === 'disabled' ? (
        <Pressable onPress={openNfcSettings} style={styles.nfcRow}>
          <Ionicons name="radio-outline" size={18} color={colors.warning} />
          <Muted style={{ flex: 1, color: colors.warning }}>{t('patrol.nfcOff')}</Muted>
          <Ionicons name="chevron-forward" size={16} color={colors.warning} />
        </Pressable>
      ) : null}

      {/* Checkpoint list with big state icons (PRD 18.7 §5) */}
      {checkpoints.length > 0 ? (
        <View style={{ gap: space.sm }}>
          <Muted>{t('patrol.checkpoints')}</Muted>
          {checkpoints.map((c) => {
            const done = scannedIds.has(c.checkpointId);
            return (
              <Card key={c.checkpointId} style={styles.cpRow}>
                <Ionicons
                  name={done ? 'checkmark-circle' : 'ellipse-outline'}
                  size={26}
                  color={done ? colors.onDuty : colors.textFaint}
                />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.cpName, !done && { color: colors.textMuted }]}>{c.name}</Text>
                  <Muted>
                    {t('patrol.order')} {c.order} · {c.scanType}
                  </Muted>
                </View>
              </Card>
            );
          })}
        </View>
      ) : (
        <Card style={styles.center}>
          <Ionicons name="walk" size={28} color={colors.textFaint} />
          <Muted style={{ textAlign: 'center' }}>{t('patrol.noCheckpoints')}</Muted>
        </Card>
      )}

      {/* Damaged-tag fallback (PRD 18.7 §16) */}
      {manualOpen ? (
        <Card style={{ gap: space.md }}>
          <Muted>{t('patrol.enterCode')}</Muted>
          <TextInput
            value={manualCode}
            onChangeText={setManualCode}
            placeholder="SGP:site:checkpoint:hmac"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
          <Muted>{t('patrol.manualNote')}</Muted>
          {/* A keyed-in code must carry a photo of where the tag is (PRD 18.7 §8). */}
          <Pressable onPress={() => openPhoto('tag')} style={styles.tagPhotoBtn}>
            {tagPhoto ? (
              <Image source={{ uri: tagPhoto }} style={styles.tagThumb} />
            ) : (
              <Ionicons name="camera" size={24} color={colors.primary} />
            )}
            <Text style={styles.cpName}>{tagPhoto ? t('patrol.tagPhotoAdded') : t('patrol.tagPhoto')}</Text>
          </Pressable>
          <Button
            label={t('patrol.submitCode')}
            variant="success"
            onPress={() => record(manualCode, 'manual', tagPhoto ?? undefined)}
            disabled={!manualCode.trim() || !tagPhoto}
            icon={<Ionicons name="send" size={18} color="#fff" />}
          />
          <Button label={t('common.cancel')} variant="ghost" size="small" onPress={() => setManualOpen(false)} />
        </Card>
      ) : (
        <Button
          label={t('patrol.tagNotWorking')}
          variant="ghost"
          icon={<Ionicons name="create-outline" size={20} color={colors.text} />}
          onPress={() => {
            setLast(null);
            setManualOpen(true);
          }}
        />
      )}

      {localScans.length > 0 ? (
        <View style={{ gap: space.sm }}>
          <Muted>{t('patrol.thisSession')}</Muted>
          {localScans.map((s, i) => (
            <Card key={`${s.at}-${i}`} style={styles.cpRow}>
              <Ionicons
                name={s.verified ? 'checkmark-circle' : 'alert-circle'}
                size={20}
                color={s.verified ? colors.onDuty : colors.warning}
              />
              <Text style={[styles.code, { flex: 1 }]} numberOfLines={1}>
                {s.code}
              </Text>
              <Ionicons
                name={s.method === 'qr' ? 'qr-code-outline' : 'create-outline'}
                size={16}
                color={colors.textFaint}
              />
              <Muted>{istTime(s.at)}</Muted>
            </Card>
          ))}
        </View>
      ) : null}

      <View style={styles.rowGap}>
        <Ionicons name="lock-closed" size={14} color={colors.textFaint} />
        <Muted style={{ flex: 1 }}>{t('patrol.hmacNote')}</Muted>
      </View>

      <Modal visible={photoFor !== null} animationType="slide" onRequestClose={() => setPhotoFor(null)}>
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <CameraView ref={photoCam} style={{ flex: 1 }} facing="back" />
          <View style={styles.photoFoot}>
            <Button label={t('common.cancel')} variant="ghost" onPress={() => setPhotoFor(null)} />
            <Pressable onPress={takePhoto} style={styles.shutter} />
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

function ObsButton({
  icon,
  label,
  onPress,
  tone,
  active,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  tone?: string;
  active?: boolean;
}) {
  const c = tone ?? colors.primary;
  return (
    <Pressable onPress={onPress} style={[styles.obsBtn, active && { borderColor: c, backgroundColor: 'rgba(255,255,255,0.06)' }]}>
      <Ionicons name={icon} size={26} color={c} />
      <Text style={styles.obsLabel} numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  center: { alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingVertical: space.xl },
  scannerFoot: { padding: space.lg, gap: space.sm },
  rowGap: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  code: { color: colors.text, fontSize: font.label, fontWeight: '800' },
  timer: { color: colors.warning, fontSize: font.h2, fontWeight: '900', letterSpacing: 1 },
  progress: { color: colors.onDuty, fontSize: font.h3, fontWeight: '900' },
  cpRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  cpName: { color: colors.text, fontSize: font.body, fontWeight: '700' },
  obsRow: { flexDirection: 'row', gap: space.sm },
  nfcRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: touch.minTap },
  obsBtn: {
    flex: 1,
    minHeight: 60,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 4,
  },
  obsLabel: { color: colors.text, fontSize: font.tiny, fontWeight: '800', textAlign: 'center' },
  obsThumb: { width: '100%', height: 160, borderRadius: radius.md },
  tagPhotoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.primary,
    borderRadius: radius.md,
    padding: space.md,
    minHeight: 52,
  },
  tagThumb: { width: 48, height: 48, borderRadius: radius.sm },
  photoFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    padding: space.xl,
    backgroundColor: '#000',
  },
  shutter: { width: 76, height: 76, borderRadius: 38, borderWidth: 5, borderColor: '#fff', backgroundColor: 'rgba(255,255,255,0.25)' },
  input: {
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: font.body,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    minHeight: touch.minTap,
  },
});
