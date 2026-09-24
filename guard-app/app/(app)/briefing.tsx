import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as Speech from 'expo-speech';
import { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Body, Button, Card, H2, Muted, Screen } from '@/components/ui';
import { useI18n, useT } from '@/i18n';
import { KEYS, store } from '@/lib/storage';
import { useDuty } from '@/store/duty';
import { colors, font, radius, space, touch } from '@/theme';

/**
 * Shift & site briefing (PRD 18.4, SUR-GAP-009).
 *
 * A card stack the guard can read standing at a gate: one instruction per card, a read-aloud
 * control, the equipment checklist, and every escalation contact as a one-tap call.
 *
 * The acknowledgement is versioned. When the agency edits the post orders the version bumps and
 * the guard has to acknowledge again at next check-in — that record is the evidence in a client
 * dispute, so it has to say *which* version was read.
 */
export default function Briefing() {
  const t = useT();
  const router = useRouter();
  const lang = useI18n((s) => s.lang);
  const { current, booking } = useDuty();

  const [acked, setAcked] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  const cards = current?.briefing.cards ?? [];
  const version = current?.briefing.version ?? 1;
  const ackKey = current ? `${current.siteId || current.siteName}:${version}` : '';

  const siteName = current?.siteName ?? booking?.location?.address ?? booking?.location?.city ?? '—';
  const shift = current ? `${current.start}–${current.end}` : (booking?.schedule?.startTime ?? '—');
  const post = current?.shiftType || booking?.serviceType || '—';

  useEffect(() => {
    if (!ackKey) return;
    store.getJSON<string[]>(KEYS.ackedBriefings, []).then((list) => setAcked(list.includes(ackKey)));
  }, [ackKey]);

  useEffect(() => () => void Speech.stop(), []);

  const readAloud = () => {
    const text = [
      `${t('duty.site')}: ${siteName}`,
      `${t('duty.shift')}: ${shift}`,
      ...cards.map((c) => c.text),
    ].join('. ');
    try {
      Speech.stop();
      setSpeaking(true);
      Speech.speak(text, {
        language: lang === 'en' ? 'en-IN' : 'hi-IN',
        onDone: () => setSpeaking(false),
        onStopped: () => setSpeaking(false),
        onError: () => setSpeaking(false),
      });
    } catch {
      setSpeaking(false);
    }
  };

  const acknowledge = async () => {
    if (!ackKey) return;
    const list = await store.getJSON<string[]>(KEYS.ackedBriefings, []);
    if (!list.includes(ackKey)) {
      // Keep the tail bounded — old versions are of no further use once superseded.
      await store.setJSON(KEYS.ackedBriefings, [...list, ackKey].slice(-50));
    }
    setAcked(true);
  };

  return (
    <Screen>
      <View style={styles.head}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <H2>{t('briefing.title')}</H2>
        <Pressable onPress={speaking ? () => { Speech.stop(); setSpeaking(false); } : readAloud} hitSlop={12}>
          <Ionicons name={speaking ? 'stop-circle' : 'volume-medium'} size={26} color={colors.primary} />
        </Pressable>
      </View>

      <Card>
        <Row icon="location" label={t('duty.site')} value={siteName} />
        <Row icon="shield" label={t('duty.post')} value={post} />
        <Row icon="time" label={t('duty.shift')} value={shift} />
        {current?.site.reportingPoint ? (
          <Row icon="flag" label={t('briefing.reportAt')} value={current.site.reportingPoint} />
        ) : null}
        {current?.site.uniformRequired ? (
          <Row icon="shirt" label={t('briefing.uniform')} value={current.site.uniformRequired} />
        ) : null}
      </Card>

      {/* Equipment checklist */}
      {current && current.site.equipmentRequired.length > 0 ? (
        <View style={{ gap: space.sm }}>
          <Muted>{t('briefing.equipment')}</Muted>
          <Card>
            {current.site.equipmentRequired.map((item, i) => (
              <View key={i} style={styles.rowGap}>
                <Ionicons name="checkbox-outline" size={18} color={colors.primary} />
                <Body style={{ flex: 1 }}>{item}</Body>
              </View>
            ))}
          </Card>
        </View>
      ) : null}

      {/* Post orders — one instruction per card */}
      <Muted>{t('briefing.orders')}</Muted>
      {cards.length === 0 ? (
        <Card style={styles.empty}>
          <Ionicons name="document-text-outline" size={32} color={colors.textFaint} />
          <Muted style={{ textAlign: 'center' }}>{t('briefing.noOrders')}</Muted>
        </Card>
      ) : (
        cards.map((card, i) => (
          <Card key={i} style={styles.orderCard}>
            <View style={styles.num}>
              <Text style={styles.numText}>{i + 1}</Text>
            </View>
            <Body style={{ flex: 1 }}>{card.text}</Body>
          </Card>
        ))
      )}

      {/* Escalation contacts — each a one-tap call (PRD 18.4 §5) */}
      {current && current.site.escalationContacts.length > 0 ? (
        <View style={{ gap: space.sm }}>
          <Muted>{t('briefing.contacts')}</Muted>
          {current.site.escalationContacts.map((c, i) => (
            <Pressable key={i} onPress={() => c.phone && Linking.openURL(`tel:${c.phone}`)}>
              <Card style={styles.contactRow}>
                <Ionicons name="call" size={22} color={colors.onDuty} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.contactName}>{c.name || c.role || t('duty.supervisor')}</Text>
                  <Muted>{c.phone}</Muted>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
              </Card>
            </Pressable>
          ))}
        </View>
      ) : null}

      {cards.length > 0 ? (
        <>
          <Button
            label={acked ? t('briefing.acked') : t('briefing.ack')}
            variant={acked ? 'success' : 'primary'}
            icon={acked ? <Ionicons name="checkmark-circle" size={20} color="#fff" /> : undefined}
            onPress={acknowledge}
            disabled={acked}
          />
          <Muted style={{ textAlign: 'center' }}>
            {t('briefing.version')} {version}
          </Muted>
        </>
      ) : null}
    </Screen>
  );
}

function Row({ icon, label, value }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Ionicons name={icon} size={18} color={colors.primary} />
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 4 },
  rowGap: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 4 },
  label: { color: colors.textMuted, fontSize: font.label, width: 84 },
  value: { color: colors.text, fontSize: font.body, fontWeight: '700', flex: 1, textAlign: 'right' },
  orderCard: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  num: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  numText: { color: colors.onPrimary, fontWeight: '900' },
  empty: { alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingVertical: space.xl },
  contactRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: touch.minTap, borderRadius: radius.lg },
  contactName: { color: colors.text, fontSize: font.body, fontWeight: '700' },
});
