import { API_BASE_URL } from '@/config';
import { KEYS, secure } from '@/lib/storage';

/**
 * The guard's server session (see backend src/lib/guardSession.ts).
 *
 * The OTP login returns a token that every API call now carries as `Authorization: Bearer`.
 * It lasts 7 days and is renewed quietly — before it expires, and once more if the server says
 * it just did — so a guard who uses the app stays signed in indefinitely. Only a real sign-out
 * (logout here, logout on the server, the agency unlinking the phone) sends them back to login.
 *
 * Kept free of imports from api.ts so both can use it.
 */

const RENEW_BEFORE_MS = 24 * 3600_000;

let token = '';
let expiresAt = 0;
let loaded = false;
let renewing: Promise<boolean> | null = null;
let signedOutHandler: (() => void) | null = null;

/** Codes that mean "this login is over", as opposed to "renew and try again". */
const TERMINAL = new Set(['session_required', 'session_invalid', 'session_revoked', 'device_changed']);

export async function loadSession(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await secure.get(KEYS.session);
    if (raw) {
      const s = JSON.parse(raw) as { token: string; expiresAt: number };
      token = s.token ?? '';
      expiresAt = s.expiresAt ?? 0;
    }
  } catch {
    /* no session stored */
  }
}

export async function saveSession(t: string | null | undefined, exp: number | null | undefined): Promise<void> {
  if (!t) return; // a server without sessions configured issues none; keep working without
  token = t;
  expiresAt = exp ?? Date.now() + 7 * 24 * 3600_000;
  loaded = true;
  await secure.set(KEYS.session, JSON.stringify({ token, expiresAt }));
}

export async function clearSession(): Promise<void> {
  token = '';
  expiresAt = 0;
  await secure.del(KEYS.session);
}

export function hasSession(): boolean {
  return !!token;
}

export function authHeader(): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Tell the server to end every session, best effort (used on logout). */
export async function revokeSession(): Promise<void> {
  if (!token) return;
  try {
    await fetch(`${API_BASE_URL}/api/guard/auth/logout`, { method: 'POST', headers: authHeader() });
  } catch {
    /* offline: the local sign-out still happens */
  }
}

export function onSignedOut(fn: () => void): void {
  signedOutHandler = fn;
}

/** Renew the token now. true when a fresh one was stored. Concurrent callers share one request. */
export async function renewSession(): Promise<boolean> {
  await loadSession();
  if (!token) return false;
  if (renewing) return renewing;
  renewing = (async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/guard/auth/refresh`, { method: 'POST', headers: authHeader() });
      const data: any = await res.json().catch(() => ({}));
      if (res.ok && data?.sessionToken) {
        await saveSession(data.sessionToken, data.sessionExpiresAt);
        return true;
      }
      if (res.status === 401 && TERMINAL.has(String(data?.code))) signOut();
      return false;
    } catch {
      return false; // offline — try again later
    } finally {
      renewing = null;
    }
  })();
  return renewing;
}

/** Renew ahead of expiry so a request never has to fail first. */
export async function ensureFreshSession(): Promise<void> {
  await loadSession();
  if (token && expiresAt - Date.now() < RENEW_BEFORE_MS) await renewSession();
}

/**
 * React to a 401 from any call. Returns true when the caller should retry once (the token was
 * only stale and has been renewed).
 */
export async function handleUnauthorized(code: string | undefined): Promise<boolean> {
  if (code === 'session_expired') return renewSession();
  if (code && TERMINAL.has(code)) signOut();
  return false;
}

function signOut() {
  if (!token && !signedOutHandler) return;
  token = '';
  expiresAt = 0;
  secure.del(KEYS.session).catch(() => {});
  signedOutHandler?.();
}
