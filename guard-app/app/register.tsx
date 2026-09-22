import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Button, Card, Field, H1, Muted, Screen } from '@/components/ui';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { deviceMeta, getDeviceId } from '@/lib/device';
import { quickFix } from '@/lib/location';
import { useAuth } from '@/store/auth';
import { colors, space } from '@/theme';

export default function Register() {
  const t = useT();
  const router = useRouter();
  const { phone, ticket } = useLocalSearchParams<{ phone: string; ticket?: string }>();
  const setGuard = useAuth((s) => s.setGuard);

  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [address, setAddress] = useState('');
  const [coords, setCoords] = useState<{ lat?: number; lng?: number }>({});
  const [fromGps, setFromGps] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // GPS over addresses (PRD 18.17.1 rule 6): fill city and address from the fix; the guard only
  // corrects them. Location stays optional — a refusal leaves the fields empty.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return;
        const pos = await quickFix({ accuracy: Location.Accuracy.Balanced, timeoutMs: 8_000 });
        if (!pos || cancelled) return;
        setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        const [place] = await Location.reverseGeocodeAsync(pos.coords).catch(() => []);
        if (!place || cancelled) return;
        const town = place.city || place.subregion || place.district || '';
        // Where Google has no building name, `name` is a plus code ("2MV7+45H"), which means
        // nothing to a guard or a supervisor reading the address (seen on a phone).
        const plusCode = /^[23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{0,3}$/i;
        const line = [place.name, place.street, place.district, place.postalCode]
          .filter((v, i, all) => v && !plusCode.test(v) && all.indexOf(v) === i)
          .join(', ');
        if (town) setCity((c) => c || town);
        if (line) setAddress((a) => a || line);
        if (town || line) setFromGps(true);
      } catch {
        /* location optional at registration */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async () => {
    if (!name.trim() || !city.trim()) return setError(t('register.required'));
    setError('');
    setLoading(true);
    try {
      const res = await api.register({
        phone,
        name: name.trim(),
        city: city.trim(),
        address: address.trim(),
        agencyId: 'suraksha-default',
        registerTicket: ticket,
        deviceId: await getDeviceId(),
        deviceModel: deviceMeta.model,
        ...coords,
      });
      await setGuard(res.guard, { token: res.sessionToken ?? null, expiresAt: res.sessionExpiresAt ?? null });
      router.replace('/enroll');
    } catch (e: any) {
      setError(e.message ?? 'Could not register');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen>
      <H1>{t('register.title')}</H1>
      <Muted>+91 {String(phone ?? '').replace('+91', '')}</Muted>

      {error ? (
        <Card style={{ backgroundColor: colors.dangerDim, borderColor: 'rgba(239,68,68,0.3)' }}>
          <Text style={{ color: colors.danger, fontWeight: '700' }}>{error}</Text>
        </Card>
      ) : null}

      <View style={{ gap: space.lg }}>
        <Field label={t('register.name')} value={name} onChangeText={setName} placeholder="—" autoFocus />
        <Field label={t('register.city')} value={city} onChangeText={setCity} placeholder="—" />
        <Field label={t('register.address')} value={address} onChangeText={setAddress} placeholder="—" multiline />
        {fromGps ? <Muted>{t('register.fromGps')}</Muted> : null}
        <Button label={t('register.submit')} onPress={submit} loading={loading} />
      </View>
    </Screen>
  );
}
