import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { Body, Button, Card, H1, Muted, Screen } from '@/components/ui';
import { useT } from '@/i18n';
import { api, e164 } from '@/lib/api';
import { deviceMeta, getDeviceId } from '@/lib/device';
import { appHash, listenForOtp } from '@/lib/native';
import { useAuth } from '@/store/auth';
import { colors, font, radius, space } from '@/theme';

import { KEYS, secure } from '@/lib/storage';

export default function Login() {
  const t = useT();
  const router = useRouter();
  const guard = useAuth((s) => s.guard);
  const hydrated = useAuth((s) => s.hydrated);
  const needsPin = useAuth((s) => s.needsPin);
  const setGuard = useAuth((s) => s.setGuard);
  const hasPin = useAuth((s) => s.hasPin);

  const [step, setStep] = useState<'PHONE' | 'OTP'>('PHONE');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [savedAccount, setSavedAccount] = useState<{ phone: string; name?: string; city?: string; empId?: string } | null>(null);

  useEffect(() => {
    if (hydrated && guard) {
      router.replace(needsPin ? '/pin?mode=enter' : '/home');
    }
  }, [hydrated, guard, needsPin, router]);

  useEffect(() => {
    secure.get(KEYS.savedAccount).then((val) => {
      if (val) {
        try {
          const parsed = JSON.parse(val);
          if (parsed?.phone) {
            setSavedAccount(parsed);
            setPhone(parsed.phone);
          }
        } catch {}
      }
    }).catch(() => {});
  }, []);

  const stopOtpListener = useRef<() => void>(() => {});
  useEffect(() => () => stopOtpListener.current(), []);

  const sendOtp = async () => {
    if (phone.length < 10) return setError(t('login.invalidNumber'));
    setError('');
    setLoading(true);
    // SMS Retriever must be listening before the message arrives (PRD 18.1: auto-read, so the
    // guard types nothing beyond the phone number). Where the native module is missing this is a
    // no-op and the code is typed as before.
    stopOtpListener.current();
    stopOtpListener.current = listenForOtp((code) => {
      setOtp(code);
      verify(code);
    });
    try {
      const res = await api.sendOtp(phone, appHash());
      // Dev convenience: if no SMS gateway is configured the backend returns the code — prefill it.
      if (res.devCode) setOtp(res.devCode);
      setStep('OTP');
    } catch (e: any) {
      setError(e.message ?? 'Could not send OTP');
    } finally {
      setLoading(false);
    }
  };

  const verify = async (auto?: string) => {
    const code = auto ?? otp;
    if (code.length !== 6) return setError(t('login.invalidOtp'));
    stopOtpListener.current();
    setError('');
    setLoading(true);
    try {
      const device = { deviceId: await getDeviceId(), deviceModel: deviceMeta.model };
      const res = await api.verifyOtp(phone, code, device);
      if (res.exists && res.guard) {
        await setGuard(res.guard, { token: res.sessionToken ?? null, expiresAt: res.sessionExpiresAt ?? null });
        if (res.deviceStatus === 'change_pending') {
          // Duty data is withheld until an Operations Manager approves the device change (PRD 18.6).
          setError(t('login.devicePending'));
        }
        router.replace(hasPin ? '/home' : '/pin?mode=set');
      } else {
        // The ticket proves this phone's OTP; registration refuses without it.
        const ticket = res.registerTicket ? `&ticket=${encodeURIComponent(res.registerTicket)}` : '';
        router.replace(`/register?phone=${encodeURIComponent(e164(phone))}${ticket}`);
      }
    } catch (e: any) {
      setError(e.message ?? t('login.invalidOtp'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen>
      <View style={styles.header}>
        <View style={styles.badge}>
          <Ionicons name="shield-checkmark" size={36} color={colors.primary} />
        </View>
        <H1>{t('login.title')}</H1>
        <Muted style={{ textAlign: 'center' }}>{t('login.subtitle')}</Muted>
      </View>

      {error ? (
        <Card style={{ backgroundColor: colors.dangerDim, borderColor: 'rgba(239,68,68,0.3)' }}>
          <Text style={{ color: colors.danger, fontWeight: '700', textAlign: 'center' }}>{error}</Text>
        </Card>
      ) : null}

      {step === 'PHONE' ? (
        <View style={{ gap: space.lg }}>
          {savedAccount ? (
            <Card
              style={{
                backgroundColor: 'rgba(245,198,35,0.08)',
                borderColor: 'rgba(245,198,35,0.3)',
                padding: space.md,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <View style={{ gap: 2, flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
                    <Ionicons name="person-circle-outline" size={16} color={colors.primary} />
                    <Text style={{ color: colors.primary, fontSize: font.tiny, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      Saved Account
                    </Text>
                  </View>
                  <Text style={{ color: colors.text, fontSize: font.body, fontWeight: '800' }}>
                    {savedAccount.name || 'Guard'}
                  </Text>
                  <Text style={{ color: colors.textMuted, fontSize: font.label }}>
                    +91 {savedAccount.phone} {savedAccount.city ? `• ${savedAccount.city}` : ''}
                  </Text>
                </View>
                <Button
                  label="Use This"
                  size="small"
                  variant="primary"
                  onPress={() => {
                    setPhone(savedAccount.phone);
                  }}
                />
              </View>
            </Card>
          ) : null}

          <View style={{ gap: space.xs }}>
            <Text style={styles.label}>{t('login.mobile')}</Text>
            <View style={styles.phoneRow}>
              <Text style={styles.prefix}>+91</Text>
              <TextInput
                value={phone}
                onChangeText={(v) => setPhone(v.replace(/\D/g, '').slice(0, 10))}
                keyboardType="number-pad"
                placeholder={t('login.enterNumber')}
                placeholderTextColor={colors.textFaint}
                style={styles.phoneInput}
                autoFocus={!savedAccount}
              />
            </View>
          </View>
          <Button label={t('login.sendOtp')} onPress={sendOtp} loading={loading} disabled={phone.length < 10} />
        </View>
      ) : (
        <View style={{ gap: space.lg }}>
          <View style={{ alignItems: 'center', gap: 2 }}>
            <Muted>{t('login.sentTo')}</Muted>
            <Body style={{ color: colors.primary, fontWeight: '800' }}>+91 {phone}</Body>
          </View>
          <TextInput
            value={otp}
            onChangeText={(v) => setOtp(v.replace(/\D/g, '').slice(0, 6))}
            keyboardType="number-pad"
            placeholder="------"
            placeholderTextColor={colors.textFaint}
            style={styles.otpInput}
            autoFocus
            // Lets the keyboard / autofill offer the code from the SMS where Retriever is absent.
            autoComplete="sms-otp"
            textContentType="oneTimeCode"
          />
          <Button label={t('login.verify')} onPress={() => verify()} loading={loading} disabled={otp.length !== 6} />
          <Button label={t('login.changeNumber')} variant="ghost" size="small" onPress={() => { setStep('PHONE'); setOtp(''); setError(''); }} />
        </View>
      )}

      <View style={styles.footer}>
        <Ionicons name="lock-closed" size={12} color={colors.textFaint} />
        <Muted>{t('login.secured')}</Muted>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', gap: space.sm, marginTop: space.xl },
  badge: {
    width: 64, height: 64, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(245,198,35,0.1)', borderWidth: 1, borderColor: 'rgba(245,198,35,0.2)', marginBottom: space.sm,
  },
  label: { color: colors.textFaint, fontSize: font.tiny, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  phoneRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.4)', borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: space.lg },
  prefix: { color: colors.textMuted, fontWeight: '800', fontSize: font.body },
  phoneInput: { flex: 1, color: colors.text, fontSize: font.body, paddingVertical: space.md, paddingLeft: space.sm, minHeight: 52 },
  otpInput: {
    backgroundColor: 'rgba(0,0,0,0.4)', borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    color: colors.text, fontSize: 34, fontWeight: '900', letterSpacing: 12, textAlign: 'center', paddingVertical: space.lg,
  },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs, marginTop: space.xxl, opacity: 0.7 },
});
