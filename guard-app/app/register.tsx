111import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useRef, useState } from 'react';
import { Modal, Platform, Linking, StyleSheet, Text, TouchableOpacity, View, Image } from 'react-native';
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
  const [aadhaarNumber, setAadhaarNumber] = useState('');
  const [coords, setCoords] = useState<{ lat?: number; lng?: number }>({});
  const [fromGps, setFromGps] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Document upload state
  const [docAadhaar, setDocAadhaar] = useState<string | null>(null);
  const [docPan, setDocPan] = useState<string | null>(null);
  const [docPhoto, setDocPhoto] = useState<string | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [cameraFor, setCameraFor] = useState<'aadhaar' | 'selfie' | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [picking, setPicking] = useState(false);

  // Registration has no guard session yet. Send compressed image bytes, never a
  // file:// or blob: path that only this phone/browser can open.
  const imageData = async (uri: string) => {
    const image = await ImageManipulator.manipulateAsync(uri, [{ resize: { width: 960 } }], {
      compress: 0.65, format: ImageManipulator.SaveFormat.JPEG, base64: true,
    });
    if (!image.base64 || image.base64.length > 1_400_000) throw new Error('Photo is too large. Please take a clearer, smaller photo.');
    return `data:image/jpeg;base64,${image.base64}`;
  };

  const openCamera = (kind: 'aadhaar' | 'selfie') => {
    setCameraFor(kind);
    setCameraReady(false);
    setCameraError('');
    setPreview(null);
    if (!permission?.granted) void requestPermission().catch(() => setCameraError('Could not open the camera. Check camera permission and try again.'));
  };

  const capture = async () => {
    if (!cameraReady || capturing) return;
    setCapturing(true);
    setCameraError('');
    try {
      const shot = await camera.current?.takePictureAsync({ quality: 0.7 });
      if (!shot?.uri) throw new Error('Camera did not return a photo. Please try again.');
      setPreview(await imageData(shot.uri));
    } catch (e: any) {
      setCameraError(e.message || 'Could not capture photo. Please try again.');
    } finally { setCapturing(false); }
  };

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
    if (picking || loading) return;
    setPicking(true);
    setError('');
    try {
      // Call the web picker directly from the tap so browsers retain user activation.
      if (Platform.OS !== 'web') {
        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (status !== 'granted') throw new Error('Gallery permission is required to select documents.');
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'], quality: 0.7, allowsEditing: false,
      });
      if (!result.canceled && result.assets?.[0]?.uri) setter(await imageData(result.assets[0].uri));
    } catch (e: any) { setError(e.message || 'Could not select document. Please try again.'); }
    finally { setPicking(false); }
  };

  const submit = async () => {
    if (loading || picking) return;
    if (!name.trim() || !city.trim()) return setError('Name and city are required.');
    if (!/^[2-9]\d{11}$/.test(aadhaarNumber)) return setError('Enter a valid 12-digit Aadhaar number.');
    if (!docAadhaar) return setError('Please upload your Aadhaar card.');
    setError('');
    setLoading(true);
    try {
      await api.register({
        phone,
        name: name.trim(),
        city: city.trim(),
        address: address.trim(),
        aadhaarNumber,
        agencyId: '',
        registerTicket: ticket,
        docAadhaar,
        docPan: docPan ?? '',
        docPhoto: docPhoto ?? '',
        selfieUrl: docPhoto ?? '',
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
          <Field label={t('register.name')} value={name} onChangeText={setName} placeholder="—" autoFocus />
          <Field label={t('register.city')} value={city} onChangeText={setCity} placeholder="—" />
          <Field label={t('register.address')} value={address} onChangeText={setAddress} placeholder="—" multiline />
          {fromGps ? <Muted>{t('register.fromGps')}</Muted> : null}

          {/* Document Uploads */}
          <Text style={styles.sectionLabel}>DOCUMENTS</Text>
          <Field label="Aadhaar number *" value={aadhaarNumber} onChangeText={value => setAadhaarNumber(value.replace(/\D/g, '').slice(0, 12))}
            placeholder="12-digit Aadhaar number" keyboardType="number-pad" maxLength={12} />

          <DocUploadRow
            label="Aadhaar Card *"
            uri={docAadhaar}
            onPress={() => openCamera('aadhaar')}
            camera
            disabled={loading || picking}
          />
          <Button label="Choose Aadhaar image from gallery" variant="ghost" size="small" onPress={() => pickDocument(setDocAadhaar)} disabled={loading || picking} />
          <DocUploadRow
            label="PAN Card (optional)"
            uri={docPan}
            onPress={() => pickDocument(setDocPan)}
            disabled={loading || picking}
          />
          <DocUploadRow
            label="Live selfie (optional)"
            uri={docPhoto}
            onPress={() => openCamera('selfie')}
            camera
            disabled={loading || picking}
          />

          <Button label={t('register.submit')} onPress={submit} loading={loading} disabled={picking} />
        </View>
      <Modal visible={cameraFor !== null} animationType="slide" onRequestClose={() => { if (!capturing) setCameraFor(null); }}>
        <Screen>
          <H1>{cameraFor === 'selfie' ? 'Take your selfie' : 'Capture Aadhaar card'}</H1>
          <Muted>{cameraFor === 'selfie' ? 'Look at the camera and keep your face clearly visible.' : 'Keep the entire card inside the camera view.'}</Muted>
          {cameraError ? <Text style={{ color: colors.danger }}>{cameraError}</Text> : null}
          {preview ? (
            <>
              <Image source={{ uri: preview }} style={styles.cameraPreview} resizeMode="contain" />
              <Button label="Use this photo" onPress={() => {
                (cameraFor === 'selfie' ? setDocPhoto : setDocAadhaar)(preview);
                setCameraFor(null);
                setPreview(null);
              }} />
              <Button label="Retake photo" variant="ghost" onPress={() => { setPreview(null); setCameraReady(false); }} />
            </>
          ) : cameraFor && permission?.granted ? (
            <>
              <View style={styles.cameraPreview}>
                <CameraView ref={camera} style={{ flex: 1 }} facing={cameraFor === 'selfie' ? 'front' : 'back'}
                  onCameraReady={() => setCameraReady(true)} onMountError={() => { setCameraReady(false); setCameraError('Camera could not start. Close other camera apps, check browser permissions, and reopen the camera.'); }} />
              </View>
              <Button label="Capture photo" onPress={capture} loading={capturing} disabled={!cameraReady || capturing} />
            </>
          ) : (
            <>
              <Muted>Allow camera access to take a photo. In a browser, enable Camera in this site's permissions.</Muted>
              <Button label="Allow camera" onPress={() => {
                if (Platform.OS !== 'web' && permission?.canAskAgain === false) void Linking.openSettings();
                else void requestPermission().catch(() => setCameraError('Could not request camera permission.'));
              }} />
            </>
          )}
          <Button label="Back to form" variant="ghost" disabled={capturing} onPress={() => setCameraFor(null)} />
        </Screen>
      </Modal>
    </Screen>
  );
}

function DocUploadRow({ label, uri, onPress, camera, disabled }: { label: string; uri: string | null; onPress: () => void; camera?: boolean; disabled?: boolean }) {
  return (
    <TouchableOpacity style={styles.docRow} onPress={onPress} activeOpacity={0.75} disabled={disabled} accessibilityRole="button" accessibilityLabel={label}>
      <View style={styles.docLeft}>
        <View style={styles.docIcon}>
          <Ionicons name={uri ? 'checkmark-circle' : camera ? 'camera-outline' : 'cloud-upload-outline'} size={22} color={uri ? colors.primary : colors.textFaint} />
        </View>
        <View>
          <Text style={styles.docLabel}>{label}</Text>
          <Text style={styles.docSub}>{uri ? 'Photo ready · Tap to replace' : camera ? 'Tap to open camera' : 'Tap to select image'}</Text>
        </View>
      </View>
      {uri ? (
        <Image source={{ uri }} style={styles.docThumb} resizeMode="cover" />
      ) : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  cameraPreview: { width: '100%', height: 360, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.card },
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
