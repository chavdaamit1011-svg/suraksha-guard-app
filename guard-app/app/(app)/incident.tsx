import { Ionicons } from '@expo/vector-icons';
import { AudioModule, RecordingPresets, useAudioRecorder } from 'expo-audio';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Body, Button, Card, Field, H2, Muted, Screen } from '@/components/ui';
import { useT } from '@/i18n';
import { successFeedback } from '@/lib/feedback';
import { api } from '@/lib/api';
import { quickFix } from '@/lib/location';
import { captureMedia, uploadNow, type MediaKind } from '@/lib/media';
import { enqueue } from '@/lib/queue';
import { KEYS, store } from '@/lib/storage';
import { guardId, useAuth } from '@/store/auth';
import { goBack } from '@/lib/navigation';
import { useDuty } from '@/store/duty';
import { colors, font, radius, space, touch } from '@/theme';

/** PRD 18.10 §5: a 3×3 icon grid with spoken labels. */
type IncidentType = { key: string; icon: keyof typeof Ionicons.glyphMap; color: string };
const TYPES: IncidentType[] = [
  { key: 'theft', icon: 'bag-remove', color: colors.danger },
  { key: 'trespass', icon: 'walk', color: colors.warning },
  { key: 'assault', icon: 'hand-left', color: colors.danger },
  { key: 'fire', icon: 'flame', color: colors.danger },
  { key: 'medical', icon: 'medkit', color: colors.info },
  { key: 'damage', icon: 'hammer', color: colors.warning },
  { key: 'vehicle', icon: 'car', color: colors.warning },
  { key: 'suspicious', icon: 'eye', color: colors.warning },
  { key: 'other', icon: 'ellipsis-horizontal', color: colors.textMuted },
];

/** PRD 18.10 §5: three coloured buttons. */
type Severity = 'low' | 'serious' | 'emergency';
const SEVERITIES: { key: Severity; color: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'low', color: colors.onDuty, icon: 'information-circle' },
  { key: 'serious', color: colors.warning, icon: 'warning' },
  { key: 'emergency', color: colors.danger, icon: 'alert-circle' },
];

const MAX_VIDEO_SECONDS = 30;
const MAX_VOICE_SECONDS = 120;
const DRAFT_SAVE_MS = 3000;

type Attachment = { uri: string; kind: MediaKind; seconds?: number };

type Draft = {
  type: string;
  description: string;
  severity: Severity;
  injuries: boolean | null;
  policeInformed: boolean | null;
  attachments: Attachment[];
  savedAt: number;
};

function fmt(sec: number) {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/**
 * Incident reporting (PRD 18.10, SUR-GAP-019).
 *
 * Built around one number: **median time to submit under 90 seconds**, from someone who may not
 * be able to write. The minimum path is four taps and a voice note, with no typing at all — pick
 * a type, hold to record, pick a severity, submit.
 *
 * Two things that only matter when it goes wrong:
 *  - the draft **auto-saves every three seconds and survives the app being killed**, because an
 *    incident is reported during the incident, and that is exactly when a guard gets interrupted.
 *  - an **Emergency sends a ~40 KB thumbnail first** so the operator sees something within a
 *    second or two, rather than waiting on the full photo over 2G.
 */
export default function Incident() {
  const t = useT();
  const router = useRouter();
  const guard = useAuth((s) => s.guard);
  const { current, booking } = useDuty();

  const [camPerm, requestCamPerm] = useCameraPermissions();
  const [micPerm, requestMicPerm] = useMicrophonePermissions();
  const cam = useRef<CameraView>(null);

  const [type, setType] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<Severity>('serious');
  const [injuries, setInjuries] = useState<boolean | null>(null);
  const [policeInformed, setPoliceInformed] = useState<boolean | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  const [camMode, setCamMode] = useState<null | 'photo' | 'video'>(null);
  const [recordingVideo, setRecordingVideo] = useState(false);
  const [videoSeconds, setVideoSeconds] = useState(0);

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [recordingVoice, setRecordingVoice] = useState(false);
  const [voiceSeconds, setVoiceSeconds] = useState(0);

  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<null | { id: string; escalated: boolean; queued: boolean }>(null);
  const [error, setError] = useState('');
  const [restored, setRestored] = useState(false);

  const hydrated = useRef(false);

  // ---------------------------------------------------------------- drafts
  useEffect(() => {
    (async () => {
      const d = await store.getJSON<Draft | null>(KEYS.incidentDraft, null);
      // Only offer to resume something recent. A week-old draft is noise, not help.
      if (d && Date.now() - d.savedAt < 24 * 3600_000 && (d.type || d.description || d.attachments.length)) {
        setType(d.type);
        setDescription(d.description);
        setSeverity(d.severity);
        setInjuries(d.injuries);
        setPoliceInformed(d.policeInformed);
        setAttachments(d.attachments ?? []);
        setRestored(true);
      }
      hydrated.current = true;
    })();
  }, []);

  useEffect(() => {
    if (!hydrated.current || done) return;
    const timer = setTimeout(() => {
      const draft: Draft = {
        type,
        description,
        severity,
        injuries,
        policeInformed,
        attachments,
        savedAt: Date.now(),
      };
      store.setJSON(KEYS.incidentDraft, draft);
    }, DRAFT_SAVE_MS);
    return () => clearTimeout(timer);
  }, [type, description, severity, injuries, policeInformed, attachments, done]);

  const discardDraft = useCallback(async () => {
    await store.del(KEYS.incidentDraft);
    setType('');
    setDescription('');
    setSeverity('serious');
    setInjuries(null);
    setPoliceInformed(null);
    setAttachments([]);
    setRestored(false);
  }, []);

  // ------------------------------------------------------------ voice note
  useEffect(() => {
    if (!recordingVoice) return;
    const iv = setInterval(() => setVoiceSeconds((s) => s + 1), 1000);
    return () => clearInterval(iv);
  }, [recordingVoice]);

  useEffect(() => {
    if (recordingVoice && voiceSeconds >= MAX_VOICE_SECONDS) stopVoice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceSeconds, recordingVoice]);

  const startVoice = async () => {
    try {
      const res = await AudioModule.requestRecordingPermissionsAsync();
      if (!res.granted) return;
      await recorder.prepareToRecordAsync();
      recorder.record();
      setVoiceSeconds(0);
      setRecordingVoice(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    } catch {
      setError(t('incident.micError'));
    }
  };

  const stopVoice = async () => {
    try {
      await recorder.stop();
      if (recorder.uri) {
        setAttachments((a) => [...a, { uri: recorder.uri!, kind: 'voice', seconds: voiceSeconds }]);
      }
    } catch {
      /* nothing usable was recorded */
    }
    setRecordingVoice(false);
  };

  // ----------------------------------------------------------------- video
  useEffect(() => {
    if (!recordingVideo) return;
    const iv = setInterval(() => setVideoSeconds((s) => s + 1), 1000);
    return () => clearInterval(iv);
  }, [recordingVideo]);

  const openCamera = async (mode: 'photo' | 'video') => {
    if (!camPerm?.granted) {
      const res = await requestCamPerm();
      if (!res.granted) return;
    }
    if (mode === 'video' && !micPerm?.granted) {
      // A silent video of an assault is far less useful than one with audio, but a refused
      // microphone must not block the recording entirely.
      await requestMicPerm();
    }
    setCamMode(mode);
  };

  const takePhoto = async () => {
    try {
      const shot = await cam.current?.takePictureAsync({ quality: 0.6, skipProcessing: true });
      if (!shot?.uri) return;
      // 400 KB target after compression (PRD 18.10 §8).
      const full = await ImageManipulator.manipulateAsync(shot.uri, [{ resize: { width: 1280 } }], {
        compress: 0.6,
        format: ImageManipulator.SaveFormat.JPEG,
      });
      setAttachments((a) => [...a, { uri: full.uri, kind: 'incident_photo' }]);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    } catch {
      setError(t('incident.cameraError'));
    } finally {
      setCamMode(null);
    }
  };

  const startVideo = async () => {
    setRecordingVideo(true);
    setVideoSeconds(0);
    try {
      // The promise resolves when recording stops, whether by the cap or by the guard.
      const clip = await cam.current?.recordAsync({ maxDuration: MAX_VIDEO_SECONDS });
      if (clip?.uri) setAttachments((a) => [...a, { uri: clip.uri, kind: 'incident_video' }]);
    } catch {
      setError(t('incident.cameraError'));
    } finally {
      setRecordingVideo(false);
      setCamMode(null);
    }
  };

  const stopVideo = () => {
    try {
      cam.current?.stopRecording();
    } catch {
      /* already stopped */
    }
  };

  const removeAttachment = (i: number) => setAttachments((a) => a.filter((_, idx) => idx !== i));

  // ---------------------------------------------------------------- submit
  const submit = async () => {
    if (recordingVoice) await stopVoice();
    if (!type) return setError(t('incident.pickType'));
    if (!description.trim() && attachments.length === 0) return setError(t('incident.needEvidence'));

    setBusy(true);
    setError('');
    const id = guardId(guard);

    try {
      // Bounded: an emergency report must not wait on a GPS fix that may never come.
      const pos = await quickFix({ accuracy: Location.Accuracy.Balanced, timeoutMs: 5_000 });

      // Metadata first, always (PRD 18.15.3). The operator sees the event before the evidence.
      const event = await enqueue(id, 'incident', {
        rosterId: current?.rosterId,
        bookingId: booking?.bookingId,
        siteId: current?.siteId,
        siteName: current?.siteName,
        type,
        description: description.trim(),
        severity,
        injuries,
        policeInformed,
        lat: pos?.coords.latitude,
        lng: pos?.coords.longitude,
        occurredAt: new Date().toISOString(),
        media_count: attachments.length,
      });

      // An Emergency gets a thumbnail pushed ahead of everything else, so the operator has a
      // picture in seconds rather than after a 400 KB upload over 2G (PRD 18.10 §10).
      let thumbnailMediaId = '';
      const firstPhoto = attachments.find((a) => a.kind === 'incident_photo');
      if (severity === 'emergency' && firstPhoto) {
        try {
          const thumb = await ImageManipulator.manipulateAsync(firstPhoto.uri, [{ resize: { width: 320 } }], {
            compress: 0.4,
            format: ImageManipulator.SaveFormat.JPEG,
          });
          thumbnailMediaId =
            (await uploadNow({
              guardId: id,
              uri: thumb.uri,
              kind: 'incident_photo',
              clientEventUuid: event.client_event_uuid,
              rosterId: current?.rosterId,
            })) ?? '';
        } catch {
          /* the thumbnail is an optimisation, never a requirement */
        }
      }

      // The real attachments follow through the outbox.
      for (const att of attachments) {
        captureMedia({
          guardId: id,
          uri: att.uri,
          kind: att.kind,
          clientEventUuid: event.client_event_uuid,
          rosterId: current?.rosterId,
        }).catch(() => {});
      }

      const res = await api
        .incident({
          guardId: id,
          clientEventUuid: event.client_event_uuid,
          rosterId: current?.rosterId,
          bookingId: booking?.bookingId,
          siteId: current?.siteId,
          siteName: current?.siteName,
          type,
          description: description.trim(),
          severity,
          injuries,
          policeInformed,
          lat: pos?.coords.latitude,
          lng: pos?.coords.longitude,
          occurredAt: new Date().toISOString(),
          thumbnailMediaId,
          // A voice- or photo-only report is valid; its files follow through the media queue.
          mediaCount: attachments.length,
        })
        .catch(() => null);

      await store.del(KEYS.incidentDraft);
      successFeedback();
      setDone({
        id: res?.incidentId ?? event.client_event_uuid.slice(0, 8).toUpperCase(),
        escalated: !!res?.escalated || severity === 'emergency',
        queued: !res,
      });
      setTimeout(() => router.replace('/home'), 2600);
    } catch (e: any) {
      setError(e?.message ?? t('incident.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  // ----------------------------------------------------------------- views
  if (done) {
    return (
      <Screen scroll={false}>
        <View style={styles.successWrap}>
          <View style={[styles.successCircle, done.escalated && { backgroundColor: colors.danger }]}>
            <Ionicons name={done.escalated ? 'megaphone' : 'checkmark'} size={64} color="#fff" />
          </View>
          <H2>{t('incident.success')}</H2>
          <Text style={styles.successId}>{done.id}</Text>
          {done.escalated ? (
            <Muted style={{ textAlign: 'center', color: colors.danger }}>{t('incident.escalated')}</Muted>
          ) : null}
          {done.queued ? (
            <View style={styles.rowGap}>
              <Ionicons name="cloud-offline" size={16} color={colors.warning} />
              <Muted style={{ color: colors.warning }}>{t('incident.savedOffline')}</Muted>
            </View>
          ) : null}
        </View>
      </Screen>
    );
  }

  if (camMode) {
    return (
      <Screen scroll={false}>
        <View style={{ flex: 1 }}>
          <CameraView ref={cam} style={{ flex: 1 }} facing="back" mode={camMode === 'video' ? 'video' : 'picture'} />
          <View style={styles.camFoot}>
            {camMode === 'video' ? (
              recordingVideo ? (
                <>
                  <View style={styles.recRow}>
                    <View style={styles.recDot} />
                    <Text style={styles.recText}>
                      {fmt(videoSeconds)} / {fmt(MAX_VIDEO_SECONDS)}
                    </Text>
                  </View>
                  <Button label={t('incident.stopRecording')} variant="danger" size="huge" onPress={stopVideo} />
                </>
              ) : (
                <Button
                  label={t('incident.recordVideo')}
                  variant="danger"
                  size="huge"
                  icon={<Ionicons name="videocam" size={24} color="#fff" />}
                  onPress={startVideo}
                />
              )
            ) : (
              <Button
                label={t('incident.takePhoto')}
                size="huge"
                icon={<Ionicons name="camera" size={24} color={colors.onPrimary} />}
                onPress={takePhoto}
              />
            )}
            {!recordingVideo ? (
              <Button label={t('common.cancel')} variant="ghost" onPress={() => setCamMode(null)} />
            ) : null}
          </View>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={styles.head}>
        <Pressable onPress={() => goBack()} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <H2>{t('incident.title')}</H2>
        <View style={{ width: 24 }} />
      </View>

      {restored ? (
        <Card style={{ borderColor: colors.warning, backgroundColor: colors.warningDim }}>
          <View style={styles.rowGap}>
            <Ionicons name="document-text" size={20} color={colors.warning} />
            <Body style={{ flex: 1, color: colors.warning }}>{t('incident.draftRestored')}</Body>
          </View>
          <Button label={t('incident.startFresh')} variant="ghost" size="small" onPress={discardDraft} />
        </Card>
      ) : null}

      {/* 3×3 type grid */}
      <View style={{ gap: space.xs }}>
        <Text style={styles.fieldLabel}>{t('incident.type')}</Text>
        <View style={styles.typeGrid}>
          {TYPES.map((it) => {
            const active = type === it.key;
            return (
              <Pressable
                key={it.key}
                onPress={() => {
                  setType(it.key);
                  Haptics.selectionAsync().catch(() => {});
                }}
                style={[styles.tile, active && { borderColor: it.color, backgroundColor: 'rgba(255,255,255,0.08)' }]}
              >
                <Ionicons name={it.icon} size={28} color={active ? it.color : colors.textFaint} />
                <Text style={[styles.tileText, { color: active ? colors.text : colors.textMuted }]}>
                  {t(`incident.type_${it.key}`)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Capture: three big buttons (PRD 18.10 §5) */}
      <View style={{ gap: space.sm }}>
        <Text style={styles.fieldLabel}>{t('incident.addEvidence')}</Text>
        <View style={styles.captureRow}>
          <CaptureButton icon="camera" label={t('incident.photo')} onPress={() => openCamera('photo')} />
          <CaptureButton icon="videocam" label={t('incident.video')} onPress={() => openCamera('video')} />
          <CaptureButton
            icon={recordingVoice ? 'stop' : 'mic'}
            label={recordingVoice ? fmt(voiceSeconds) : t('incident.voice')}
            danger={recordingVoice}
            onPress={recordingVoice ? stopVoice : startVoice}
          />
        </View>

        {attachments.length > 0 ? (
          <View style={styles.attachRow}>
            {attachments.map((a, i) => (
              <Pressable key={`${a.uri}-${i}`} onPress={() => removeAttachment(i)} style={styles.attachChip}>
                <Ionicons
                  name={a.kind === 'voice' ? 'musical-notes' : a.kind === 'incident_video' ? 'videocam' : 'image'}
                  size={18}
                  color={colors.onDuty}
                />
                <Text style={styles.attachText}>
                  {a.kind === 'voice' ? fmt(a.seconds ?? 0) : a.kind === 'incident_video' ? t('incident.video') : t('incident.photo')}
                </Text>
                <Ionicons name="close-circle" size={16} color={colors.textFaint} />
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>

      {/* Severity */}
      <View style={{ gap: space.xs }}>
        <Text style={styles.fieldLabel}>{t('incident.severity')}</Text>
        <View style={styles.sevRow}>
          {SEVERITIES.map((s) => {
            const active = severity === s.key;
            return (
              <Pressable
                key={s.key}
                onPress={() => {
                  setSeverity(s.key);
                  Haptics.selectionAsync().catch(() => {});
                }}
                style={[styles.sev, active && { borderColor: s.color, backgroundColor: `${s.color}22` }]}
              >
                <Ionicons name={s.icon} size={24} color={active ? s.color : colors.textFaint} />
                <Text style={[styles.sevText, { color: active ? s.color : colors.textMuted }]}>
                  {t(`incident.sev_${s.key}`)}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {severity === 'emergency' ? (
          <View style={styles.rowGap}>
            <Ionicons name="megaphone" size={16} color={colors.danger} />
            <Muted style={{ flex: 1, color: colors.danger }}>{t('incident.emergencyNote')}</Muted>
          </View>
        ) : null}
      </View>

      {/* The two yes/no questions (PRD 18.10 §5) */}
      <YesNo label={t('incident.anyoneHurt')} value={injuries} onChange={setInjuries} />
      <YesNo label={t('incident.policeInformed')} value={policeInformed} onChange={setPoliceInformed} />

      {/* Free text is optional throughout */}
      <Field
        label={t('incident.describeOptional')}
        value={description}
        onChangeText={setDescription}
        placeholder={t('incident.describe')}
        multiline
        style={styles.multiline}
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Button
        label={t('incident.submit')}
        size="huge"
        variant={severity === 'emergency' ? 'danger' : 'primary'}
        onPress={submit}
        loading={busy}
        disabled={busy || !type}
        icon={<Ionicons name="send" size={22} color={severity === 'emergency' ? '#fff' : colors.onPrimary} />}
      />
      <Muted style={{ textAlign: 'center' }}>{t('incident.draftNote')}</Muted>
    </Screen>
  );
}

function CaptureButton({
  icon,
  label,
  onPress,
  danger,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  danger?: boolean;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.capture, danger && { borderColor: colors.danger, backgroundColor: colors.dangerDim }]}>
      <Ionicons name={icon} size={30} color={danger ? colors.danger : colors.primary} />
      <Text style={[styles.captureText, danger && { color: colors.danger }]}>{label}</Text>
    </Pressable>
  );
}

function YesNo({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | null;
  onChange: (v: boolean) => void;
}) {
  const t = useT();
  return (
    <View style={{ gap: space.xs }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.sevRow}>
        <Pressable
          onPress={() => onChange(true)}
          style={[styles.yesNo, value === true && { borderColor: colors.danger, backgroundColor: colors.dangerDim }]}
        >
          <Text style={[styles.yesNoText, value === true && { color: colors.danger }]}>{t('common.yes')}</Text>
        </Pressable>
        <Pressable
          onPress={() => onChange(false)}
          style={[styles.yesNo, value === false && { borderColor: colors.onDuty, backgroundColor: colors.onDutyDim }]}
        >
          <Text style={[styles.yesNoText, value === false && { color: colors.onDuty }]}>{t('common.no')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  fieldLabel: { color: colors.textFaint, fontSize: font.tiny, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  typeGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: space.sm },
  tile: {
    width: '31.5%',
    minHeight: 64,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.xs,
  },
  tileText: { fontSize: font.tiny, fontWeight: '700', textAlign: 'center' },
  captureRow: { flexDirection: 'row', gap: space.sm },
  capture: {
    flex: 1,
    minHeight: 68,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.card,
  },
  captureText: { color: colors.text, fontSize: font.label, fontWeight: '800' },
  attachRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  attachChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    backgroundColor: colors.onDutyDim,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    minHeight: 40,
  },
  attachText: { color: colors.onDuty, fontSize: font.label, fontWeight: '700' },
  sevRow: { flexDirection: 'row', gap: space.sm },
  sev: {
    flex: 1,
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  sevText: { fontSize: font.label, fontWeight: '800' },
  yesNo: {
    flex: 1,
    minHeight: touch.minTap,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  yesNoText: { color: colors.textMuted, fontSize: font.body, fontWeight: '800' },
  multiline: { minHeight: 100, textAlignVertical: 'top' },
  camFoot: { padding: space.lg, gap: space.sm },
  recRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm },
  recDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.danger },
  recText: { color: '#fff', fontSize: font.h3, fontWeight: '900' },
  rowGap: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  error: { color: colors.danger, fontWeight: '700' },
  successWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xl },
  successCircle: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: colors.onDuty,
    alignItems: 'center',
    justifyContent: 'center',
  },
  successId: { color: colors.primary, fontSize: font.h3, fontWeight: '900', letterSpacing: 1 },
});
