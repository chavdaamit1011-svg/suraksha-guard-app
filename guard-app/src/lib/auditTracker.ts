import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const STORAGE_KEY_HANDLED = 'suraksha_handled_audit_ids';
const STORAGE_KEY_COMPLETED = 'suraksha_completed_audit_ids';

const memoryHandled = new Set<string>();
const memoryCompleted = new Set<string>();

// Pre-load on startup
if (Platform.OS === 'web' && typeof window !== 'undefined') {
  try {
    const rawH = window.localStorage?.getItem(STORAGE_KEY_HANDLED);
    if (rawH) {
      const arr = JSON.parse(rawH);
      if (Array.isArray(arr)) arr.forEach((id) => memoryHandled.add(String(id)));
    }
    const rawC = window.localStorage?.getItem(STORAGE_KEY_COMPLETED);
    if (rawC) {
      const arr = JSON.parse(rawC);
      if (Array.isArray(arr)) arr.forEach((id) => memoryCompleted.add(String(id)));
    }
  } catch {}
} else {
  AsyncStorage.getItem(STORAGE_KEY_HANDLED).then((raw) => {
    if (raw) {
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) arr.forEach((id) => memoryHandled.add(String(id)));
      } catch {}
    }
  }).catch(() => {});

  AsyncStorage.getItem(STORAGE_KEY_COMPLETED).then((raw) => {
    if (raw) {
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) arr.forEach((id) => memoryCompleted.add(String(id)));
      } catch {}
    }
  }).catch(() => {});
}

/**
 * Check if this audit has already been triggered / opened on this device/browser
 */
export function isAuditAlreadyHandled(wakeId: string | undefined | null): boolean {
  if (!wakeId) return false;
  const id = String(wakeId).trim();
  if (!id) return false;

  if (memoryHandled.has(id)) return true;

  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    try {
      if (window.sessionStorage?.getItem(`wake_handled_${id}`)) return true;
      if (window.localStorage?.getItem(`wake_handled_${id}`)) return true;
    } catch {}
  }

  return false;
}

/**
 * Mark this audit as handled so it NEVER triggers or opens again on refresh or poll
 */
export function markAuditAsHandled(wakeId: string | undefined | null): void {
  if (!wakeId) return;
  const id = String(wakeId).trim();
  if (!id) return;

  memoryHandled.add(id);

  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    try {
      window.sessionStorage?.setItem(`wake_handled_${id}`, '1');
      window.localStorage?.setItem(`wake_handled_${id}`, '1');
      const list = Array.from(memoryHandled).slice(-50);
      window.localStorage?.setItem(STORAGE_KEY_HANDLED, JSON.stringify(list));
    } catch {}
  }

  try {
    AsyncStorage.getItem(STORAGE_KEY_HANDLED).then((raw) => {
      const list: string[] = raw ? JSON.parse(raw) : [];
      if (!list.includes(id)) {
        list.push(id);
        if (list.length > 50) list.shift();
        AsyncStorage.setItem(STORAGE_KEY_HANDLED, JSON.stringify(list)).catch(() => {});
      }
    }).catch(() => {});
  } catch {}
}

/**
 * Check if the guard has already submitted or completed this audit
 */
export function isAuditCompleted(wakeId: string | undefined | null): boolean {
  if (!wakeId) return false;
  const id = String(wakeId).trim();
  if (!id) return false;

  if (memoryCompleted.has(id)) return true;

  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    try {
      if (window.sessionStorage?.getItem(`wake_completed_${id}`)) return true;
      if (window.localStorage?.getItem(`wake_completed_${id}`)) return true;
    } catch {}
  }

  return false;
}

/**
 * Mark this audit as completed (selfie submitted or timed out)
 */
export function markAuditCompleted(wakeId: string | undefined | null): void {
  if (!wakeId) return;
  const id = String(wakeId).trim();
  if (!id) return;

  memoryCompleted.add(id);
  markAuditAsHandled(id);

  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    try {
      window.sessionStorage?.setItem(`wake_completed_${id}`, '1');
      window.localStorage?.setItem(`wake_completed_${id}`, '1');
      const list = Array.from(memoryCompleted).slice(-50);
      window.localStorage?.setItem(STORAGE_KEY_COMPLETED, JSON.stringify(list));
    } catch {}
  }

  try {
    AsyncStorage.getItem(STORAGE_KEY_COMPLETED).then((raw) => {
      const list: string[] = raw ? JSON.parse(raw) : [];
      if (!list.includes(id)) {
        list.push(id);
        if (list.length > 50) list.shift();
        AsyncStorage.setItem(STORAGE_KEY_COMPLETED, JSON.stringify(list)).catch(() => {});
      }
    }).catch(() => {});
  } catch {}
}

/**
 * Detect whether the current page load on web was caused by a browser refresh (F5/Reload)
 */
export function isWebBrowserReload(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  try {
    const navEntries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
    if (navEntries && navEntries.length > 0) {
      return navEntries[0].type === 'reload';
    }
    return (performance as any)?.navigation?.type === 1;
  } catch {
    return false;
  }
}
