import * as Application from 'expo-application';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { KEYS, secure } from './storage';

/**
 * Device binding (PRD 18.1 §9): one active device per guard account. We derive a stable,
 * app-generated install id (keystore-backed via SecureStore) combined with the platform
 * install id, and send it on auth + every attendance event.
 */
export async function getDeviceId(): Promise<string> {
  const existing = await secure.get(KEYS.deviceId);
  if (existing) return existing;

  let base = '';
  try {
    base =
      Platform.OS === 'android'
        ? Application.getAndroidId() ?? ''
        : (await Application.getIosIdForVendorAsync()) ?? '';
  } catch {
    base = '';
  }
  const uuid = Crypto.randomUUID();
  const id = `${base || 'nodev'}.${uuid}`.slice(0, 64);
  await secure.set(KEYS.deviceId, id);
  return id;
}

export const deviceMeta = {
  model: Device.modelName ?? 'unknown',
  os: `${Device.osName ?? Platform.OS} ${Device.osVersion ?? ''}`.trim(),
  appVersion: Application.nativeApplicationVersion ?? '1.0.0',
};

export type IntegritySignals = {
  is_rooted: boolean;
  is_emulator: boolean;
  developer_mode: boolean;
  app_tampered: boolean;
};

/**
 * Device integrity hints (PRD 18.6 §9).
 *
 * Every one of these is observable from inside the app, which means a determined attacker on a
 * rooted device can suppress them — the PRD says as much (18.6 §14: "client-side checks are
 * treated as hints, never as authority"). They are still worth sending: they cost nothing, they
 * catch the careless majority, and the server weights them lightly and alongside the signals it
 * derives itself.
 *
 * Deliberately *not* a blocker. PRD 18.6 §18: a guard on a rooted phone with a good location and
 * a good face match checks in normally and sees no warning at all — plenty of legitimate budget
 * handsets fail root checks.
 *
 * A genuine Play Integrity verdict needs a native module plus server-side token verification;
 * until that exists these heuristics stand in. Same trade-off as `docs/SOS-NATIVE.md`.
 */
export async function integritySignals(): Promise<IntegritySignals> {
  const [rooted, sideloading] = await Promise.all([
    // Explicitly experimental and known to throw on some OEM builds. Failing to determine
    // rootedness is not evidence of it, so a throw means false.
    Device.isRootedExperimentalAsync().catch(() => false),
    Device.isSideLoadingEnabledAsync().catch(() => false),
  ]);

  return {
    is_rooted: rooted,
    // `isDevice` is false on emulators and simulators. There is no legitimate reason for a
    // guard's attendance to originate from one.
    is_emulator: !Device.isDevice,
    // Not developer mode as such, but the closest thing reachable without native code, and a
    // reasonable corroborating signal rather than a standalone one.
    developer_mode: sideloading,
    // Requires signature verification in native code; always false until that module exists.
    app_tampered: false,
  };
}

/** SHA-256 of a base64 photo payload — tamper evidence for attendance media (PRD 18.5). */
export async function sha256(input: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input);
}

const SIGN_KEY = 'sg.signKey';

/** A per-device signing secret held in the keystore (SecureStore). Created once. */
async function getSigningKey(): Promise<string> {
  const existing = await secure.get(SIGN_KEY);
  if (existing) return existing;
  const key = Crypto.randomUUID() + Crypto.randomUUID();
  await secure.set(SIGN_KEY, key);
  return key;
}

/**
 * Keyed-hash signature over a queued event (PRD 18.15 SUR-GAP-028). Not true HMAC (no native
 * crypto in Expo Go), but a keystore-held-key SHA-256 signature that detects local tampering and
 * can be server-verified once the device key is registered at enrolment.
 */
export async function signEvent(canonical: string): Promise<string> {
  const key = await getSigningKey();
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${key}|${canonical}`);
}
