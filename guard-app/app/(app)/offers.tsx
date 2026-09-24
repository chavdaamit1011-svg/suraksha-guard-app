import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Body, Button, Card, H2, Muted, Screen } from '@/components/ui';
import { useT } from '@/i18n';
import { api, type OfferOutcome, type ReplacementOffer } from '@/lib/api';
import { formatCountdown } from '@/lib/duty';
import { guardId, useAuth } from '@/store/auth';
import { useDuty } from '@/store/duty';
import { useVersion } from '@/store/version';
import { FeatureOffNotice } from '@/components/UpdateNotice';
import { colors, font, radius, space, touch } from '@/theme';

/**
 * Replacement offers (PRD 18.12, SUR-GAP-022).
 *
 * An offer is a full-screen card: where, when, how far, what it pays, and how long the guard has
 * to decide — then two buttons. One tap from the notification to a decision.
 *
 * The single rule that shapes this screen: **acceptance is not confirmed until the server says
 * so.** Offers are dispatched to several guards at once and the first ACCEPT wins, so tapping
 * ACCEPT shows "Sent — waiting for confirmation", never a confirmed state (18.12 §16). A guard
 * who turns up for a shift the app told them they had, and finds someone else there, will not
 * trust the app again.
 */

type OfferUiState = 'sending' | OfferOutcome;
type Pending = Record<string, OfferUiState>;

/**
 * Outcomes the server has settled. Anything else ('sending', or 'pending' after a failed send)
 * keeps the buttons on screen, because the guard still has a decision to make or repeat.
 */
const SETTLED = new Set<OfferUiState>(['accepted', 'declined', 'taken', 'expired', 'cancelled', 'conflict']);

function rupees(paise: number): string {
  if (!paise) return '';
  const r = paise / 100;
  return `₹${r % 1 === 0 ? r.toLocaleString('en-IN') : r.toFixed(2)}`;
}

export default function Offers() {
  const t = useT();
  const router = useRouter();
  const guard = useAuth((s) => s.guard);
  const bundleOffers = useDuty((s) => s.bundle?.offers);
  const refresh = useDuty((s) => s.refresh);
  const offersOff = useVersion((s) => s.isDisabled('offers'));

  const [offers, setOffers] = useState<ReplacementOffer[]>(bundleOffers ?? []);
  const [loading, setLoading] = useState(!bundleOffers?.length);
  const [state, setState] = useState<Pending>({});
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  const load = useCallback(async () => {
    const id = guardId(guard);
    if (!id) return;
    try {
      const res = await api.offers(id);
      setOffers(
        (res.offers ?? []).map((o: any) => ({
          offerId: String(o._id ?? o.offerId),
          vacancyId: o.vacancyId,
          siteName: o.siteName,
          siteId: o.siteId,
          shiftDate: o.shiftDate,
          timing: o.timing,
          shiftType: o.shiftType,
          incentivePaise: o.incentivePaise ?? 0,
          distanceKm: o.distanceKm ?? null,
          expiresAt: o.expiresAt,
          status: o.status,
        }))
      );
    } catch {
      // Offline: keep whatever the cached bundle gave us. An offer cannot be answered offline
      // anyway — the server has to arbitrate (PRD 18.15.2).
    } finally {
      setLoading(false);
    }
  }, [guard]);

  useEffect(() => {
    load();
  }, [load]);

  const respond = async (offer: ReplacementOffer, response: 'accept' | 'decline') => {
    const id = guardId(guard);
    if (!id) return;
    setState((s) => ({ ...s, [offer.offerId]: 'sending' }));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});

    try {
      const res = await api.respondToOffer(id, offer.offerId, response);
      setState((s) => ({ ...s, [offer.offerId]: res.outcome }));
      Haptics.notificationAsync(
        res.outcome === 'accepted'
          ? Haptics.NotificationFeedbackType.Success
          : Haptics.NotificationFeedbackType.Warning
      ).catch(() => {});
      if (res.outcome === 'accepted') refresh().catch(() => {});
      setTimeout(load, 1200);
    } catch {
      // The request never landed. Acceptance cannot be queued: by the time a queue flushed, the
      // shift would be long gone, and showing a confirmed state we cannot back up is worse than
      // an honest failure.
      setState((s) => ({ ...s, [offer.offerId]: 'pending' }));
    }
  };

  const live = offers.filter(
    (o) => o.status === 'pending' && Date.parse(o.expiresAt) > now - 1000
  );

  return (
    <Screen>
      <View style={styles.head}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <H2>{t('offers.title')}</H2>
        <View style={{ width: 24 }} />
      </View>

      {offersOff ? (
        // Degraded mode (PRD 18.18.3): an old client must not take shifts it may misrender.
        <FeatureOffNotice />
      ) : loading && offers.length === 0 ? (
        <Card style={styles.center}>
          <ActivityIndicator color={colors.primary} />
          <Muted>{t('common.loading')}</Muted>
        </Card>
      ) : live.length === 0 ? (
        <Card style={styles.center}>
          <Ionicons name="calendar-outline" size={36} color={colors.textFaint} />
          <Muted style={{ textAlign: 'center' }}>{t('offers.none')}</Muted>
        </Card>
      ) : (
        live.map((offer) => {
          const remaining = Math.max(0, Math.round((Date.parse(offer.expiresAt) - now) / 1000));
          const outcome = state[offer.offerId];
          const closing = remaining < 120;

          return (
            <Card key={offer.offerId} style={{ ...styles.card, borderColor: closing ? colors.warning : colors.primary }}>
              <View style={styles.rowBetween}>
                <Muted>{t('offers.extraDuty')}</Muted>
                <View style={styles.rowGap}>
                  <Ionicons name="time" size={16} color={closing ? colors.danger : colors.warning} />
                  <Text style={[styles.timer, closing && { color: colors.danger }]}>
                    {formatCountdown(remaining)}
                  </Text>
                </View>
              </View>

              <Text style={styles.site}>{offer.siteName}</Text>

              <View style={styles.metaRow}>
                <Meta icon="calendar" text={offer.shiftDate} />
                <Meta icon="time-outline" text={offer.timing} />
              </View>
              <View style={styles.metaRow}>
                {offer.shiftType ? <Meta icon="briefcase" text={offer.shiftType} /> : null}
                {offer.distanceKm !== null ? (
                  <Meta icon="navigate" text={`${offer.distanceKm} km`} />
                ) : null}
              </View>

              {offer.incentivePaise > 0 ? (
                <View style={styles.pay}>
                  <Ionicons name="cash" size={20} color={colors.onDuty} />
                  <Text style={styles.payText}>
                    {t('offers.extraPay')} {rupees(offer.incentivePaise)}
                  </Text>
                </View>
              ) : null}

              {outcome && SETTLED.has(outcome) ? (
                <OutcomeBanner outcome={outcome} />
              ) : (
                <View style={styles.actions}>
                  <View style={{ flex: 1 }}>
                    <Button
                      label={t('offers.accept')}
                      variant="success"
                      onPress={() => respond(offer, 'accept')}
                      loading={outcome === 'sending'}
                      disabled={remaining === 0}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button
                      label={t('offers.decline')}
                      variant="ghost"
                      onPress={() => respond(offer, 'decline')}
                      disabled={outcome === 'sending' || remaining === 0}
                    />
                  </View>
                </View>
              )}

              {outcome === 'pending' ? <Text style={styles.err}>{t('offers.couldNotSend')}</Text> : null}
            </Card>
          );
        })
      )}

      <Muted style={{ textAlign: 'center' }}>{t('offers.note')}</Muted>
    </Screen>
  );
}

/** Say plainly what happened. "Someone else took it" is the outcome that has to be unambiguous. */
function OutcomeBanner({ outcome }: { outcome: OfferUiState }) {
  const t = useT();
  const map: Record<string, { icon: keyof typeof Ionicons.glyphMap; color: string; key: string }> = {
    sending: { icon: 'cloud-upload', color: colors.warning, key: 'offers.sending' },
    accepted: { icon: 'checkmark-circle', color: colors.onDuty, key: 'offers.accepted' },
    declined: { icon: 'close-circle', color: colors.textMuted, key: 'offers.declined' },
    taken: { icon: 'people', color: colors.warning, key: 'offers.taken' },
    expired: { icon: 'time', color: colors.textMuted, key: 'offers.expired' },
    cancelled: { icon: 'ban', color: colors.textMuted, key: 'offers.cancelled' },
    conflict: { icon: 'alert-circle', color: colors.warning, key: 'offers.conflict' },
  };
  const m = map[outcome] ?? map.expired;
  return (
    <View style={[styles.outcome, { backgroundColor: 'rgba(255,255,255,0.06)' }]}>
      <Ionicons name={m.icon} size={20} color={m.color} />
      <Body style={{ color: m.color, fontWeight: '800', flex: 1 }}>{t(m.key)}</Body>
    </View>
  );
}

function Meta({ icon, text }: { icon: keyof typeof Ionicons.glyphMap; text: string }) {
  return (
    <View style={styles.rowGap}>
      <Ionicons name={icon} size={14} color={colors.textMuted} />
      <Text style={styles.metaText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  center: { alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingVertical: space.xxl },
  card: { gap: space.md, borderWidth: 2 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowGap: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  site: { color: colors.text, fontSize: font.h2, fontWeight: '900' },
  timer: { color: colors.warning, fontSize: font.h3, fontWeight: '900', letterSpacing: 1 },
  metaRow: { flexDirection: 'row', gap: space.lg, flexWrap: 'wrap' },
  metaText: { color: colors.textMuted, fontSize: font.label, fontWeight: '600' },
  pay: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.onDutyDim,
    borderRadius: radius.md,
    padding: space.md,
  },
  payText: { color: colors.onDuty, fontSize: font.h3, fontWeight: '900' },
  actions: { flexDirection: 'row', gap: space.sm },
  outcome: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderRadius: radius.md,
    padding: space.md,
    minHeight: touch.minTap,
  },
  err: { color: colors.danger, fontWeight: '700', textAlign: 'center' },
});
