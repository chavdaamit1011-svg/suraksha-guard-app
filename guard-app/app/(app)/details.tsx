import { goBack } from '@/lib/navigation';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import * as ImageManipulator from 'expo-image-manipulator';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Body, Button, Card, Field, H2, Muted, Screen } from '@/components/ui';
import { FeatureOffNotice } from '@/components/UpdateNotice';
import { useT } from '@/i18n';
import { successFeedback } from '@/lib/feedback';
import { api, ApiError, type ChangeField, type ChangeRequest, type PersonalDetails } from '@/lib/api';
import { captureMedia } from '@/lib/media';
import { guardId, useAuth } from '@/store/auth';
import { useVersion } from '@/store/version';
import { colors, font, radius, space, touch } from '@/theme';

type RowDef = { field: ChangeField; icon: keyof typeof Ionicons.glyphMap; value: (d: PersonalDetails) => string };

const ROWS: RowDef[] = [
  { field: 'name', icon: 'person', value: (d) => d.name },
  { field: 'dob', icon: 'calendar', value: (d) => d.dob },
  { field: 'address', icon: 'home', value: (d) => d.address },
  { field: 'emergencyContact', icon: 'medkit', value: (d) => d.emergencyContact },
  { field: 'bank', icon: 'card', value: (d) => (d.payoutMethod === 'bank' ? d.payout : '') },
  { field: 'upi', icon: 'qr-code', value: (d) => (d.payoutMethod === 'upi' ? d.payout : '') },
];

const LOCKED: ChangeField[] = ['name', 'dob'];
const PAYOUT: ChangeField[] = ['bank', 'upi'];
const RELATIONS = ['spouse', 'parent', 'sibling', 'child', 'friend'] as const;

const STATUS_TONE: Record<ChangeRequest['status'], string> = {
  pending: colors.warning,
  cooling_off: colors.warning,
  approved: colors.onDuty,
  applied: colors.onDuty,
  rejected: colors.danger,
  cancelled: colors.textFaint,
};

type Form = Record<string, string>;

/**
 * My details (PRD 18.11, SUR-GAP-026).
 *
 * Every row says up front what changing it involves — so the guard is never surprised:
 *   name, date of birth   → locked; a request with a document photo goes to the agency
 *   bank account, UPI     → OTP, then a 24-hour wait they can cancel, and payroll is told
 *   address, emergency    → changes at once
 */
export default function Details() {
  const t = useT();
  const router = useRouter();
  const guard = useAuth((s) => s.guard);
  const editOff = useVersion((s) => s.isDisabled('profile_edit'));

  const [details, setDetails] = useState<PersonalDetails | null>(null);
  const [requests, setRequests] = useState<ChangeRequest[]>([]);
  const [coolOffHours, setCoolOffHours] = useState(24);
  const [loadError, setLoadError] = useState(false);

  const [editing, setEditing] = useState<ChangeField | null>(null);
  const [form, setForm] = useState<Form>({});
  const [docUri, setDocUri] = useState<string | null>(null);
  const [otpStage, setOtpStage] = useState(false);
  const [otp, setOtp] = useState('');
  const [devCode, setDevCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [cameraOpen, setCameraOpen] = useState(false);
  const [camPerm, requestCamPerm] = useCameraPermissions();
  const cam = useRef<CameraView>(null);

  const id = guardId(guard);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api.myDetails(id);
      setDetails(r.details);
      setRequests(r.requests ?? []);
      setCoolOffHours(r.rules?.coolOffHours ?? 24);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const openEditor = (field: ChangeField) => {
    setEditing(field);
    setForm({});
    setDocUri(null);
    setOtpStage(false);
    setOtp('');
    setDevCode('');
    setError('');
    setNotice('');
  };

  const set = (k: string) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  /** Build the value the server expects, catching the mistakes worth catching on the device. */
  const buildValue = (): { value: unknown } | { error: string } => {
    switch (editing) {
      case 'name':
        return { value: form.name ?? '' };
      case 'dob': {
        const d = (form.dd ?? '').padStart(2, '0');
        const m = (form.mm ?? '').padStart(2, '0');
        const y = form.yyyy ?? '';
        if (y.length !== 4) return { error: t('details.err_dob') };
        return { value: `${y}-${m}-${d}` };
      }
      case 'address':
        return { value: form.address ?? '' };
      case 'emergencyContact':
        return { value: { name: form.ecName ?? '', phone: form.ecPhone ?? '', relation: form.ecRelation ?? '' } };
      case 'bank':
        if ((form.accountNumber ?? '') !== (form.accountConfirm ?? '')) return { error: t('details.err_accountMismatch') };
        return { value: { accountHolder: form.holder ?? '', accountNumber: form.accountNumber ?? '', ifsc: form.ifsc ?? '' } };
      case 'upi':
        return { value: { vpa: form.vpa ?? '' } };
      default:
        return { error: '' };
    }
  };

  const sendOtp = async () => {
    try {
      const r = await api.sendOtp(guard?.phone ?? '');
      if (__DEV__ && r.devCode) setDevCode(r.devCode);
      setOtpStage(true);
    } catch (e: any) {
      setError(e?.message ?? t('details.err_network'));
    }
  };

  const submit = async () => {
    if (!editing || !id) return;
    const built = buildValue();
    if ('error' in built) return setError(built.error);
    setError('');

    // Payout: OTP first. The code is requested only once the details look right.
    if (PAYOUT.includes(editing) && !otpStage) {
      setBusy(true);
      await sendOtp();
      setBusy(false);
      return;
    }

    setBusy(true);
    try {
      let mediaIds: string[] | undefined;
      if (LOCKED.includes(editing) && docUri) {
        const mediaId = await captureMedia({ guardId: id, uri: docUri, kind: 'document', clientEventUuid: Crypto.randomUUID() });
        if (!mediaId) {
          setError(t('details.err_photoUpload'));
          return;
        }
        mediaIds = [mediaId];
      }

      const res = await api.requestChange({
        guardId: id,
        field: editing,
        value: built.value,
        reason: form.reason?.trim() || undefined,
        mediaIds,
        otp: PAYOUT.includes(editing) ? otp : undefined,
      });
      successFeedback();
      const s = res.request.status;
      setNotice(
        s === 'applied'
          ? t('details.done_applied')
          : s === 'cooling_off'
            ? t('details.done_coolOff', { hours: coolOffHours })
            : t('details.done_pending')
      );
      setEditing(null);
      load();
    } catch (e: any) {
      if (e instanceof ApiError && e.status < 500 && e.status >= 400) {
        const known = e.code ? t(`details.err_${e.code}`) : '';
        setError(known && !known.startsWith('details.') ? known : e.message);
        // A spent or wrong code needs a fresh one; keep the typed details.
        if (e.code === 'otp_expired') setOtpStage(false);
      } else {
        setError(t('details.err_network'));
      }
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (r: ChangeRequest) => {
    try {
      await api.cancelChange(id, r.requestId);
      // "Request accepted…" is no longer true once it is cancelled.
      setNotice('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    } catch {
      /* already settled — the refresh shows it */
    }
    load();
  };

  const takeDocPhoto = async () => {
    try {
      const shot = await cam.current?.takePictureAsync({ quality: 0.7, skipProcessing: true });
      if (!shot?.uri) return;
      const small = await ImageManipulator.manipulateAsync(shot.uri, [{ resize: { width: 1400 } }], {
        compress: 0.7,
        format: ImageManipulator.SaveFormat.JPEG,
      });
      setDocUri(small.uri);
      setCameraOpen(false);
    } catch {
      setCameraOpen(false);
    }
  };

  const openCamera = async () => {
    if (!camPerm?.granted) {
      const p = await requestCamPerm();
      if (!p.granted) return;
    }
    setCameraOpen(true);
  };

  // ------------------------------------------------------------------ editor
  if (editing) {
    const locked = LOCKED.includes(editing);
    const payout = PAYOUT.includes(editing);
    return (
      <Screen>
        <Header title={t(`details.field_${editing}`)} onBack={() => setEditing(null)} />

        <RuleBanner field={editing} hours={coolOffHours} />

        {!otpStage ? (
          <View style={{ gap: space.md }}>
            {editing === 'name' ? <Field label={t('details.newName')} value={form.name} onChangeText={set('name')} autoCapitalize="words" /> : null}

            {editing === 'dob' ? (
              <View style={styles.dobRow}>
                <Field label={t('details.dd')} value={form.dd} onChangeText={set('dd')} keyboardType="number-pad" maxLength={2} style={styles.dobField} />
                <Field label={t('details.mm')} value={form.mm} onChangeText={set('mm')} keyboardType="number-pad" maxLength={2} style={styles.dobField} />
                <Field label={t('details.yyyy')} value={form.yyyy} onChangeText={set('yyyy')} keyboardType="number-pad" maxLength={4} style={styles.dobYear} />
              </View>
            ) : null}

            {editing === 'address' ? (
              <Field label={t('details.newAddress')} value={form.address} onChangeText={set('address')} multiline style={styles.multiline} />
            ) : null}

            {editing === 'emergencyContact' ? (
              <>
                <Field label={t('details.ecName')} value={form.ecName} onChangeText={set('ecName')} autoCapitalize="words" />
                <Field label={t('details.ecPhone')} value={form.ecPhone} onChangeText={set('ecPhone')} keyboardType="phone-pad" maxLength={10} />
                <View style={styles.chips}>
                  {RELATIONS.map((r) => (
                    <Pressable
                      key={r}
                      onPress={() => set('ecRelation')(r)}
                      style={[styles.chip, form.ecRelation === r && styles.chipActive]}
                    >
                      <Text style={[styles.chipText, form.ecRelation === r && { color: colors.onPrimary }]}>{t(`details.rel_${r}`)}</Text>
                    </Pressable>
                  ))}
                </View>
              </>
            ) : null}

            {editing === 'bank' ? (
              <>
                <Field label={t('details.holder')} value={form.holder} onChangeText={set('holder')} autoCapitalize="words" />
                <Field label={t('details.accountNumber')} value={form.accountNumber} onChangeText={set('accountNumber')} keyboardType="number-pad" maxLength={18} secureTextEntry />
                <Field label={t('details.accountConfirm')} value={form.accountConfirm} onChangeText={set('accountConfirm')} keyboardType="number-pad" maxLength={18} />
                <Field label={t('details.ifsc')} value={form.ifsc} onChangeText={(v) => set('ifsc')(v.toUpperCase())} autoCapitalize="characters" maxLength={11} />
              </>
            ) : null}

            {editing === 'upi' ? (
              <Field label={t('details.vpa')} value={form.vpa} onChangeText={set('vpa')} autoCapitalize="none" keyboardType="email-address" placeholder="name@bank" />
            ) : null}

            {locked ? (
              <>
                <Pressable onPress={openCamera} style={styles.docBtn}>
                  {docUri ? (
                    <Image source={{ uri: docUri }} style={styles.docThumb} />
                  ) : (
                    <Ionicons name="document-attach" size={26} color={colors.primary} />
                  )}
                  <Text style={styles.docText}>{docUri ? t('details.docRetake') : t('details.docPhoto')}</Text>
                </Pressable>
                <Field label={t('details.reason')} value={form.reason} onChangeText={set('reason')} multiline style={styles.multiline} />
              </>
            ) : null}
          </View>
        ) : (
          <View style={{ gap: space.md }}>
            <Body>{t('details.otpSent', { phone: guard?.phone ?? '' })}</Body>
            <Field label={t('details.otp')} value={otp} onChangeText={setOtp} keyboardType="number-pad" maxLength={6} autoFocus />
            {devCode ? <Muted>DEV: {devCode}</Muted> : null}
            <Button label={t('details.resendOtp')} variant="ghost" size="small" onPress={sendOtp} />
          </View>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Button
          label={payout && !otpStage ? t('details.continue') : t('details.submit')}
          size="huge"
          onPress={submit}
          loading={busy}
          disabled={busy || (otpStage && otp.length !== 6)}
        />

        <Modal visible={cameraOpen} animationType="slide" onRequestClose={() => setCameraOpen(false)}>
          <View style={{ flex: 1, backgroundColor: '#000' }}>
            <CameraView ref={cam} style={{ flex: 1 }} facing="back" />
            <View style={styles.camFoot}>
              <Button label={t('common.cancel')} variant="ghost" onPress={() => setCameraOpen(false)} />
              <Pressable onPress={takeDocPhoto} style={styles.shutter} />
            </View>
          </View>
        </Modal>
      </Screen>
    );
  }

  // ------------------------------------------------------------------ list
  const openFor = (f: ChangeField) => requests.find((r) => r.field === f && (r.status === 'pending' || r.status === 'cooling_off'));

  return (
    <Screen>
      <Header title={t('details.title')} onBack={() => goBack()} />

      {notice ? (
        <Card style={{ borderColor: colors.onDuty, backgroundColor: colors.onDutyDim }}>
          <Body>{notice}</Body>
        </Card>
      ) : null}

      {editOff ? <FeatureOffNotice /> : null}

      {!details ? (
        <Card style={styles.center}>
          {loadError ? <Muted>{t('details.err_network')}</Muted> : <ActivityIndicator color={colors.primary} />}
          {loadError ? <Button label={t('common.retry')} variant="ghost" size="small" onPress={load} /> : null}
        </Card>
      ) : (
        <Card style={{ padding: space.xs }}>
          {ROWS.map((row) => {
            const open = openFor(row.field);
            const disabled = editOff || !!open;
            return (
              <Pressable
                key={row.field}
                disabled={disabled}
                onPress={() => openEditor(row.field)}
                style={[styles.row, disabled && { opacity: editOff ? 0.5 : 1 }]}
              >
                <Ionicons name={row.icon} size={20} color={colors.primary} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.rowLabel}>{t(`details.field_${row.field}`)}</Text>
                  <Text style={styles.rowValue} numberOfLines={2}>
                    {row.value(details) || t('details.notSet')}
                  </Text>
                  {open ? <Text style={[styles.rowHint, { color: colors.warning }]}>{t(`details.status_${open.status}`)}</Text> : null}
                </View>
                <Ionicons
                  name={LOCKED.includes(row.field) ? 'lock-closed' : PAYOUT.includes(row.field) ? 'shield-checkmark' : 'create'}
                  size={18}
                  color={colors.textFaint}
                />
              </Pressable>
            );
          })}
        </Card>
      )}

      {requests.length > 0 ? (
        <View style={{ gap: space.sm }}>
          <Muted>{t('details.history')}</Muted>
          {requests.map((r) => (
            <Card key={r.requestId} style={{ gap: space.xs }}>
              <View style={styles.rowBetween}>
                <Body style={{ fontWeight: '800' }}>{t(`details.field_${r.field}`)}</Body>
                <Text style={[styles.status, { color: STATUS_TONE[r.status] }]}>{t(`details.status_${r.status}`)}</Text>
              </View>
              <Muted>{r.display}</Muted>
              {r.status === 'cooling_off' && r.effectiveAt ? (
                <Muted style={{ color: colors.warning }}>
                  {t('details.effectiveAt', {
                    when: new Date(r.effectiveAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }),
                  })}
                </Muted>
              ) : null}
              {r.decisionNote ? <Muted>{r.decisionNote}</Muted> : null}
              {r.status === 'pending' || r.status === 'cooling_off' ? (
                <Button
                  label={r.status === 'cooling_off' ? t('details.notMe') : t('details.cancel')}
                  variant={r.status === 'cooling_off' ? 'danger' : 'ghost'}
                  size="small"
                  onPress={() => cancel(r)}
                />
              ) : null}
            </Card>
          ))}
        </View>
      ) : null}
    </Screen>
  );
}

function RuleBanner({ field, hours }: { field: ChangeField; hours: number }) {
  const t = useT();
  const kind = LOCKED.includes(field) ? 'locked' : PAYOUT.includes(field) ? 'payout' : 'contact';
  const icon = kind === 'locked' ? 'lock-closed' : kind === 'payout' ? 'shield-checkmark' : 'flash';
  return (
    <View style={styles.rule}>
      <Ionicons name={icon} size={18} color={colors.primary} />
      <Text style={styles.ruleText}>{t(`details.rule_${kind}`, { hours })}</Text>
    </View>
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

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  center: { alignItems: 'center', gap: space.md, paddingVertical: space.xl },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, minHeight: touch.minTap },
  rowLabel: { color: colors.textMuted, fontSize: font.tiny, fontWeight: '700' },
  rowValue: { color: colors.text, fontSize: font.body, fontWeight: '800' },
  rowHint: { fontSize: font.tiny, fontWeight: '800' },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  status: { fontSize: font.tiny, fontWeight: '900', textTransform: 'uppercase' },
  rule: {
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'flex-start',
    backgroundColor: 'rgba(245,198,35,0.10)',
    borderRadius: radius.sm,
    padding: space.md,
  },
  ruleText: { color: colors.text, fontSize: font.label, flex: 1, lineHeight: 20 },
  dobRow: { flexDirection: 'row', gap: space.sm },
  dobField: { width: 72, textAlign: 'center' },
  dobYear: { width: 110, textAlign: 'center' },
  multiline: { minHeight: 80, textAlignVertical: 'top' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    minHeight: touch.minTap,
    paddingHorizontal: space.lg,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.text, fontSize: font.label, fontWeight: '800' },
  docBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.primary,
    borderRadius: radius.md,
    padding: space.md,
    minHeight: 56,
  },
  docThumb: { width: 56, height: 56, borderRadius: radius.sm },
  docText: { color: colors.text, fontSize: font.body, fontWeight: '700', flex: 1 },
  error: { color: colors.danger, fontWeight: '700' },
  camFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    padding: space.xl,
    backgroundColor: '#000',
  },
  shutter: { width: 76, height: 76, borderRadius: 38, borderWidth: 5, borderColor: '#fff', backgroundColor: 'rgba(255,255,255,0.25)' },
});
