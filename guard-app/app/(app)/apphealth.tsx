import { Ionicons } from '@expo/vector-icons';
import * as Battery from 'expo-battery';
import { useCameraPermissions } from 'expo-camera';
import Constants from 'expo-constants';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, Card, H2, Muted, Screen } from '@/components/ui';
import { useT } from '@/i18n';
import { pendingMediaBytes, pendingMediaCount } from '@/lib/media';
import { armedWakeCount, notificationPermissionGranted, notificationsAvailable } from '@/lib/notifications';
import { clearFailed, failedEvents, flush, lastSyncAt, pendingCount } from '@/lib/queue';
import { encryptionActive } from '@/lib/secureStore';
import { exactAlarmsAllowed, requestSosPermissions, sosPermissionState } from '@/lib/native';
import { guardId, useAuth } from '@/store/auth';
import { goBack } from '@/lib/navigation';
import { useDuty } from '@/store/duty';
import { colors, font, radius, space } from '@/theme';

type Tone = 'ok' | 'warn' | 'bad';
const TONE_COLOR: Record<Tone, string> = { ok: colors.onDuty, warn: colors.warning, bad: colors.danger };

type HealthRow = {
  key: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  tone: Tone;
  /** A row the guard can fix from here (e.g. grant a permission). */
  onPress?: () => void;
};

/**
 * App health (PRD 18.14 GAP-S-070, SUR-GAP-039).
 *
 * The one screen that answers "is this phone actually going to record my duty?" — permissions,
 * alarm reliability, how much is waiting to send, and when it last reached the server. It is
 * also where permanently-rejected records surface: PRD 18.15.3 is explicit that a record the
 * server refused is shown to the guard ("1 record could not be saved — tap to tell your
 * supervisor") rather than dropped silently.
 */
export default function AppHealth() {
  const t = useT();
  const router = useRouter();
  const guard = useAuth((s) => s.guard);
  const offline = useDuty((s) => s.offline);
  const refreshQueued = useDuty((s) => s.refreshQueued);

  const [, requestCam] = useCameraPermissions();
  const [rows, setRows] = useState<HealthRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [failed, setFailed] = useState(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    const next: HealthRow[] = [];

    const push = (row: HealthRow) => next.push(row);
    const unknown = (key: string, icon: HealthRow['icon'], label: string): HealthRow => ({
      key,
      icon,
      label,
      value: t('apphealth.unknown'),
      tone: 'warn',
    });

    // --- Permissions ---
    try {
      const loc = await Location.getForegroundPermissionsAsync();
      push({
        key: 'location',
        icon: 'location',
        label: t('apphealth.location'),
        value: loc.granted ? t('apphealth.granted') : t('apphealth.denied'),
        // Location is the one permission duty genuinely depends on.
        tone: loc.granted ? 'ok' : 'bad',
      });
    } catch {
      push(unknown('location', 'location', t('apphealth.location')));
    }

    try {
      const cam = await requestCam();
      push({
        key: 'camera',
        icon: 'camera',
        label: t('apphealth.camera'),
        value: cam.granted ? t('apphealth.granted') : t('apphealth.denied'),
        tone: cam.granted ? 'ok' : 'warn',
      });
    } catch {
      push(unknown('camera', 'camera', t('apphealth.camera')));
    }

    // Without notifications the wake checks cannot fire at all — and on a build where the
    // module itself is unavailable (Expo Go on Android) we say so rather than blaming the
    // guard's permissions.
    if (!notificationsAvailable) {
      push({
        key: 'notifications',
        icon: 'notifications-off',
        label: t('apphealth.notifications'),
        value: t('apphealth.unsupported'),
        tone: 'bad',
      });
    } else {
      const granted = await notificationPermissionGranted();
      push({
        key: 'notifications',
        icon: 'notifications',
        label: t('apphealth.notifications'),
        value:
          granted === null ? t('apphealth.unknown') : granted ? t('apphealth.granted') : t('apphealth.denied'),
        tone: granted === null ? 'warn' : granted ? 'ok' : 'bad',
      });
    }

    // Exact alarms (PRD 18.8 §16): without them Android may deliver a wake check late.
    const exact = exactAlarmsAllowed();
    if (exact !== null) {
      push({
        key: 'exact',
        icon: 'alarm',
        label: t('apphealth.exactAlarms'),
        value: exact ? t('apphealth.exactOn') : t('apphealth.exactOff'),
        tone: exact ? 'ok' : 'bad',
        onPress: exact ? undefined : () => Linking.openSettings().catch(() => {}),
      });
    }

    // SOS SMS and call without a tap (PRD 18.9 §16: tell the guard when their SOS is weaker than
    // it could be). Tapping the row asks for the two permissions.
    const sos = sosPermissionState();
    const automatic = sos.sms && sos.call;
    push({
      key: 'sos',
      icon: 'alert-circle',
      label: t('apphealth.sosAuto'),
      value: !sos.available ? t('apphealth.sosOneTapBuild') : automatic ? t('apphealth.sosAutomatic') : t('apphealth.sosOneTap'),
      tone: automatic ? 'ok' : 'warn',
      onPress:
        sos.available && !automatic
          ? async () => {
              await requestSosPermissions();
              refreshRef.current();
            }
          : undefined,
    });

    // --- Wake-check alarm reliability (PRD 18.8 §16) ---
    try {
      const armed = await armedWakeCount();
      push({
        key: 'alarms',
        icon: 'alarm',
        label: t('apphealth.alarms'),
        value: armed > 0 ? `${armed} ${t('apphealth.armed')}` : t('apphealth.noneArmed'),
        tone: armed > 0 ? 'ok' : 'warn',
      });
    } catch {
      push(unknown('alarms', 'alarm', t('apphealth.alarms')));
    }

    // --- Outbox ---
    try {
      const depth = await pendingCount();
      push({
        key: 'queue',
        icon: 'cloud-upload',
        label: t('apphealth.queue'),
        value: depth === 0 ? t('apphealth.empty') : `${depth} ${t('apphealth.items')}`,
        // Backpressure thresholds from PRD 18.15.3.
        tone: depth === 0 ? 'ok' : depth > 500 ? 'bad' : 'warn',
      });
    } catch {
      push(unknown('queue', 'cloud-upload', t('apphealth.queue')));
    }

    try {
      const [mediaDepth, mediaBytes] = await Promise.all([pendingMediaCount(), pendingMediaBytes()]);
      const mb = mediaBytes / (1024 * 1024);
      push({
        key: 'media',
        icon: 'images',
        label: t('apphealth.media'),
        value:
          mediaDepth === 0
            ? t('apphealth.empty')
            : `${mediaDepth} ${t('apphealth.items')} · ${mb.toFixed(1)} MB`,
        tone: mediaDepth === 0 ? 'ok' : mb > 300 ? 'bad' : 'warn',
      });
    } catch {
      push(unknown('media', 'images', t('apphealth.media')));
    }

    try {
      const at = await lastSyncAt();
      push({
        key: 'sync',
        icon: offline ? 'cloud-offline' : 'cloud-done',
        label: t('apphealth.sync'),
        value: at
          ? `${new Date(at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`
          : t('apphealth.never'),
        tone: offline ? 'warn' : at ? 'ok' : 'warn',
      });
    } catch {
      push(unknown('sync', 'cloud-done', t('apphealth.sync')));
    }

    try {
      const level = await Battery.getBatteryLevelAsync();
      const pct = level >= 0 ? Math.round(level * 100) : -1;
      push({
        key: 'battery',
        icon: 'battery-half',
        label: t('apphealth.battery'),
        value: pct >= 0 ? `${pct}%` : t('apphealth.unknown'),
        // 15% is where the app enters degraded mode (PRD 18.15.7).
        tone: pct < 0 ? 'warn' : pct <= 15 ? 'bad' : pct <= 30 ? 'warn' : 'ok',
      });
    } catch {
      push(unknown('battery', 'battery-half', t('apphealth.battery')));
    }

    // Encryption at rest (PRD 18.15.1). Reported rather than assumed: a device with a broken
    // keystore falls back to plaintext, and the guard should be able to see that it did.
    try {
      const encrypted = await encryptionActive();
      push({
        key: 'encryption',
        icon: encrypted ? 'lock-closed' : 'lock-open',
        label: t('apphealth.encryption'),
        value: encrypted ? t('apphealth.encrypted') : t('apphealth.notEncrypted'),
        tone: encrypted ? 'ok' : 'warn',
      });
    } catch {
      push(unknown('encryption', 'lock-closed', t('apphealth.encryption')));
    }

    push({
      key: 'version',
      icon: 'information-circle',
      label: t('apphealth.version'),
      value: Constants.expoConfig?.version ?? t('apphealth.unknown'),
      tone: 'ok',
    });

    setFailed((await failedEvents()).length);
    setRows(next);
    setLoading(false);
  }, [offline, requestCam, t]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    refresh();
  }, [refresh]);

  const syncNow = async () => {
    const id = guardId(guard);
    if (!id) return;
    setSyncing(true);
    try {
      await flush(id);
      await refreshQueued();
    } finally {
      setSyncing(false);
      refresh();
    }
  };

  const reportFailed = () => {
    Alert.alert(t('apphealth.failedTitle'), t('apphealth.failedBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('apphealth.callSupervisor'),
        onPress: () => router.push('/help'),
      },
      {
        text: t('apphealth.dismissFailed'),
        style: 'destructive',
        onPress: async () => {
          await clearFailed();
          await refreshQueued();
          refresh();
        },
      },
    ]);
  };

  return (
    <Screen>
      <View style={styles.head}>
        <Pressable onPress={() => goBack()} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <H2>{t('apphealth.title')}</H2>
        <View style={{ width: 24 }} />
      </View>

      <Muted>{t('apphealth.note')}</Muted>

      {failed > 0 ? (
        <Pressable onPress={reportFailed}>
          <Card style={{ borderColor: colors.danger, backgroundColor: colors.dangerDim }}>
            <View style={styles.rowGap}>
              <Ionicons name="warning" size={22} color={colors.danger} />
              <Text style={[styles.value, { color: colors.danger, flex: 1 }]}>
                {failed} {t('duty.recordsNotSaved')}
              </Text>
              <Ionicons name="chevron-forward" size={18} color={colors.danger} />
            </View>
          </Card>
        </Pressable>
      ) : null}

      {loading && rows.length === 0 ? (
        <Card style={styles.center}>
          <Muted>{t('apphealth.checking')}</Muted>
        </Card>
      ) : (
        rows.map((r) => (
          <Pressable key={r.key} onPress={r.onPress} disabled={!r.onPress}>
            <Card style={styles.rowCard}>
              <View style={styles.iconWrap}>
                <Ionicons name={r.icon} size={22} color={TONE_COLOR[r.tone]} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>{r.label}</Text>
                <Text style={[styles.value, { color: TONE_COLOR[r.tone] }]}>{r.value}</Text>
              </View>
              {r.onPress ? (
                <Ionicons name="chevron-forward" size={18} color={TONE_COLOR[r.tone]} />
              ) : (
                <View style={[styles.dot, { backgroundColor: TONE_COLOR[r.tone] }]} />
              )}
            </Card>
          </Pressable>
        ))
      )}

      <Button
        label={t('apphealth.syncNow')}
        onPress={syncNow}
        loading={syncing}
        icon={<Ionicons name="cloud-upload" size={20} color={colors.onPrimary} />}
      />
      <Button
        label={t('apphealth.refresh')}
        variant="ghost"
        onPress={refresh}
        loading={loading}
        icon={<Ionicons name="refresh" size={20} color={colors.text} />}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  center: { alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingVertical: space.xl },
  rowCard: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  rowGap: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { color: colors.textMuted, fontSize: font.label, fontWeight: '700' },
  value: { fontSize: font.body, fontWeight: '800', marginTop: 2 },
  dot: { width: 12, height: 12, borderRadius: 6 },
});
