import { Ionicons } from '@expo/vector-icons';
import { File, Paths } from 'expo-file-system';
import { useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
import * as Speech from 'expo-speech';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Body, Button, Card, H2, Muted, Screen } from '@/components/ui';
import { useI18n, useT } from '@/i18n';
import { api, ApiError, type EarningsResponse, type Payslip } from '@/lib/api';
import { KEYS, store } from '@/lib/storage';
import { guardId, useAuth } from '@/store/auth';
import { goBack } from '@/lib/navigation';
import { colors, font, radius, space, touch } from '@/theme';

const CACHE_KEY = 'sg.earnings';

/** Integer paise → the rupee string a guard reads. Never floating-point arithmetic on money. */
function rupees(paise: number | undefined | null): string {
  if (typeof paise !== 'number') return '—';
  const whole = Math.floor(Math.abs(paise) / 100);
  const sign = paise < 0 ? '-' : '';
  return `${sign}₹${whole.toLocaleString('en-IN')}`;
}

function monthName(period: string, lang: string): string {
  const [y, m] = period.split('-').map(Number);
  if (!y || !m) return period;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(lang === 'en' ? 'en-IN' : 'hi-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Earnings & payslips (PRD 18.13, SUR-GAP-023).
 *
 * One very large number at the top, and — while the month is still running — the word
 * **Estimated** beside it, because attendance corrections move it. PRD 18.13 §9: showing an
 * authoritative figure that later drops is the fastest way to destroy a guard's trust in the
 * whole attendance system.
 *
 * Payslip detail puts net pay, payment status and the bank reference above the fold, because the
 * reference is what a guard checks against their passbook.
 */
export default function EarningsScreen() {
  const t = useT();
  const router = useRouter();
  const lang = useI18n((s) => s.lang);
  const guard = useAuth((s) => s.guard);

  const [data, setData] = useState<EarningsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [open, setOpen] = useState<Payslip | null>(null);
  const [speaking, setSpeaking] = useState(false);

  const load = useCallback(async () => {
    const id = guardId(guard);
    if (!id) return;
    try {
      const res = await api.earnings(id);
      setData(res);
      setOffline(false);
      // Metadata only, per the 18.15.1 cache table — the PDF is fetched on demand.
      await store.setJSON(CACHE_KEY, res);
    } catch {
      const cached = await store.getJSON<EarningsResponse | null>(CACHE_KEY, null);
      if (cached) setData(cached);
      setOffline(true);
    } finally {
      setLoading(false);
    }
  }, [guard]);

  useEffect(() => {
    store.getJSON<EarningsResponse | null>(CACHE_KEY, null).then((c) => {
      if (c) {
        setData(c);
        setLoading(false);
      }
    });
    load();
  }, [load]);

  useEffect(() => () => void Speech.stop(), []);

  /** Read-aloud is a first-class control here, not an accessibility afterthought (18.13 §5). */
  const readAloud = (text: string) => {
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

  if (open) {
    return (
      <PayslipDetail
        payslip={open}
        onBack={() => setOpen(null)}
        onRead={readAloud}
        speaking={speaking}
        onStop={() => {
          Speech.stop();
          setSpeaking(false);
        }}
      />
    );
  }

  const est = data?.estimate;
  const current = data?.payslips.find((p) => p.period === data?.period);
  const headline = current ? current.netPaise : (est?.grossPaise ?? 0);

  const summaryText = () => {
    const month = monthName(data?.period ?? '', lang);
    if (current) {
      return `${month}. ${t('earnings.netPay')} ${rupees(current.netPaise)}. ${
        current.status === 'Completed' ? t('earnings.paid') : t('earnings.notYetPaid')
      }.`;
    }
    return `${month}. ${t('earnings.estimatedSoFar')} ${rupees(est?.grossPaise)}. ${t('earnings.daysWorked')} ${
      est?.daysPresent ?? 0
    }. ${t('earnings.overtime')} ${est?.otHours ?? 0} ${t('earnings.hours')}.`;
  };

  return (
    <Screen>
      <View style={styles.head}>
        <Pressable onPress={() => goBack()} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <H2>{t('earnings.title')}</H2>
        <Pressable
          onPress={speaking ? () => { Speech.stop(); setSpeaking(false); } : () => readAloud(summaryText())}
          hitSlop={12}
        >
          <Ionicons name={speaking ? 'stop-circle' : 'volume-medium'} size={26} color={colors.primary} />
        </Pressable>
      </View>

      {offline ? (
        <View style={styles.offline}>
          <Ionicons name="cloud-offline" size={14} color={colors.warning} />
          <Text style={styles.offlineText}>{t('earnings.cached')}</Text>
        </View>
      ) : null}

      {loading && !data ? (
        <Card style={styles.center}>
          <ActivityIndicator color={colors.primary} />
          <Muted>{t('common.loading')}</Muted>
        </Card>
      ) : (
        <>
          {/* The one very large number (PRD 18.13 §5) */}
          <Card style={styles.hero}>
            <Muted>{monthName(data?.period ?? '', lang)}</Muted>
            <Text style={styles.heroValue}>{rupees(headline)}</Text>

            {current ? (
              <View style={styles.rowGap}>
                <Ionicons
                  name={current.status === 'Completed' ? 'checkmark-circle' : 'time'}
                  size={18}
                  color={current.status === 'Completed' ? colors.onDuty : colors.warning}
                />
                <Text style={[styles.status, { color: current.status === 'Completed' ? colors.onDuty : colors.warning }]}>
                  {current.status === 'Completed' ? t('earnings.paid') : t('earnings.notYetPaid')}
                </Text>
              </View>
            ) : (
              // The label that stops the number being mistaken for settled pay.
              <View style={styles.estimateBadge}>
                <Ionicons name="information-circle" size={16} color={colors.warning} />
                <Text style={styles.estimateText}>{t('earnings.estimated')}</Text>
              </View>
            )}
          </Card>

          {est ? (
            <>
              <View style={styles.chips}>
                <Chip icon="calendar" label={t('earnings.daysWorked')} value={String(est.daysPresent)} />
                <Chip icon="time" label={t('earnings.overtime')} value={`${est.otHours} ${t('earnings.hours')}`} />
                <Chip icon="cash" label={t('earnings.perDay')} value={rupees(est.perDayPaise)} />
              </View>

              {est.daysAwaitingReview > 0 ? (
                <View style={styles.noticeBox}>
                  <Ionicons name="hourglass" size={18} color={colors.warning} />
                  <Body style={{ flex: 1, color: colors.warning }}>
                    {est.daysAwaitingReview} {t('earnings.awaitingReview')}
                  </Body>
                </View>
              ) : null}

              <Muted>{t('earnings.estimateNote')}</Muted>
            </>
          ) : null}

          {/* Six-month bar row */}
          {(data?.history?.length ?? 0) > 1 ? (
            <View style={{ gap: space.sm }}>
              <Muted>{t('earnings.lastMonths')}</Muted>
              <BarRow history={data!.history} />
            </View>
          ) : null}

          <Muted>{t('earnings.payslips')}</Muted>
          {(data?.payslips?.length ?? 0) === 0 ? (
            <Card style={styles.center}>
              <Ionicons name="document-text-outline" size={32} color={colors.textFaint} />
              <Muted style={{ textAlign: 'center' }}>{t('earnings.noPayslips')}</Muted>
            </Card>
          ) : (
            data!.payslips.map((p) => (
              <Pressable key={p.period} onPress={() => setOpen(p)}>
                <Card style={styles.payslipRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.period}>{monthName(p.period, lang)}</Text>
                    <Muted>
                      {p.daysPresent} {t('earnings.days')}
                      {p.otHours > 0 ? ` · ${p.otHours} ${t('earnings.hours')} OT` : ''}
                    </Muted>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={styles.net}>{rupees(p.netPaise)}</Text>
                    <Text style={[styles.status, { color: p.status === 'Completed' ? colors.onDuty : colors.warning }]}>
                      {p.status === 'Completed' ? t('earnings.paid') : t('earnings.notYetPaid')}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color={colors.textFaint} />
                </Card>
              </Pressable>
            ))
          )}
        </>
      )}
    </Screen>
  );
}

/** Net pay, status and reference above the fold — that is the whole job of this screen. */
function PayslipDetail({
  payslip,
  onBack,
  onRead,
  speaking,
  onStop,
}: {
  payslip: Payslip;
  onBack: () => void;
  onRead: (text: string) => void;
  speaking: boolean;
  onStop: () => void;
}) {
  const t = useT();
  const lang = useI18n((s) => s.lang);
  const router = useRouter();
  const guard = useAuth((s) => s.guard);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState('');

  /**
   * Download the PDF into the app's cache and hand it to Android's share sheet, from where the
   * guard can open it in any PDF viewer, save it or send it on WhatsApp. Handing the link to a
   * browser instead proved unreliable — some phone browsers silently download and close.
   */
  const openPdf = async () => {
    setPdfBusy(true);
    setPdfError('');
    try {
      const r = await api.payslipPdfLink(guardId(guard), payslip.period);
      const target = new File(Paths.cache, `payslip-${payslip.period}.pdf`);
      if (target.exists) target.delete();
      const file = await File.downloadFileAsync(r.url, target);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, {
          mimeType: 'application/pdf',
          dialogTitle: `${t('earnings.title')} ${monthName(payslip.period, lang)}`,
          UTI: 'com.adobe.pdf',
        });
      } else {
        await Linking.openURL(r.url);
      }
    } catch (e: any) {
      setPdfError(e instanceof ApiError && e.status < 500 && e.status !== 503 ? e.message : t('earnings.pdfUnavailable'));
    } finally {
      setPdfBusy(false);
    }
  };

  const spoken = [
    monthName(payslip.period, lang),
    `${t('earnings.gross')} ${rupees(payslip.grossPaise)}`,
    `${t('earnings.deductions')} ${rupees(payslip.deductionsPaise)}`,
    `${t('earnings.netPay')} ${rupees(payslip.netPaise)}`,
    payslip.status === 'Completed' ? `${t('earnings.paid')} ${payslip.referenceNo}` : t('earnings.notYetPaid'),
  ].join('. ');

  return (
    <Screen>
      <View style={styles.head}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <H2>{monthName(payslip.period, lang)}</H2>
        <Pressable onPress={speaking ? onStop : () => onRead(spoken)} hitSlop={12}>
          <Ionicons name={speaking ? 'stop-circle' : 'volume-medium'} size={26} color={colors.primary} />
        </Pressable>
      </View>

      <Card style={styles.hero}>
        <Muted>{t('earnings.netPay')}</Muted>
        <Text style={styles.heroValue}>{rupees(payslip.netPaise)}</Text>
        {payslip.status === 'Completed' ? (
          <>
            <View style={styles.rowGap}>
              <Ionicons name="checkmark-circle" size={18} color={colors.onDuty} />
              <Text style={[styles.status, { color: colors.onDuty }]}>
                {t('earnings.paidOn')}{' '}
                {payslip.paidOn ? new Date(payslip.paidOn).toLocaleDateString('en-IN') : ''}
              </Text>
            </View>
            {payslip.referenceNo ? <Muted>UTR {payslip.referenceNo}</Muted> : null}
          </>
        ) : (
          <View style={styles.rowGap}>
            <Ionicons name="time" size={18} color={colors.warning} />
            <Text style={[styles.status, { color: colors.warning }]}>{t('earnings.notYetPaid')}</Text>
          </View>
        )}
      </Card>

      <View style={styles.chips}>
        <Chip icon="calendar" label={t('earnings.daysWorked')} value={String(payslip.daysPresent)} />
        <Chip icon="close-circle" label={t('earnings.absent')} value={String(payslip.daysAbsent)} />
        <Chip icon="time" label="OT" value={`${payslip.otHours} ${t('earnings.hours')}`} />
      </View>

      <Muted>{t('earnings.gross')}</Muted>
      <Card>
        {payslip.earnings.map((l, i) => (
          <View key={`${l.code}-${i}`} style={styles.lineRow}>
            <Text style={styles.lineLabel}>{l.label || l.code}</Text>
            <Text style={styles.lineValue}>{rupees(l.amountPaise)}</Text>
          </View>
        ))}
        <View style={[styles.lineRow, styles.totalRow]}>
          <Text style={styles.totalLabel}>{t('earnings.gross')}</Text>
          <Text style={styles.totalValue}>{rupees(payslip.grossPaise)}</Text>
        </View>
      </Card>

      {payslip.deductions.length > 0 ? (
        <>
          <Muted>{t('earnings.deductions')}</Muted>
          <Card>
            {payslip.deductions.map((l, i) => (
              <View key={`${l.code}-${i}`} style={styles.lineRow}>
                <Text style={styles.lineLabel}>{l.label || l.code}</Text>
                <Text style={[styles.lineValue, { color: colors.warning }]}>− {rupees(l.amountPaise)}</Text>
              </View>
            ))}
            <View style={[styles.lineRow, styles.totalRow]}>
              <Text style={styles.totalLabel}>{t('earnings.deductions')}</Text>
              <Text style={[styles.totalValue, { color: colors.warning }]}>− {rupees(payslip.deductionsPaise)}</Text>
            </View>
          </Card>
        </>
      ) : null}

      {payslip.carriedForwardPaise > 0 ? (
        <View style={styles.noticeBox}>
          <Ionicons name="arrow-forward-circle" size={18} color={colors.warning} />
          <Body style={{ flex: 1, color: colors.warning }}>
            {t('earnings.carriedForward')} {rupees(payslip.carriedForwardPaise)}
          </Body>
        </View>
      ) : null}

      <Button
        label={pdfBusy ? t('common.loading') : t('earnings.downloadPdf')}
        variant="ghost"
        loading={pdfBusy}
        icon={<Ionicons name="document-text" size={20} color={colors.text} />}
        onPress={openPdf}
      />
      {pdfError ? <Text style={styles.pdfError}>{pdfError}</Text> : null}

      <Button
        label={t('earnings.disputeThis')}
        variant="ghost"
        icon={<Ionicons name="help-buoy" size={20} color={colors.text} />}
        onPress={() => router.push({ pathname: '/help', params: { category: 'pay', period: payslip.period } })}
      />
      <Muted style={{ textAlign: 'center' }}>{t('earnings.disputeNote')}</Muted>
    </Screen>
  );
}

function BarRow({ history }: { history: { period: string; netPaise: number }[] }) {
  const max = Math.max(...history.map((h) => h.netPaise), 1);
  return (
    <Card style={styles.bars}>
      {history.map((h) => (
        <View key={h.period} style={styles.barCol}>
          <View style={[styles.bar, { height: Math.max(4, Math.round((h.netPaise / max) * 72)) }]} />
          <Text style={styles.barLabel}>{h.period.slice(5)}</Text>
        </View>
      ))}
    </Card>
  );
}

function Chip({ icon, label, value }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string }) {
  return (
    <View style={styles.chip}>
      <Ionicons name={icon} size={18} color={colors.primary} />
      <Text style={styles.chipValue}>{value}</Text>
      <Text style={styles.chipLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  center: { alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingVertical: space.xl },
  offline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.warningDim,
    borderRadius: radius.sm,
    padding: space.md,
  },
  offlineText: { color: colors.warning, fontSize: font.tiny, fontWeight: '700', flex: 1 },
  hero: { alignItems: 'center', gap: space.xs, paddingVertical: space.xl },
  heroValue: { color: colors.text, fontSize: 44, fontWeight: '900', letterSpacing: -1 },
  estimateBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    backgroundColor: colors.warningDim,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  estimateText: { color: colors.warning, fontSize: font.label, fontWeight: '900', textTransform: 'uppercase' },
  status: { fontSize: font.label, fontWeight: '800' },
  rowGap: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  chips: { flexDirection: 'row', gap: space.sm },
  chip: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    paddingVertical: space.md,
    gap: 2,
  },
  chipValue: { color: colors.text, fontSize: font.h3, fontWeight: '900' },
  chipLabel: { color: colors.textMuted, fontSize: font.tiny, fontWeight: '700', textAlign: 'center' },
  noticeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.warningDim,
    borderRadius: radius.md,
    padding: space.md,
  },
  payslipRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: touch.minTap },
  period: { color: colors.text, fontSize: font.body, fontWeight: '800' },
  net: { color: colors.text, fontSize: font.h3, fontWeight: '900' },
  lineRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  lineLabel: { color: colors.textMuted, fontSize: font.body },
  lineValue: { color: colors.text, fontSize: font.body, fontWeight: '700' },
  totalRow: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: space.xs, paddingTop: space.sm },
  totalLabel: { color: colors.text, fontSize: font.body, fontWeight: '900' },
  totalValue: { color: colors.text, fontSize: font.h3, fontWeight: '900' },
  bars: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-around', height: 120 },
  barCol: { alignItems: 'center', gap: space.xs },
  bar: { width: 22, backgroundColor: colors.primary, borderRadius: radius.sm },
  barLabel: { color: colors.textFaint, fontSize: font.tiny, fontWeight: '700' },
  pdfError: { color: colors.warning, fontSize: font.label, textAlign: 'center' },
});
