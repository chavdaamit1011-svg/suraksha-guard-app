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

/** Integer paise → rupee string. */
function rupees(paise: number | undefined | null): string {
  if (typeof paise !== 'number') return '—';
  const whole = Math.floor(Math.abs(paise) / 100);
  const sign = paise < 0 ? '-' : '';
  return `${sign}₹${whole.toLocaleString('en-IN')}`;
}

function monthName(period: string, lang: string): string {
  if (!period) return '';
  if (period.startsWith('BK-')) return period;
  const [y, m] = period.split('-').map(Number);
  if (!y || !m) return period;
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleDateString(lang === 'en' ? 'en-IN' : 'hi-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Guard Payslip & Duty Earnings Screen (PRD 18.13).
 * Seamlessly tracks and displays order payouts, payslips, and verified earnings.
 */
export default function Earnings() {
  const t = useT();
  const lang = useI18n((s) => s.lang);
  const router = useRouter();
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
      await store.setJSON(CACHE_KEY, res);
    } catch {
      const cached = await store.getJSON<EarningsResponse | null>(CACHE_KEY, null);
      if (cached) {
        setData(cached);
        setOffline(true);
      }
    } finally {
      setLoading(false);
    }
  }, [guard]);

  useEffect(() => {
    store.getJSON<EarningsResponse | null>(CACHE_KEY, null).then((cached) => {
      if (cached) {
        setData(cached);
        setLoading(false);
      }
    });
    load();
  }, [load]);

  useEffect(() => () => void Speech.stop(), []);

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
  const totalFromOrders = data?.totalEarnedPaise ?? (data?.payslips ?? []).reduce((sum, p) => sum + (p.netPaise || 0), 0);
  const headline = totalFromOrders > 0 ? totalFromOrders : current ? current.netPaise : (est?.grossPaise ?? 0);

  const completedCount = data?.completedOrdersCount ?? data?.payslips?.length ?? 0;
  const avgRating = data?.averageRating ?? 5.0;

  const summaryText = () => {
    return `${t('earnings.title')}. ${rupees(headline)}. ${completedCount} orders completed. Client rating ${avgRating.toFixed(1)} stars.`;
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
          {/* Main Hero Card: Total Earnings */}
          <Card style={styles.hero}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Muted>{monthName(data?.period ?? '', lang)}</Muted>
              <View style={[styles.estimateBadge, { backgroundColor: 'rgba(5,150,105,0.15)' }]}>
                <Ionicons name="shield-checkmark" size={13} color={colors.onDuty} />
                <Text style={[styles.estimateText, { color: colors.onDuty }]}>{t('earnings.paid')}</Text>
              </View>
            </View>
            <Text style={styles.heroValue}>{rupees(headline)}</Text>

            <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.xs, flexWrap: 'wrap' }}>
              <View style={styles.rowGap}>
                <Ionicons name="checkmark-done-circle" size={16} color={colors.onDuty} />
                <Text style={{ color: colors.text, fontSize: font.label, fontWeight: '700' }}>
                  {completedCount} Orders Completed
                </Text>
              </View>
              {avgRating ? (
                <View style={styles.rowGap}>
                  <Ionicons name="star" size={14} color={colors.warning} />
                  <Text style={{ color: colors.warning, fontSize: font.label, fontWeight: '800' }}>
                    {avgRating.toFixed(1)} / 5.0 Rating
                  </Text>
                </View>
              ) : null}
            </View>
          </Card>

          {/* Quick Stats Chips */}
          <View style={styles.chips}>
            <Chip icon="checkmark-circle" label="Orders Paid" value={String(completedCount)} />
            <Chip icon="star" label="Avg Rating" value={`⭐ ${avgRating.toFixed(1)}`} />
            <Chip icon="cash" label="Net Payout" value={rupees(headline)} />
          </View>

          {/* Six-month bar row if available */}
          {(data?.history?.length ?? 0) > 1 ? (
            <View style={{ gap: space.sm }}>
              <Muted>{t('earnings.lastMonths')}</Muted>
              <BarRow history={data!.history} />
            </View>
          ) : null}

          {/* Payslips and Orders Payouts List */}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Muted>{t('earnings.payslips')}</Muted>
            <Muted style={{ fontSize: font.tiny }}>{data?.payslips?.length ?? 0} Records</Muted>
          </View>

          {(data?.payslips?.length ?? 0) === 0 ? (
            <Card style={styles.center}>
              <Ionicons name="document-text-outline" size={32} color={colors.textFaint} />
              <Muted style={{ textAlign: 'center' }}>{t('earnings.noPayslips')}</Muted>
            </Card>
          ) : (
            data!.payslips.map((p, idx) => {
              const isOrder = !!(p.bookingId || p.period.startsWith('BK-'));
              return (
                <Pressable key={p.bookingId || `${p.period}-${idx}`} onPress={() => setOpen(p)}>
                  <Card style={styles.payslipRow}>
                    <View style={{ flex: 1, gap: 3 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
                        <Text style={styles.period}>
                          {isOrder ? `Order #${p.bookingId || p.period}` : monthName(p.period, lang)}
                        </Text>
                        {p.clientRating ? (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, backgroundColor: 'rgba(217,119,6,0.15)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 }}>
                            <Ionicons name="star" size={11} color={colors.warning} />
                            <Text style={{ color: colors.warning, fontSize: 11, fontWeight: '700' }}>{p.clientRating}</Text>
                          </View>
                        ) : null}
                      </View>
                      <Muted numberOfLines={1}>
                        {p.serviceName || (isOrder ? 'Security Duty' : `${p.daysPresent} days`)}
                        {p.siteName ? ` · ${p.siteName}` : ''}
                      </Muted>
                      {p.date ? <Text style={{ color: colors.textFaint, fontSize: font.tiny }}>{p.date}</Text> : null}
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: 2 }}>
                      <Text style={styles.net}>{rupees(p.netPaise)}</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <Ionicons name="checkmark-circle" size={12} color={colors.onDuty} />
                        <Text style={[styles.status, { color: colors.onDuty }]}>
                          {t('earnings.paid')}
                        </Text>
                      </View>
                    </View>
                    <Ionicons name="chevron-forward" size={20} color={colors.textFaint} />
                  </Card>
                </Pressable>
              );
            })
          )}
        </>
      )}
    </Screen>
  );
}

/** Net pay, status and reference details modal */
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
  const guard = useAuth((s) => s.guard);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState('');

  const isOrder = !!(payslip.bookingId || payslip.period.startsWith('BK-'));
  const titleLabel = isOrder ? `Order #${payslip.bookingId || payslip.period}` : monthName(payslip.period, lang);

  const openPdf = async () => {
    setPdfBusy(true);
    setPdfError('');
    try {
      const periodParam = payslip.bookingId || payslip.period;
      const r = await api.payslipPdfLink(guardId(guard), periodParam);
      const target = new File(Paths.cache, `payslip-${periodParam}.pdf`);
      if (target.exists) target.delete();
      const file = await File.downloadFileAsync(r.url, target);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, {
          mimeType: 'application/pdf',
          dialogTitle: `${t('earnings.title')} ${titleLabel}`,
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
    titleLabel,
    `${t('earnings.gross')} ${rupees(payslip.grossPaise)}`,
    `${t('earnings.netPay')} ${rupees(payslip.netPaise)}`,
    payslip.status === 'Completed' ? `${t('earnings.paid')} ${payslip.referenceNo}` : t('earnings.notYetPaid'),
  ].join('. ');

  return (
    <Screen>
      <View style={styles.head}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <H2>{titleLabel}</H2>
        <Pressable onPress={speaking ? onStop : () => onRead(spoken)} hitSlop={12}>
          <Ionicons name={speaking ? 'stop-circle' : 'volume-medium'} size={26} color={colors.primary} />
        </Pressable>
      </View>

      <Card style={styles.hero}>
        <Muted>{t('earnings.netPay')}</Muted>
        <Text style={styles.heroValue}>{rupees(payslip.netPaise)}</Text>
        <View style={styles.rowGap}>
          <Ionicons name="checkmark-circle" size={18} color={colors.onDuty} />
          <Text style={[styles.status, { color: colors.onDuty }]}>
            {t('earnings.paidOn')}{' '}
            {payslip.paidOn ? new Date(payslip.paidOn).toLocaleDateString('en-IN') : payslip.date || ''}
          </Text>
        </View>
        {payslip.referenceNo ? <Muted>Reference: {payslip.referenceNo}</Muted> : null}
      </Card>

      {/* Duty details */}
      <View style={styles.chips}>
        <Chip icon="briefcase" label="Service" value={payslip.serviceName || 'Security Guard'} />
        <Chip icon="location" label="Location" value={payslip.siteName ? payslip.siteName.slice(0, 15) : 'On-site'} />
        <Chip icon="cash" label="Net Pay" value={rupees(payslip.netPaise)} />
      </View>

      {/* Client Feedback if available */}
      {payslip.clientRating ? (
        <Card style={{ borderColor: 'rgba(217,119,6,0.3)', backgroundColor: 'rgba(217,119,6,0.08)', gap: space.xs }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={{ color: colors.text, fontWeight: '800', fontSize: font.label }}>Client Review</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
              {Array.from({ length: 5 }).map((_, i) => (
                <Ionicons
                  key={i}
                  name={i < (payslip.clientRating ?? 0) ? 'star' : 'star-outline'}
                  size={14}
                  color={colors.warning}
                />
              ))}
            </View>
          </View>
          {payslip.clientReview ? (
            <Text style={{ color: colors.textMuted, fontSize: font.body, fontStyle: 'italic' }}>
              &quot;{payslip.clientReview}&quot;
            </Text>
          ) : (
            <Muted>5-star verified duty rating</Muted>
          )}
        </Card>
      ) : null}

      {/* Earnings Breakdown */}
      <Muted>{t('earnings.gross')}</Muted>
      <Card>
        {(payslip.earnings ?? []).map((l, i) => (
          <View key={`${l.code || 'earn'}-${i}`} style={styles.lineRow}>
            <Text style={styles.lineLabel}>{l.label || l.code || 'Duty Base Payout'}</Text>
            <Text style={styles.lineValue}>{rupees(l.amountPaise)}</Text>
          </View>
        ))}
        <View style={[styles.lineRow, styles.totalRow]}>
          <Text style={styles.totalLabel}>{t('earnings.gross')}</Text>
          <Text style={styles.totalValue}>{rupees(payslip.grossPaise || payslip.netPaise)}</Text>
        </View>
      </Card>

      {/* PDF Download Button */}
      <Button
        label={pdfBusy ? t('common.loading') : t('earnings.downloadPdf')}
        variant="primary"
        icon={<Ionicons name="download-outline" size={18} color="#000" />}
        onPress={openPdf}
        loading={pdfBusy}
      />
      {pdfError ? <Muted style={{ color: colors.danger, textAlign: 'center' }}>{pdfError}</Muted> : null}
    </Screen>
  );
}

function Chip({ icon, label, value }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string }) {
  return (
    <Card style={styles.chip}>
      <Ionicons name={icon} size={18} color={colors.primary} />
      <Text style={styles.chipValue} numberOfLines={1}>{value}</Text>
      <Muted style={styles.chipLabel} numberOfLines={1}>{label}</Muted>
    </Card>
  );
}

function BarRow({ history }: { history: { period: string; netPaise: number }[] }) {
  const max = Math.max(...history.map((h) => h.netPaise), 1);
  return (
    <Card style={styles.barCard}>
      <View style={styles.barRow}>
        {history.map((h) => {
          const heightPct = Math.max(8, Math.round((h.netPaise / max) * 100));
          return (
            <View key={h.period} style={styles.barCol}>
              <View style={[styles.bar, { height: `${heightPct}%` }]} />
              <Text style={styles.barLabel}>{h.period.slice(5)}</Text>
            </View>
          );
        })}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  hero: { alignItems: 'center', gap: space.xs, paddingVertical: space.xl },
  heroValue: { color: colors.text, fontSize: 36, fontWeight: '900', letterSpacing: -0.5 },
  status: { fontSize: font.label, fontWeight: '700' },
  estimateBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    backgroundColor: colors.warningDim,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  estimateText: { color: colors.warning, fontSize: font.tiny, fontWeight: '700' },
  rowGap: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  chips: { flexDirection: 'row', gap: space.sm },
  chip: { flex: 1, alignItems: 'center', gap: 2, padding: space.sm },
  chipValue: { color: colors.text, fontSize: font.body, fontWeight: '800' },
  chipLabel: { fontSize: font.tiny, textTransform: 'uppercase', letterSpacing: 0.5 },
  offline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.warningDim,
    borderRadius: radius.sm,
    padding: space.md,
  },
  offlineText: { color: colors.warning, fontSize: font.tiny, fontWeight: '700', flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingVertical: space.xxl },
  payslipRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  period: { color: colors.text, fontSize: font.body, fontWeight: '800' },
  net: { color: colors.text, fontSize: font.body, fontWeight: '900' },
  lineRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: space.xs },
  lineLabel: { color: colors.textMuted, fontSize: font.body },
  lineValue: { color: colors.text, fontSize: font.body, fontWeight: '700' },
  totalRow: { borderTopWidth: 1, borderColor: colors.border, marginTop: space.xs, paddingTop: space.sm },
  totalLabel: { color: colors.text, fontSize: font.body, fontWeight: '800' },
  totalValue: { color: colors.text, fontSize: font.body, fontWeight: '900' },
  barCard: { padding: space.md },
  barRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-around', height: 80 },
  barCol: { alignItems: 'center', gap: space.xs, height: '100%', justifyContent: 'flex-end', flex: 1 },
  bar: { width: 14, backgroundColor: colors.primary, borderRadius: 3 },
  barLabel: { color: colors.textMuted, fontSize: font.tiny },
});
