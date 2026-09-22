import AsyncStorage from '@react-native-async-storage/async-storage';
import { gcm } from '@noble/ciphers/aes.js';
import { bytesToUtf8, utf8ToBytes } from '@noble/ciphers/utils.js';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

/**
 * Encrypted local store (PRD 18.15.1, SUR-GAP-028).
 *
 *   > The local store is encrypted (SQLCipher or platform equivalent) with a key held in the
 *   > hardware keystore, released on PIN/biometric unlock.
 *
 * React Native has no SQLCipher in the managed runtime, so this is the platform equivalent:
 * AES-256-GCM over each stored value, with the key held in `expo-secure-store` — which is backed
 * by the Android Keystore and the iOS Keychain. GCM rather than CBC because it authenticates as
 * well as encrypts: a guard who edits the ciphertext to fabricate a check-in gets a decryption
 * failure, not a plausible forgery.
 *
 * What this protects: the queued events and the cached duty bundle on a lost, stolen or rooted
 * handset. It carries a guard's movements for the last several days, which is exactly the kind of
 * personal data §39 requires be held carefully.
 *
 * What it does not protect against: an attacker who has already unlocked the phone *and* the
 * keystore. Nothing on the device can, which is why tamper-evidence lives server-side too
 * (per-event signatures and `capture_sequence_no` gaps, PRD 18.15.6).
 */

const KEY_NAME = 'sg.storeKey.v1';
/** Prefix on the stored string so a plaintext value written by an older build is still readable. */
const MAGIC = 'sgenc1:';

let cachedKey: Uint8Array | null = null;

/**
 * Base64 without `btoa`/`atob`. Those are host globals that Hermes does not guarantee, and a
 * missing global here would mean the guard's queued duty records silently fail to persist — the
 * kind of failure that only shows up on the one handset nobody tested.
 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[b2 & 63] : '=';
  }
  return out;
}

const B64_INDEX: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) B64_INDEX[B64[i]] = i;

function b64decode(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let p = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64_INDEX[clean[i]];
    if (v === undefined) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[p++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, p);
}

/**
 * The 256-bit data key, created once and held in the platform keystore thereafter.
 *
 * SecureStore is used directly rather than through `storage.ts` to avoid an import cycle: this
 * module is what `storage.ts` delegates its bulk writes to.
 */
async function getKey(): Promise<Uint8Array | null> {
  if (cachedKey) return cachedKey;
  try {
    const existing = await SecureStore.getItemAsync(KEY_NAME);
    if (existing) {
      cachedKey = b64decode(existing);
      return cachedKey;
    }
    const fresh = Crypto.getRandomBytes(32);
    await SecureStore.setItemAsync(KEY_NAME, b64encode(fresh));
    cachedKey = fresh;
    return cachedKey;
  } catch {
    // No keystore (a device with a broken secure enclave, or a web build). Returning null makes
    // the store fall back to plaintext rather than losing the guard's queued duty records —
    // PRD 18.17.1 rule 12: nothing blocks duty.
    return null;
  }
}

async function encrypt(plain: string): Promise<string> {
  const key = await getKey();
  if (!key) return plain;
  // A fresh 96-bit nonce per write. Reusing one under the same key would be catastrophic for GCM.
  const nonce = Crypto.getRandomBytes(12);
  const ct = gcm(key, nonce).encrypt(utf8ToBytes(plain));
  return `${MAGIC}${b64encode(nonce)}.${b64encode(ct)}`;
}

async function decrypt(stored: string): Promise<string | null> {
  if (!stored.startsWith(MAGIC)) return stored; // written before encryption was introduced
  const key = await getKey();
  if (!key) return null;
  try {
    const [nonceB64, ctB64] = stored.slice(MAGIC.length).split('.');
    const plain = gcm(key, b64decode(nonceB64)).decrypt(b64decode(ctB64));
    return bytesToUtf8(plain);
  } catch {
    // Tampered, truncated, or written under a key that has since been replaced (a reinstall
    // clears the keystore on some OEMs). Unreadable is unreadable; the caller uses its fallback.
    return null;
  }
}

/**
 * Drop-in replacement for the plain `store` in `storage.ts`, with the same shape so call sites do
 * not branch. Values written by an earlier build are read back transparently and re-encrypted on
 * the next write.
 */
export const encryptedStore = {
  async getJSON<T>(key: string, fallback: T): Promise<T> {
    try {
      const raw = await AsyncStorage.getItem(key);
      if (!raw) return fallback;
      const plain = await decrypt(raw);
      if (plain === null) return fallback;
      return JSON.parse(plain) as T;
    } catch {
      return fallback;
    }
  },

  async setJSON(key: string, value: unknown) {
    try {
      await AsyncStorage.setItem(key, await encrypt(JSON.stringify(value)));
    } catch {
      /* storage full or unavailable — the caller cannot do anything useful about it */
    }
  },

  async del(key: string) {
    try {
      await AsyncStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

/**
 * Wipe the data key. Called on logout so the queued events and cached duty bundle left on the
 * device become unreadable even if the files survive (PRD 18.15.1 / §39).
 */
export async function destroyStoreKey() {
  cachedKey = null;
  await SecureStore.deleteItemAsync(KEY_NAME).catch(() => {});
}

/** Whether values are actually being encrypted — surfaced on App health rather than assumed. */
export async function encryptionActive(): Promise<boolean> {
  return (await getKey()) !== null;
}
