import { Ionicons } from '@expo/vector-icons';
import { AudioModule, RecordingPresets, useAudioRecorder } from 'expo-audio';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Body, Button, Card, Field, H2, Muted, Screen } from '@/components/ui';
import { FeatureOffNotice } from '@/components/UpdateNotice';
import { useT } from '@/i18n';
import { successFeedback } from '@/lib/feedback';
import { api, ApiError, type LeaveBalance, type LeaveRequest, type LeaveType } from '@/lib/api';
import { captureMedia } from '@/lib/media';
import { enqueue } from '@/lib/queue';
import { guardId, useAuth } from '@/store/auth';
import { useVersion } from '@/store/version';
import { colors, font, radius, space, touch } from '@/theme';

const TYPES: { key: LeaveType; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'casual', icon: 'sunny' },
  { key: 'sick', icon: 'medkit' },
  { key: 'emergency', icon: 'alert-circle' },
  { key: 'unpaid', icon: 'wallet' },
];

const STATUS_TONE: Record<LeaveRequest['status'], string> = {
  pending: colors.warning,
  approved: colors.onDuty,
  rejected: colors.danger,
  cancelled: colors.textFaint,
  completed: colors.textMuted,
};

const MS_DAY = 24 * 3600_000;

/** Today in IST as YYYY-MM-DD — leave dates are IST calendar days. */
function istToday(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

function addDays(key: string, n: number): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function prettyDate(key: string): string {
  return new Date(`${key}T00:00:00Z`).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/**
 * Leave request (PRD 18.12, SUR-GAP-021).
 *
 * Three taps and no typing: pick a type, pick when, send. Dates are chosen with quick chips and
 * steppers rather than typed — PRD 18.17.1 rule 8 lists the only things a guard should ever have
 * to type, and a date is not one of them.
 *
 * The request goes to the durable outbox first, so a guard in a dead zone can still ask; the
 * server applies the same validation to it when it lands, and a request that turns out to be
 * invalid comes back rejected with a reason rather than silently disappearing (18.15.4).
 */
export default function Leave() {
  const t = useT();
  const router = useRouter();
  const guard = useAuth((s) => s.guard);
  const leaveOff = useVersion((s) => s.isDisabled('leave'));
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  const [type, setType] = useState<LeaveType>('casual');
  const [from, setFrom] = useState(istToday());
  const [days, setDays] = useState(1);
  const [halfDay, setHalfDay] = useState(false);
  const [reason, setReason] = useState('');
  const [recording, setRecording] = useState(false);
  const [voiceUri, setVoiceUri] = useState<string | null>(null);

  const [balance, setBalance] = useState<LeaveBalance[]>([]);
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<null | { queued: boolean; days: number }>(null);

  const to = addDays(from, Math.max(0, days - 1));
  const today = istToday();
  const isPast = from < today;
  // Past dates are only open to sick and emergency leave, and then need a reason (PRD 18.12 §8).
  const pastAllowed = type === 'sick' || type === 'emergency';

  const load = useCallback(async () => {
    const id = guardId(guard);
    if (!id) return;
    try {
      const r = await api.getLeaves(id);
      setBalance(r.balance ?? []);
      setRequests(r.leaves ?? []);
    } catch {
      /* offline — keep what we have */
    }
  }, [guard]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleRecord = async () => {
    try {
      if (recording) {
        await recorder.stop();
        setVoiceUri(recorder.uri ?? null);
        setRecording(false);
        return;
      }
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) return;
      await recorder.prepareToRecordAsync();
      recorder.record();
      setRecording(true);
    } catch {
      setRecording(false);
    }
  };

  const setQuick = (startOffset: number, length: number) => {
    setFrom(addDays(today, startOffset));
    setDays(length);
    setHalfDay(false);
    Haptics.selectionAsync().catch(() => {});
  };

  const submit = async () => {
    if (recording) await toggleRecord();
    if (isPast && !pastAllowed) return setError(t('leave.pastNotAllowed'));
    if (isPast && !reason.trim() && !voiceUri) return setError(t('leave.pastNeedsReason'));

    setBusy(true);
    setError('');
    const id = guardId(guard);

    const payload = {
      leaveType: type,
      from,
      to,
      halfDay: days === 1 && halfDay,
      reason: reason.trim(),
      hasVoice: !!voiceUri,
    };
    // The voice note is uploaded against the request's uuid — the old screen sent a local file
    // path the server could never open.
    const attachVoice = (uuid: string) => {
      if (voiceUri) captureMedia({ guardId: id, uri: voiceUri, kind: 'voice', clientEventUuid: uuid }).catch(() => {});
    };

    try {
      // Online first, so a refusal (overlap, past date…) is shown now instead of arriving later
      // as a rejected row. Only a network failure falls back to the outbox.
      const uuid = Crypto.randomUUID();
      try {
        const res = await api.leave({ guardId: id, clientEventUuid: uuid, type, ...payload });
        attachVoice(uuid);
        successFeedback();
        setDone({ queued: false, days: res.days ?? days });
      } catch (e: any) {
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
          const known = e.code && t(`leave.err_${e.code}`);
          setError(known && !known.startsWith('leave.') ? known : e.message);
          return;
        }
        const event = await enqueue(id, 'leave', payload);
        attachVoice(event.client_event_uuid);
        setDone({ queued: true, days });
      }
      load();
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (r: LeaveRequest) => {
    try {
      await api.withdrawLeave(guardId(guard), r.clientEventUuid);
      // An "already have leave" error may no longer be true.
      setError('');
      load();
    } catch {
      /* the request may already have been decided; the list refresh will show it */
    }
  };

  if (leaveOff) {
    return (
      <Screen>
        <Header title={t('leave.title')} onBack={() => router.back()} />
        <FeatureOffNotice />
      </Screen>
    );
  }

  if (done) {
    return (
      <Screen>
        <Header title={t('leave.title')} onBack={() => router.back()} />
        <Card style={{ borderColor: colors.onDuty, backgroundColor: colors.onDutyDim, alignItems: 'center', gap: space.md }}>
          <Ionicons name="checkmark-circle" size={56} color={colors.onDuty} />
          <H2>{t('leave.success')}</H2>
          <Muted style={{ textAlign: 'center' }}>{done.queued ? t('leave.queued') : t('leave.waitingApproval')}</Muted>
        </Card>
        <Button label={t('common.ok')} size="huge" onPress={() => router.replace('/home')} />
      </Screen>
    );
  }

  const bal = balance.find((b) => b.type === type);

  return (
    <Screen>
      <Header title={t('leave.title')} onBack={() => router.back()} />

      {/* 1 — type */}
      <View style={styles.typeRow}>
        {TYPES.map((tp) => {
          const active = type === tp.key;
          return (
            <Pressable
              key={tp.key}
              onPress={() => {
                setType(tp.key);
                Haptics.selectionAsync().catch(() => {});
              }}
              style={[styles.type, active && styles.typeActive]}
            >
              <Ionicons name={tp.icon} size={26} color={active ? colors.onPrimary : colors.primary} />
              <Text style={[styles.typeText, active && { color: colors.onPrimary }]}>{t(`leave.type_${tp.key}`)}</Text>
            </Pressable>
          );
        })}
      </View>

      {/* Balance strip, in days */}
      {bal ? (
        <View style={styles.balance}>
          <Ionicons name="calendar-number" size={18} color={colors.primary} />
          <Text style={styles.balanceText}>
            {bal.left === null ? t('leave.noBalance') : t('leave.daysLeft', { left: bal.left, total: bal.entitled ?? 0 })}
          </Text>
        </View>
      ) : null}

      {/* 2 — when */}
      <View style={{ gap: space.sm }}>
        <Text style={styles.fieldLabel}>{t('leave.when')}</Text>
        <View style={styles.chips}>
          <Chip label={t('leave.today')} active={from === today && days === 1} onPress={() => setQuick(0, 1)} />
          <Chip label={t('leave.tomorrow')} active={from === addDays(today, 1) && days === 1} onPress={() => setQuick(1, 1)} />
          <Chip label={t('leave.threeDays')} active={from === today && days === 3} onPress={() => setQuick(0, 3)} />
        </View>

        <Card style={{ gap: space.md }}>
          <Stepper
            label={t('leave.from')}
            value={prettyDate(from)}
            onMinus={() => setFrom((f) => addDays(f, -1))}
            onPlus={() => setFrom((f) => addDays(f, 1))}
            // Only sick and emergency leave may start in the past, and never more than a week back.
            minusDisabled={!pastAllowed ? from <= today : Date.parse(from) - Date.parse(today) <= -7 * MS_DAY}
          />
          <Stepper
            label={t('leave.days')}
            value={days === 1 && halfDay ? t('leave.halfDay') : String(days)}
            onMinus={() => setDays((d) => Math.max(1, d - 1))}
            onPlus={() => {
              setDays((d) => Math.min(30, d + 1));
              setHalfDay(false);
            }}
            minusDisabled={days <= 1}
          />
          {days === 1 ? (
            <Pressable onPress={() => setHalfDay((h) => !h)} style={styles.halfDay}>
              <Ionicons name={halfDay ? 'checkbox' : 'square-outline'} size={22} color={colors.primary} />
              <Text style={styles.halfDayText}>{t('leave.halfDay')}</Text>
            </Pressable>
          ) : null}
          <Muted>
            {prettyDate(from)}
            {days > 1 ? ` → ${prettyDate(to)}` : ''}
          </Muted>
        </Card>

        {isPast ? (
          <Muted style={{ color: pastAllowed ? colors.warning : colors.danger }}>
            {pastAllowed ? t('leave.pastNeedsReason') : t('leave.pastNotAllowed')}
          </Muted>
        ) : null}
      </View>

      {/* Reason — voice first, text optional */}
      <Pressable onPress={toggleRecord} style={[styles.voiceBtn, recording && { borderColor: colors.danger }]}>
        <Ionicons
          name={recording ? 'stop-circle' : voiceUri ? 'checkmark-circle' : 'mic'}
          size={24}
          color={recording ? colors.danger : voiceUri ? colors.onDuty : colors.primary}
        />
        <Text style={styles.voiceText}>
          {recording ? t('leave.recording') : voiceUri ? t('leave.reasonAttached') : t('leave.recordReason')}
        </Text>
        {voiceUri && !recording ? <Text style={styles.reRecord}>{t('leave.reRecord')}</Text> : null}
      </Pressable>
      <Field
        label={t('leave.reasonOptional')}
        value={reason}
        onChangeText={setReason}
        placeholder={t('leave.reason')}
        multiline
        style={styles.multiline}
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {/* 3 — send */}
      <Button
        label={t('leave.submit')}
        size="huge"
        onPress={submit}
        loading={busy}
        disabled={busy || (isPast && !pastAllowed)}
        icon={<Ionicons name="send" size={22} color={colors.onPrimary} />}
      />

      {/* Existing requests */}
      {requests.length > 0 ? (
        <View style={{ gap: space.sm }}>
          <Muted>{t('leave.yourRequests')}</Muted>
          {requests.map((r) => (
            <Card key={r.clientEventUuid} style={{ gap: space.xs }}>
              <View style={styles.rowBetween}>
                <Body style={{ fontWeight: '800' }}>
                  {t(`leave.type_${r.type}`)} · {r.halfDay ? t('leave.halfDay') : `${r.days ?? '?'} ${t('leave.dayUnit')}`}
                </Body>
                <Text style={[styles.status, { color: STATUS_TONE[r.status] }]}>{t(`leave.status_${r.status}`)}</Text>
              </View>
              <Muted>
                {prettyDate(r.from)}
                {r.to !== r.from ? ` → ${prettyDate(r.to)}` : ''}
              </Muted>
              {r.decisionNote ? <Muted style={{ color: STATUS_TONE[r.status] }}>{r.decisionNote}</Muted> : null}
              {r.status === 'pending' ? (
                <Button label={t('leave.withdraw')} variant="ghost" size="small" onPress={() => withdraw(r)} />
              ) : null}
            </Card>
          ))}
        </View>
      ) : null}
    </Screen>
  );
}

function Header({ title, onBack }: { title: string; onBack: () => void }) {
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

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipText, active && { color: colors.onPrimary }]}>{label}</Text>
    </Pressable>
  );
}

/** Big −/+ buttons. A wheel picker is fiddly with gloves; two 56dp targets are not. */
function Stepper({
  label,
  value,
  onMinus,
  onPlus,
  minusDisabled,
}: {
  label: string;
  value: string;
  onMinus: () => void;
  onPlus: () => void;
  minusDisabled?: boolean;
}) {
  return (
    <View style={styles.stepper}>
      <Text style={styles.stepLabel}>{label}</Text>
      <Pressable onPress={onMinus} disabled={minusDisabled} style={[styles.stepBtn, minusDisabled && { opacity: 0.3 }]}>
        <Ionicons name="remove" size={26} color={colors.text} />
      </Pressable>
      <Text style={styles.stepValue}>{value}</Text>
      <Pressable onPress={onPlus} style={styles.stepBtn}>
        <Ionicons name="add" size={26} color={colors.text} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  fieldLabel: { color: colors.textFaint, fontSize: font.tiny, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  typeRow: { flexDirection: 'row', gap: space.sm },
  type: {
    flex: 1,
    minHeight: 64,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.card,
  },
  typeActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  typeText: { color: colors.text, fontSize: font.tiny, fontWeight: '800', textAlign: 'center' },
  balance: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: 'rgba(245,198,35,0.10)',
    borderRadius: radius.sm,
    padding: space.md,
  },
  balanceText: { color: colors.primary, fontSize: font.label, fontWeight: '800' },
  chips: { flexDirection: 'row', gap: space.sm },
  chip: {
    flex: 1,
    minHeight: touch.minTap,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.text, fontSize: font.label, fontWeight: '800' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  stepLabel: { color: colors.textMuted, fontSize: font.label, width: 56 },
  stepBtn: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepValue: { flex: 1, color: colors.text, fontSize: font.body, fontWeight: '900', textAlign: 'center' },
  halfDay: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: touch.minTap },
  halfDayText: { color: colors.text, fontSize: font.body, fontWeight: '700' },
  voiceBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: space.md,
    minHeight: 52,
  },
  voiceText: { color: colors.text, fontSize: font.body, fontWeight: '700', flex: 1 },
  reRecord: { color: colors.primary, fontSize: font.tiny, fontWeight: '700' },
  multiline: { minHeight: 80, textAlignVertical: 'top' },
  error: { color: colors.danger, fontWeight: '700' },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  status: { fontSize: font.tiny, fontWeight: '900', textTransform: 'uppercase' },
});
