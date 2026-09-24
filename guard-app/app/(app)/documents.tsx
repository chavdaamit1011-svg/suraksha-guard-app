import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import * as ImageManipulator from 'expo-image-manipulator';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Body, Button, Card, Field, H2, Muted, Screen } from '@/components/ui';
import { useT } from '@/i18n';
import { successFeedback } from '@/lib/feedback';
import { api, type DocKind, type GuardDocument } from '@/lib/api';
import { photoQuality } from '@/lib/blur';
import { captureMedia } from '@/lib/media';
import { enqueue } from '@/lib/queue';
import { goBack } from '@/lib/navigation';
import { guardId, useAuth } from '@/store/auth';
import { colors, font, radius, space } from '@/theme';

const KINDS: { kind: DocKind; labelKey: string; expires: boolean }[] = [
  { kind: 'aadhaar', labelKey: 'documents.docAadhaar', expires: false },
  { kind: 'pan', labelKey: 'documents.docPan', expires: false },
  { kind: 'bank', labelKey: 'documents.docBank', expires: false },
  { kind: 'psara', labelKey: 'documents.docPsara', expires: true },
  { kind: 'police', labelKey: 'documents.docPolice', expires: true },
];

const STATUS_TONE: Record<string, { color: string; icon: keyof typeof Ionicons.glyphMap }> = {
  Verified: { color: colors.onDuty, icon: 'checkmark-circle' },
  Pending: { color: colors.warning, icon: 'time' },
  Expiring: { color: colors.warning, icon: 'alert-circle' },
  Expired: { color: colors.danger, icon: 'close-circle' },
  Rejected: { color: colors.danger, icon: 'close-circle' },
  Missing: { color: colors.textFaint, icon: 'add-circle' },
};

const CACHE: Record<string, GuardDocument> = {};

type Stage =
  | { name: 'list' }
  | { name: 'camera'; kind: DocKind }
  | { name: 'checking'; kind: DocKind }
  | { name: 'blurry'; kind: DocKind; uri: string; dark: boolean }
  | { name: 'confirm'; kind: DocKind; uri: string; blurry: boolean };

/**
 * Documents (PRD 18.11, SUR-GAP-004 / 020).
 *
 * Camera → blur check → confirm → send. A blurry photo is caught on the phone, where retaking
 * costs two seconds, instead of by a reviewer three days later. The scan itself is uploaded (the
 * old screen sent a file path the server could never open), and the record is queued when there
 * is no network so nothing is lost in a basement.
 *
 * Number and expiry are optional and, when the server has OCR configured, pre-filled from the
 * scan. Aadhaar is only ever kept masked.
 */
export default function Documents() {
  const t = useT();
  const router = useRouter();
  const guard = useAuth((s) => s.guard);
  const id = guardId(guard);

  const [docs, setDocs] = useState<Record<string, GuardDocument>>(CACHE);
  const [stage, setStage] = useState<Stage>({ name: 'list' });
  const [perm, requestPerm] = useCameraPermissions();
  const cam = useRef<CameraView>(null);

  const [number, setNumber] = useState('');
  const [exp, setExp] = useState({ dd: '', mm: '', yyyy: '' });
  const [ocrBusy, setOcrBusy] = useState(false);
  const [mediaId, setMediaId] = useState<string | null>(null);
  const [uuid, setUuid] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<null | { queued: boolean }>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api.getDocuments(id);
      const map: Record<string, GuardDocument> = {};
      (r.documents ?? []).forEach((d) => (map[d.kind] = d));
      Object.assign(CACHE, map);
      setDocs(map);
    } catch {
      /* offline: keep the cached view */
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const startCapture = async (kind: DocKind) => {
    if (!perm?.granted) {
      const res = await requestPerm();
      if (!res.granted) return;
    }
    setDone(null);
    setError('');
    setStage({ name: 'camera', kind });
  };

  const take = async (kind: DocKind) => {
    const shot = await cam.current?.takePictureAsync({ quality: 0.8, skipProcessing: true });
    if (!shot?.uri) return;
    setStage({ name: 'checking', kind });
    const c = await ImageManipulator.manipulateAsync(shot.uri, [{ resize: { width: 1600 } }], {
      compress: 0.7,
      format: ImageManipulator.SaveFormat.JPEG,
    });
    const q = await photoQuality(c.uri);
    api.track('doc_photo_quality', { kind, ...q });
    if (q.verdict === 'blurry' || q.verdict === 'dark') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      setStage({ name: 'blurry', kind, uri: c.uri, dark: q.verdict === 'dark' });
    } else {
      goConfirm(kind, c.uri, false);
    }
  };

  /** Start the upload straight away so OCR can pre-fill while the guard reads the preview. */
  const goConfirm = (kind: DocKind, uri: string, blurry: boolean) => {
    const u = Crypto.randomUUID();
    setUuid(u);
    setNumber('');
    setExp({ dd: '', mm: '', yyyy: '' });
    setMediaId(null);
    setStage({ name: 'confirm', kind, uri, blurry });

    captureMedia({ guardId: id, uri, kind: 'document', clientEventUuid: u })
      .then(async (mId) => {
        setMediaId(mId);
        if (!mId) return;
        setOcrBusy(true);
        try {
          const r = await api.documentOcr(id, kind, mId);
          if (r.available) {
            if (r.suggestion.number) setNumber((cur) => cur || r.suggestion.number!);
            if (r.suggestion.expiresOn) {
              const [yyyy, mm, dd] = r.suggestion.expiresOn.split('-');
              setExp((cur) => (cur.yyyy ? cur : { dd, mm, yyyy }));
            }
          }
        } catch {
          /* OCR is optional */
        } finally {
          setOcrBusy(false);
        }
      })
      .catch(() => setMediaId(null));
  };

  const submit = async (kind: DocKind, blurry: boolean) => {
    const needsExpiry = KINDS.find((k) => k.kind === kind)?.expires;
    let expiresOn: string | undefined;
    if (exp.yyyy || exp.mm || exp.dd) {
      if (exp.yyyy.length !== 4 || !exp.mm || !exp.dd) return setError(t('documents.errExpiry'));
      expiresOn = `${exp.yyyy}-${exp.mm.padStart(2, '0')}-${exp.dd.padStart(2, '0')}`;
      if (Number.isNaN(Date.parse(`${expiresOn}T00:00:00Z`))) return setError(t('documents.errExpiry'));
    } else if (needsExpiry) {
      return setError(t('documents.errExpiryRequired'));
    }

    setBusy(true);
    setError('');
    const payload = {
      guardId: id,
      kind,
      clientEventUuid: uuid,
      mediaId: mediaId ?? undefined,
      number: number.trim() || undefined,
      expiresOn,
      blurSuspected: blurry,
    };
    try {
      await api.uploadDocument(payload);
      setDone({ queued: false });
    } catch {
      // Offline: the record rides the outbox; the scan is already in the media queue.
      // `mediaUuid` is what the scan was uploaded under, so the server can link the two.
      await enqueue(id, 'document', { kind, mediaUuid: uuid, number: payload.number, expiresOn, blurSuspected: blurry });
      setDone({ queued: true });
    } finally {
      setBusy(false);
    }
    successFeedback();
    setDocs((prev) => ({
      ...prev,
      [kind]: {
        kind,
        status: 'Pending',
        number: payload.number ?? prev[kind]?.number ?? '',
        expiresOn: expiresOn ?? null,
        uploadedAt: new Date().toISOString(),
        hasImage: !!mediaId,
        awaitingUpload: !mediaId,
        reviewNote: '',
      },
    }));
    setStage({ name: 'list' });
    load();
  };

  // ------------------------------------------------------------------ camera
  if (stage.name === 'camera') {
    return (
      <Screen scroll={false}>
        <View style={{ flex: 1 }}>
          <CameraView ref={cam} style={{ flex: 1 }} facing="back" />
          <View style={{ padding: space.lg, gap: space.sm }}>
            <Muted style={{ textAlign: 'center' }}>{t('documents.frameDoc')}</Muted>
            <Button
              label={t('documents.capture')}
              icon={<Ionicons name="camera" size={20} color={colors.onPrimary} />}
              onPress={() => take(stage.kind)}
            />
            <Button label={t('common.cancel')} variant="ghost" size="small" onPress={() => setStage({ name: 'list' })} />
          </View>
        </View>
      </Screen>
    );
  }

  if (stage.name === 'checking') {
    return (
      <Screen>
        <Card style={styles.center}>
          <ActivityIndicator color={colors.primary} />
          <Muted>{t('documents.checking')}</Muted>
        </Card>
      </Screen>
    );
  }

  if (stage.name === 'blurry') {
    return (
      <Screen>
        <H2>{stage.dark ? t('documents.darkTitle') : t('documents.blurryTitle')}</H2>
        <Image source={{ uri: stage.uri }} style={styles.preview} resizeMode="contain" />
        <Card style={{ borderColor: colors.warning, backgroundColor: colors.warningDim }}>
          <Body style={{ color: colors.warning }}>{stage.dark ? t('documents.darkBody') : t('documents.blurryBody')}</Body>
        </Card>
        <Button
          label={t('documents.retake')}
          size="huge"
          icon={<Ionicons name="camera" size={22} color={colors.onPrimary} />}
          onPress={() => startCapture(stage.kind)}
        />
        <Button label={t('documents.useAnyway')} variant="ghost" size="small" onPress={() => goConfirm(stage.kind, stage.uri, true)} />
      </Screen>
    );
  }

  if (stage.name === 'confirm') {
    const def = KINDS.find((k) => k.kind === stage.kind)!;
    return (
      <Screen>
        <View style={styles.head}>
          <Pressable onPress={() => setStage({ name: 'list' })} hitSlop={12}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </Pressable>
          <H2>{t(def.labelKey)}</H2>
          <View style={{ width: 24 }} />
        </View>
        <Image source={{ uri: stage.uri }} style={styles.preview} resizeMode="contain" />
        <Button label={t('documents.retake')} variant="ghost" size="small" onPress={() => startCapture(stage.kind)} />

        {ocrBusy ? (
          <View style={styles.rowGap}>
            <ActivityIndicator color={colors.primary} size="small" />
            <Muted>{t('documents.reading')}</Muted>
          </View>
        ) : null}

        <Field
          label={stage.kind === 'aadhaar' ? t('documents.numberAadhaar') : t('documents.numberOptional')}
          value={number}
          onChangeText={setNumber}
          autoCapitalize="characters"
        />
        {def.expires ? (
          <View style={{ gap: space.xs }}>
            <Muted>{t('documents.expiry')}</Muted>
            <View style={styles.dateRow}>
              <Field placeholder="DD" value={exp.dd} onChangeText={(v) => setExp((e) => ({ ...e, dd: v }))} keyboardType="number-pad" maxLength={2} style={styles.dateField} />
              <Field placeholder="MM" value={exp.mm} onChangeText={(v) => setExp((e) => ({ ...e, mm: v }))} keyboardType="number-pad" maxLength={2} style={styles.dateField} />
              <Field placeholder="YYYY" value={exp.yyyy} onChangeText={(v) => setExp((e) => ({ ...e, yyyy: v }))} keyboardType="number-pad" maxLength={4} style={styles.yearField} />
            </View>
          </View>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Button
          label={t('documents.submit')}
          size="huge"
          loading={busy}
          disabled={busy}
          icon={<Ionicons name="send" size={20} color={colors.onPrimary} />}
          onPress={() => submit(stage.kind, stage.blurry)}
        />
      </Screen>
    );
  }

  // ------------------------------------------------------------------ list
  return (
    <Screen>
      <View style={styles.head}>
        <Pressable onPress={() => goBack()} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <H2>{t('documents.title')}</H2>
        <View style={{ width: 24 }} />
      </View>

      {done ? (
        <Card style={{ borderColor: colors.onDuty, backgroundColor: colors.onDutyDim }}>
          <Body style={{ color: colors.onDuty }}>{done.queued ? t('documents.queued') : t('documents.sent')}</Body>
        </Card>
      ) : null}

      {KINDS.map(({ kind, labelKey, expires }) => {
        const d = docs[kind];
        const status = d ? d.status : 'Missing';
        const tone = STATUS_TONE[status] ?? STATUS_TONE.Pending;
        const attention = status === 'Missing' || status === 'Expired' || status === 'Rejected' || status === 'Expiring';
        return (
          <Card key={kind} style={attention && status !== 'Missing' ? { borderColor: tone.color } : undefined}>
            <View style={styles.row}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.label}>{t(labelKey)}</Text>
                <View style={styles.pillRow}>
                  <Ionicons name={tone.icon} size={14} color={tone.color} />
                  <Text style={[styles.pill, { color: tone.color }]}>{t(`documents.status_${status}`)}</Text>
                </View>
                {d?.number ? <Muted>{d.number}</Muted> : null}
                {expires && d?.expiresOn ? (
                  <Muted>{t('documents.validTill', { date: new Date(d.expiresOn).toLocaleDateString('en-IN') })}</Muted>
                ) : null}
                {d?.awaitingUpload ? <Muted style={{ color: colors.warning }}>{t('documents.photoUploading')}</Muted> : null}
                {d?.reviewNote ? <Muted style={{ color: colors.danger }}>{d.reviewNote}</Muted> : null}
              </View>
              <Pressable onPress={() => startCapture(kind)} style={[styles.upload, attention && styles.uploadAttention]}>
                <Ionicons name={d ? 'refresh' : 'camera'} size={18} color={attention ? colors.onPrimary : colors.primary} />
                <Text style={[styles.uploadText, attention && { color: colors.onPrimary }]}>
                  {d ? t('documents.update') : t('documents.upload')}
                </Text>
              </Pressable>
            </View>
          </Card>
        );
      })}
      <Muted style={{ textAlign: 'center' }}>{t('documents.pendingNote')}</Muted>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  center: { alignItems: 'center', gap: space.md, paddingVertical: space.xl },
  rowGap: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  label: { color: colors.text, fontSize: font.body, fontWeight: '700' },
  pillRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  pill: { fontSize: font.tiny, fontWeight: '800', textTransform: 'uppercase' },
  upload: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    minHeight: 48,
  },
  uploadAttention: { backgroundColor: colors.primary, borderColor: colors.primary },
  uploadText: { color: colors.primary, fontWeight: '800', fontSize: font.label },
  preview: { width: '100%', height: 240, borderRadius: radius.md, backgroundColor: '#000' },
  dateRow: { flexDirection: 'row', gap: space.sm },
  dateField: { width: 72, textAlign: 'center' },
  yearField: { width: 110, textAlign: 'center' },
  error: { color: colors.danger, fontWeight: '700' },
});
