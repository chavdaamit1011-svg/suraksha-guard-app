import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View, Image } from 'react-native';
import { Button, Card, Field, H1, Muted, Screen } from '@/components/ui';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { quickFix } from '@/lib/location';
import { colors, font, radius, space } from '@/theme';

export default function Register() {
  const t = useT();
  const router = useRouter();
  const { phone, ticket } = useLocalSearchParams<{ phone: string; ticket?: string }>();

  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [address, setAddress] = useState('');
  const [coords, setCoords] = useState<{ lat?: number; lng?: number }>({});
  const [fromGps, setFromGps] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Document upload state
  const [docAadhaar, setDocAadhaar] = useState<string | null>(null);
  const [docPan, setDocPan] = useState<string | null>(null);
  const [docPhoto, setDocPhoto] = useState<string | null>(null);

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
    return () => { cancelled = true; };
  }, []);

  const pickDocument = async (setter: (uri: string) => void) => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      setError('Gallery permission is required to upload documents.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
      allowsEditing: false,
    });
    if (!result.canceled && result.assets?.[0]?.uri) {
      setter(result.assets[0].uri);
    }
  };

  const submit = async () => {
    if (!name.trim() || !city.trim()) return setError('Name and city are required.');
    if (!docAadhaar) return setError('Please upload your Aadhaar card.');
    setError('');
    setLoading(true);
    try {
      await api.register({
        phone,
        name: name.trim(),
        city: city.trim(),
        address: address.trim(),
        agencyId: '',
        registerTicket: ticket,
        docAadhaar,
        docPan: docPan ?? '',
        docPhoto: docPhoto ?? '',
        ...coords,
      });
      // Registration submitted — waiting for OPS approval
      router.replace('/pending-approval');
    } catch (e: any) {
      setError(e.message ?? 'Could not submit registration');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: space.lg, paddingBottom: space.xxl }}>
        <View>
          <H1>{t('register.title')}</H1>
          <Muted>+91 {String(phone ?? '').replace('+91', '')}</Muted>
        </View>

        {error ? (
          <Card style={{ backgroundColor: colors.dangerDim, borderColor: 'rgba(239,68,68,0.3)' }}>
            <Text style={{ color: colors.danger, fontWeight: '700' }}>{error}</Text>
          </Card>
        ) : null}

        <View style={{ gap: space.lg }}>
          <Field label={t('register.name')} value={name} onChangeText={setName} placeholder="Full name" autoFocus />
          <Field label={t('register.city')} value={city} onChangeText={setCity} placeholder="City" />
          <Field label={t('register.address')} value={address} onChangeText={setAddress} placeholder="Home address" multiline />
          {fromGps ? <Muted>{t('register.fromGps')}</Muted> : null}

          {/* Document Uploads */}
          <Text style={styles.sectionLabel}>DOCUMENTS</Text>

          <DocUploadRow
            label="Aadhaar Card *"
            uri={docAadhaar}
            onPress={() => pickDocument(setDocAadhaar)}
          />
          <DocUploadRow
            label="PAN Card (optional)"
            uri={docPan}
            onPress={() => pickDocument(setDocPan)}
          />
          <DocUploadRow
            label="Photo ID / Selfie (optional)"
            uri={docPhoto}
            onPress={() => pickDocument(setDocPhoto)}
          />

          <Button label={t('register.submit')} onPress={submit} loading={loading} />
        </View>
      </ScrollView>
    </Screen>
  );
}

function DocUploadRow({ label, uri, onPress }: { label: string; uri: string | null; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.docRow} onPress={onPress} activeOpacity={0.75}>
      <View style={styles.docLeft}>
        <View style={styles.docIcon}>
          <Ionicons name={uri ? 'checkmark-circle' : 'cloud-upload-outline'} size={22} color={uri ? colors.primary : colors.textFaint} />
        </View>
        <View>
          <Text style={styles.docLabel}>{label}</Text>
          <Text style={styles.docSub}>{uri ? 'Uploaded ✓' : 'Tap to upload'}</Text>
        </View>
      </View>
      {uri ? (
        <Image source={{ uri }} style={styles.docThumb} resizeMode="cover" />
      ) : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  sectionLabel: {
    color: colors.textFaint,
    fontSize: font.tiny,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  docRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
  },
  docLeft: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flex: 1 },
  docIcon: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(245,198,35,0.08)',
    alignItems: 'center', justifyContent: 'center',
  },
  docLabel: { color: colors.text, fontWeight: '600', fontSize: font.label },
  docSub: { color: colors.textFaint, fontSize: font.tiny, marginTop: 2 },
  docThumb: { width: 48, height: 48, borderRadius: radius.sm },
});
