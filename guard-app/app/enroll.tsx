import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Button, Card, H1, Muted, Screen } from '@/components/ui';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { captureMedia } from '@/lib/media';
import { checkFace } from '@/lib/native';
import { guardId, useAuth } from '@/store/auth';
import { colors, radius, space } from '@/theme';

/** Selfie enrolment (PRD 18.1 §5). Live oval capture; stores the enrolment on the backend. */
export default function Enroll() {
  const t = useT();
  const router = useRouter();
  const guard = useAuth((s) => s.guard);
  const [perm, requestPerm] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [hint, setHint] = useState('');

  useEffect(() => {
    if (!perm?.granted) requestPerm();
  }, [perm?.granted]);

  const capture = async () => {
    setHint('');
    const shot = await cam.current?.takePictureAsync({ quality: 0.6, skipProcessing: true });
    if (!shot?.uri) return;
    const c = await ImageManipulator.manipulateAsync(shot.uri, [{ resize: { width: 640 } }], {
      compress: 0.7,
      format: ImageManipulator.SaveFormat.JPEG,
    });
    // Every future check-in is compared with this photo, so it has to be a clear, single,
    // front-on face (PRD 18.1 §5). Where no detector exists the server-side check still applies.
    setChecking(true);
    const { verdict } = await checkFace(c.uri);
    setChecking(false);
    if (verdict !== 'ok' && verdict !== 'unchecked') {
      setHint(t(`face.${verdict}`));
      return;
    }
    setUri(c.uri);
  };

  const submit = async () => {
    setBusy(true);
    try {
      if (uri) {
        const id = guardId(guard);
        // Upload the bytes first, then register the resulting mediaId as the enrolment. Storing
        // the device path instead would leave the enrolment on the phone, where nothing can ever
        // be compared against it (SUR-GAP-003).
        const mediaId = await captureMedia({
          guardId: id,
          uri,
          kind: 'selfie',
          clientEventUuid: `enrol:${id}`,
        });
        if (mediaId) await api.faceEnroll(id, mediaId, 'enrolment').catch(() => {});
      }
    } finally {
      setBusy(false);
      // Enrolment is not allowed to be a dead end: a guard who cannot upload still proceeds and
      // is prompted again later (PRD 18.1 §6 — documents and enrolment never block duty).
      router.replace('/agency-link');
    }
  };

  return (
    <Screen>
      <H1>{t('enroll.title')}</H1>
      <Muted>{t('enroll.subtitle')}</Muted>

      <Card style={{ padding: 0, overflow: 'hidden' }}>
        {uri ? (
          <View style={styles.done}>
            <Ionicons name="checkmark-circle" size={56} color={colors.onDuty} />
            <Muted>{t('enroll.captured')}</Muted>
            <Button label={t('common.retry')} variant="ghost" size="small" onPress={() => setUri(null)} />
          </View>
        ) : perm?.granted ? (
          <View>
            <View style={styles.ovalWrap}>
              <CameraView ref={cam} style={styles.camera} facing="front" />
              <View style={styles.oval} pointerEvents="none" />
            </View>
            <View style={{ padding: space.md }}>
              <Muted style={{ textAlign: 'center', marginBottom: space.sm }}>{t('enroll.look')}</Muted>
              {hint ? <Text style={styles.hint}>{hint}</Text> : null}
              <Button
                label={t('enroll.capture')}
                icon={<Ionicons name="camera" size={20} color={colors.onPrimary} />}
                onPress={capture}
                loading={checking}
                disabled={checking}
              />
            </View>
          </View>
        ) : (
          <View style={styles.done}>
            <ActivityIndicator color={colors.primary} />
          </View>
        )}
      </Card>

      <Button label={uri ? t('common.continue') : t('enroll.skip')} onPress={submit} loading={busy} variant={uri ? 'success' : 'ghost'} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  camera: { width: '100%', height: 380 },
  ovalWrap: { position: 'relative' },
  oval: {
    position: 'absolute', alignSelf: 'center', top: 40, width: 220, height: 300,
    borderRadius: 150, borderWidth: 3, borderColor: colors.primary, opacity: 0.9,
  },
  hint: { color: colors.warning, fontWeight: '800', textAlign: 'center', marginBottom: space.sm },
  done: { height: 240, alignItems: 'center', justifyContent: 'center', gap: space.sm, borderRadius: radius.lg },
});
