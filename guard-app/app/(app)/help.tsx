import { Ionicons } from '@expo/vector-icons';
import { AudioModule, RecordingPresets, useAudioRecorder } from 'expo-audio';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Body, Button, Card, Field, H2, Muted, Screen } from '@/components/ui';
import { useT } from '@/i18n';
import { successFeedback } from '@/lib/feedback';
import { api, ApiError, type EscalationContact, type SupportTicket, type TicketCategory } from '@/lib/api';
import { captureMedia } from '@/lib/media';
import { guardId, useAuth } from '@/store/auth';
import { useDuty } from '@/store/duty';
import { useVersion } from '@/store/version';
import { colors, font, radius, space, touch } from '@/theme';

const CATEGORIES: { key: TicketCategory; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'pay', icon: 'cash' },
  { key: 'attendance', icon: 'finger-print' },
  { key: 'leave', icon: 'calendar' },
  { key: 'uniform', icon: 'shirt' },
  { key: 'app', icon: 'phone-portrait' },
  { key: 'safety', icon: 'shield' },
  { key: 'other', icon: 'ellipsis-horizontal' },
];

const ROLE_ICON: Record<string, keyof typeof Ionicons.glyphMap> = {
  supervisor: 'person',
  control_room: 'headset',
  site: 'business',
};

/**
 * Help & support (PRD 18.14, SUR-GAP-027).
 *
 * One-tap calls to the people who can actually help tonight — the site's own escalation
 * contacts from the duty bundle, then the agency helpline — and a voice-note ticket for
 * everything else. No number here is compiled in: a missing number hides its row rather than
 * dialling a placeholder.
 *
 * Opened from a payslip, the screen arrives with the Pay category and the month pre-selected.
 */
export default function Help() {
  const t = useT();
  const router = useRouter();
  const params = useLocalSearchParams<{ category?: string; period?: string }>();
  const guard = useAuth((s) => s.guard);
  const contacts = useDuty((s) => s.current?.site.escalationContacts ?? []);
  const helpline = useVersion((s) => s.helpline);
  const commandCenter = useVersion((s) => s.commandCenter);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  const initialCategory = CATEGORIES.some((c) => c.key === params.category) ? (params.category as TicketCategory) : null;
  const period = typeof params.period === 'string' ? params.period : '';

  const [category, setCategory] = useState<TicketCategory | null>(initialCategory);
  const [message, setMessage] = useState('');
  const [recording, setRecording] = useState(false);
  const [voiceUri, setVoiceUri] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sentId, setSentId] = useState('');
  const [tickets, setTickets] = useState<SupportTicket[]>([]);

  const id = guardId(guard);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api.myTickets(id);
      setTickets(r.tickets ?? []);
    } catch {
      /* offline */
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const call = (phone: string) => Linking.openURL(`tel:${phone}`).catch(() => {});

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

  const send = async () => {
    if (!category || !id) return;
    if (recording) await toggleRecord();
    setBusy(true);
    setError('');
    const uuid = Crypto.randomUUID();
    try {
      const mediaIds: string[] = [];
      if (voiceUri) {
        // A ticket is only useful if staff can hear it, so the voice note must upload first.
        const mediaId = await captureMedia({ guardId: id, uri: voiceUri, kind: 'voice', clientEventUuid: uuid });
        if (!mediaId) {
          setError(t('help.errUpload'));
          return;
        }
        mediaIds.push(mediaId);
      }
      const r = await api.createTicket({
        guardId: id,
        clientEventUuid: uuid,
        category,
        message: message.trim() || undefined,
        mediaIds,
        period: category === 'pay' ? period || undefined : undefined,
      });
      successFeedback();
      setSentId(r.ticketId ?? '');
      setVoiceUri(null);
      setMessage('');
      setCategory(null);
      load();
    } catch (e: any) {
      setError(e instanceof ApiError && e.status < 500 ? e.message : t('help.errNetwork'));
    } finally {
      setBusy(false);
    }
  };

  const callRows: { key: string; label: string; phone: string; icon: keyof typeof Ionicons.glyphMap; tone: string }[] = [
    ...contacts
      .filter((c: EscalationContact) => !!c.phone)
      .map((c: EscalationContact, i: number) => ({
        key: `c${i}`,
        label: `${c.name}${c.role ? ` · ${t(`help.role_${c.role}`)}` : ''}`,
        phone: c.phone,
        icon: ROLE_ICON[c.role] ?? 'call',
        tone: colors.onDuty,
      })),
    ...(commandCenter ? [{ key: 'cc', label: t('help.callCommand'), phone: commandCenter, icon: 'headset' as const, tone: colors.primary }] : []),
    ...(helpline ? [{ key: 'hl', label: t('help.callHelpline'), phone: helpline, icon: 'call' as const, tone: colors.primary }] : []),
  ];

  return (
    <Screen>
      <View style={styles.head}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <H2>{t('help.title')}</H2>
        <View style={{ width: 24 }} />
      </View>

      {callRows.length === 0 ? (
        <Card>
          <Muted>{t('help.noContacts')}</Muted>
        </Card>
      ) : (
        callRows.map((c) => (
          <Pressable key={c.key} onPress={() => call(c.phone)}>
            <Card style={styles.callRow}>
              <Ionicons name={c.icon} size={24} color={c.tone} />
              <View style={{ flex: 1 }}>
                <Text style={styles.rowText}>{c.label}</Text>
                <Muted>{c.phone}</Muted>
              </View>
              <Ionicons name="call" size={22} color={c.tone} />
            </Card>
          </Pressable>
        ))
      )}

      {/* Ticket */}
      <Card style={{ gap: space.md }}>
        <View style={styles.rowGap}>
          <Ionicons name="chatbox-ellipses" size={24} color={colors.primary} />
          <H2>{t('help.voiceTicket')}</H2>
        </View>

        {sentId ? (
          <View style={styles.sent}>
            <Ionicons name="checkmark-circle" size={20} color={colors.onDuty} />
            <Text style={styles.sentText}>{t('help.ticketSent', { id: sentId })}</Text>
          </View>
        ) : null}

        <Muted>{t('help.pickCategory')}</Muted>
        <View style={styles.grid}>
          {CATEGORIES.map((c) => {
            const active = category === c.key;
            return (
              <Pressable
                key={c.key}
                onPress={() => {
                  setCategory(c.key);
                  setSentId('');
                }}
                style={[styles.cat, active && styles.catActive]}
              >
                <Ionicons name={c.icon} size={22} color={active ? colors.onPrimary : c.key === 'safety' ? colors.danger : colors.primary} />
                <Text style={[styles.catText, active && { color: colors.onPrimary }]}>{t(`help.cat_${c.key}`)}</Text>
              </Pressable>
            );
          })}
        </View>

        {category ? (
          <>
            {category === 'pay' && period ? <Muted>{t('help.aboutPeriod', { period })}</Muted> : null}
            <Pressable onPress={toggleRecord} style={[styles.voiceBtn, recording && { borderColor: colors.danger }]}>
              <Ionicons
                name={recording ? 'stop-circle' : voiceUri ? 'checkmark-circle' : 'mic'}
                size={26}
                color={recording ? colors.danger : voiceUri ? colors.onDuty : colors.primary}
              />
              <Text style={styles.voiceText}>
                {recording ? t('help.recording') : voiceUri ? t('help.reRecord') : t('help.recordTicket')}
              </Text>
            </Pressable>
            <Field value={message} onChangeText={setMessage} placeholder={t('help.orType')} multiline style={styles.multiline} />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Button
              label={t('help.sendTicket')}
              onPress={send}
              loading={busy}
              disabled={busy || (!voiceUri && !message.trim() && !recording)}
              icon={<Ionicons name="send" size={18} color={colors.onPrimary} />}
            />
          </>
        ) : null}
      </Card>

      {tickets.length > 0 ? (
        <View style={{ gap: space.sm }}>
          <Muted>{t('help.yourTickets')}</Muted>
          {tickets.map((tk) => {
            const done = tk.status === 'Resolved' || tk.status === 'Closed';
            const last = tk.resolution || tk.replies[tk.replies.length - 1]?.message || '';
            return (
              <Card key={tk.ticketId} style={{ gap: space.xs }}>
                <View style={styles.rowBetween}>
                  <Text style={styles.rowText} numberOfLines={1}>
                    {tk.subject.replace(/^Guard App — /, '')}
                  </Text>
                  <Text style={[styles.status, { color: done ? colors.onDuty : colors.warning }]}>{tk.status}</Text>
                </View>
                <Muted>
                  {tk.ticketId} · {new Date(tk.createdAt).toLocaleDateString('en-IN')}
                </Muted>
                {last ? <Body style={{ color: colors.textMuted }}>{last}</Body> : null}
              </Card>
            );
          })}
        </View>
      ) : null}

      <Card>
        <View style={styles.rowGap}>
          <Ionicons name="help-circle" size={24} color={colors.warning} />
          <H2>{t('help.faqTitle')}</H2>
        </View>
        <Body style={{ color: colors.textMuted }}>{t('help.faqBody')}</Body>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowGap: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  callRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 56 },
  rowText: { color: colors.text, fontSize: font.body, fontWeight: '800', flexShrink: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  cat: {
    width: '31%',
    minHeight: 60,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: space.xs,
  },
  catActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  catText: { color: colors.text, fontSize: font.tiny, fontWeight: '800', textAlign: 'center' },
  voiceBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: space.md,
    minHeight: touch.minTap + 12,
  },
  voiceText: { color: colors.text, fontSize: font.body, fontWeight: '700', flex: 1 },
  multiline: { minHeight: 72, textAlignVertical: 'top' },
  error: { color: colors.danger, fontWeight: '700' },
  sent: { flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: colors.onDutyDim, borderRadius: radius.sm, padding: space.md },
  sentText: { color: colors.onDuty, fontWeight: '700', flex: 1 },
  status: { fontSize: font.tiny, fontWeight: '900', textTransform: 'uppercase' },
});
