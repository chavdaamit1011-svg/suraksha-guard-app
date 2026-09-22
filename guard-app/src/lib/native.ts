import { NativeModule, requireOptionalNativeModule } from 'expo';
import { PermissionsAndroid, Platform } from 'react-native';

/**
 * Bridge to `modules/guard-native` (Android only): direct SOS SMS/call, OTP auto-read, NFC.
 *
 * The module exists only in a real build (EAS / APK). In Expo Go, on iOS, or in a build made
 * before the module was added, `GuardNative` is null and every function below reports "not
 * available" so callers fall back to the composer, the dialler, typed OTP entry and QR scanning.
 */

type Events = {
  onSmsCode: (e: { code: string }) => void;
  onSmsTimeout: () => void;
  onNfcTag: (e: { id: string; text: string }) => void;
};

declare class GuardNativeModule extends NativeModule<Events> {
  hasPermission(name: 'sms' | 'call'): boolean;
  sendSmsDirect(phone: string, body: string): Promise<boolean>;
  placeCall(phone: string): Promise<boolean>;
  getAppHash(): string;
  startSmsListener(): Promise<boolean>;
  stopSmsListener(): void;
  nfcStatus(): 'unsupported' | 'disabled' | 'enabled';
  openNfcSettings(): boolean;
  startNfcScan(): boolean;
  stopNfcScan(): void;
  alarmsExact(): boolean;
  scheduleAlarm(id: string, atMs: number, title: string, body: string, url: string, timeoutMs: number): boolean;
  cancelAlarm(id: string): void;
  dismissAlarm(id: string): void;
  scheduledAlarms(): string[];
  showOverLockScreen(on: boolean): boolean;
  detectFaces(uri: string): Promise<FaceScan>;
}

export type FaceScan = {
  count: number;
  width: number;
  height: number;
  faceArea?: number;
  centerX?: number;
  centerY?: number;
  leftEyeOpen?: number | null;
  rightEyeOpen?: number | null;
  headYaw?: number;
  headPitch?: number;
};

/**
 * `ok`, or the one thing to fix. `unchecked` when no detector is available (Expo Go, iOS) —
 * callers then accept the photo, since face matching still happens on the server.
 */
export type FaceVerdict = 'ok' | 'no_face' | 'many_faces' | 'too_small' | 'eyes_closed' | 'turned' | 'unchecked';

export async function checkFace(uri: string): Promise<{ verdict: FaceVerdict; scan: FaceScan | null }> {
  if (!GuardNative) return { verdict: 'unchecked', scan: null };
  try {
    const scan = await GuardNative.detectFaces(uri);
    if (scan.count === 0) return { verdict: 'no_face', scan };
    if (scan.count > 1) return { verdict: 'many_faces', scan };
    if ((scan.faceArea ?? 0) < 0.04) return { verdict: 'too_small', scan };
    const eyes = [scan.leftEyeOpen, scan.rightEyeOpen].filter((v): v is number => typeof v === 'number');
    if (eyes.length === 2 && eyes.every((p) => p < 0.3)) return { verdict: 'eyes_closed', scan };
    if (Math.abs(scan.headYaw ?? 0) > 30 || Math.abs(scan.headPitch ?? 0) > 30) return { verdict: 'turned', scan };
    return { verdict: 'ok', scan };
  } catch {
    return { verdict: 'unchecked', scan: null };
  }
}

const GuardNative: GuardNativeModule | null =
  Platform.OS === 'android' ? requireOptionalNativeModule<GuardNativeModule>('GuardNative') : null;

export const nativeAvailable = GuardNative !== null;

// ------------------------------------------------------------------ SOS

/**
 * Ask once for SEND_SMS and CALL_PHONE, with the reason the guard sees first (PRD 18.1 permission
 * primer). A refusal is fine: the SOS ladder falls back to one-tap composer and dialler.
 */
export async function requestSosPermissions(): Promise<{ sms: boolean; call: boolean }> {
  if (!GuardNative) return { sms: false, call: false };
  try {
    const res = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.SEND_SMS,
      PermissionsAndroid.PERMISSIONS.CALL_PHONE,
    ]);
    return {
      sms: res[PermissionsAndroid.PERMISSIONS.SEND_SMS] === PermissionsAndroid.RESULTS.GRANTED,
      call: res[PermissionsAndroid.PERMISSIONS.CALL_PHONE] === PermissionsAndroid.RESULTS.GRANTED,
    };
  } catch {
    return { sms: false, call: false };
  }
}

export function sosPermissionState(): { sms: boolean; call: boolean; available: boolean } {
  if (!GuardNative) return { sms: false, call: false, available: false };
  try {
    return { sms: GuardNative.hasPermission('sms'), call: GuardNative.hasPermission('call'), available: true };
  } catch {
    return { sms: false, call: false, available: true };
  }
}

/** true only when the message was handed to the radio without any user action. */
export async function sendSmsDirect(phone: string, body: string): Promise<boolean> {
  if (!GuardNative) return false;
  try {
    return await GuardNative.sendSmsDirect(phone, body);
  } catch {
    return false;
  }
}

/** true only when the call was placed without any user action. */
export async function placeCallDirect(phone: string): Promise<boolean> {
  if (!GuardNative) return false;
  try {
    return await GuardNative.placeCall(phone);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ OTP

export function appHash(): string {
  if (!GuardNative) return '';
  try {
    return GuardNative.getAppHash();
  } catch {
    return '';
  }
}

/**
 * Wait for the OTP SMS and hand the code over. Returns a stop function. A no-op where the module
 * is missing — the guard types the code as before.
 */
export function listenForOtp(onCode: (code: string) => void): () => void {
  if (!GuardNative) return () => {};
  const sub = GuardNative.addListener('onSmsCode', (e) => onCode(e.code));
  GuardNative.startSmsListener().catch(() => {});
  return () => {
    sub.remove();
    try {
      GuardNative.stopSmsListener();
    } catch {
      /* ignore */
    }
  };
}

// ------------------------------------------------------------------ wake alarms

/** True when real alarms (alarm stream, full-screen, re-armed after reboot) are available. */
export const nativeAlarms = GuardNative !== null;

export function scheduleNativeAlarm(a: { id: string; at: number; title: string; body: string; url: string; timeoutMs: number }): boolean {
  if (!GuardNative) return false;
  try {
    return GuardNative.scheduleAlarm(a.id, a.at, a.title, a.body, a.url, a.timeoutMs);
  } catch {
    return false;
  }
}

export function cancelNativeAlarm(id: string): void {
  try {
    GuardNative?.cancelAlarm(id);
  } catch {
    /* ignore */
  }
}

export function dismissNativeAlarm(id: string): void {
  try {
    GuardNative?.dismissAlarm(id);
  } catch {
    /* ignore */
  }
}

export function nativeAlarmIds(): string[] {
  try {
    return GuardNative?.scheduledAlarms() ?? [];
  } catch {
    return [];
  }
}

/** Exact alarms allowed (false means Android may delay them — shown on App health). */
export function exactAlarmsAllowed(): boolean | null {
  if (!GuardNative) return null;
  try {
    return GuardNative.alarmsExact();
  } catch {
    return null;
  }
}

export function showOverLockScreen(on: boolean): void {
  try {
    GuardNative?.showOverLockScreen(on);
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------------ NFC

export type NfcState = 'unsupported' | 'disabled' | 'enabled';

export function nfcState(): NfcState {
  if (!GuardNative) return 'unsupported';
  try {
    return GuardNative.nfcStatus();
  } catch {
    return 'unsupported';
  }
}

export function openNfcSettings(): void {
  try {
    GuardNative?.openNfcSettings();
  } catch {
    /* ignore */
  }
}

/**
 * Read tags while the caller is mounted. The checkpoint code is the tag's NDEF text when it has
 * one (agencies write `SGP:…` tokens to tags just like QR), otherwise its hardware id.
 */
export function startNfc(onTag: (code: string, tagId: string) => void): () => void {
  if (!GuardNative) return () => {};
  const sub = GuardNative.addListener('onNfcTag', (e) => onTag((e.text || e.id).trim(), e.id));
  let started = false;
  try {
    started = GuardNative.startNfcScan();
  } catch {
    started = false;
  }
  return () => {
    sub.remove();
    if (started) {
      try {
        GuardNative.stopNfcScan();
      } catch {
        /* ignore */
      }
    }
  };
}
