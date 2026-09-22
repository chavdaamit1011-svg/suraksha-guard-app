/**
 * Guard app sessions.
 *
 * Until now every guard API trusted the `guardId` the request carried, so anyone who knew a
 * guard's id could read their pay, mark their attendance or change their bank account. After an
 * OTP login the server now issues a signed session token; the app sends it as
 * `Authorization: Bearer <token>`, and `src/proxy.ts` checks it against the `guardId` (or
 * `supervisorId`) the request names before any guard route runs.
 *
 * Tokens are stateless HMAC-SHA256 (Web Crypto, so the proxy can use them too):
 *   payload { t: 'session', g: guardId, d: deviceId, v: sessionVersion, iat, exp }
 *   payload { t: 'register', p: phone, iat, exp }   — proves OTP for a phone with no guard yet
 *
 * A session lives 7 days and is renewed by `/api/guard/auth/refresh`, which accepts a token up to
 * 90 days old and checks the guard's current `sessionVersion` — logging out (or an agency revoking
 * the device) bumps that version, so a stolen token stops renewing.
 *
 * Rollout: with GUARD_REQUIRE_SESSION unset, requests *without* a token still pass (apps already
 * installed keep working) but a token that names a different guard is always refused. Set
 * GUARD_REQUIRE_SESSION=1 once every guard runs a build that sends tokens.
 */

export const SESSION_TTL_SEC = 7 * 24 * 3600;
export const REFRESH_WINDOW_SEC = 90 * 24 * 3600;
export const REGISTER_TTL_SEC = 30 * 60;

export type SessionPayload = { t: 'session'; g: string; d: string; v: number; iat: number; exp: number };
export type RegisterPayload = { t: 'register'; p: string; iat: number; exp: number };
type AnyPayload = SessionPayload | RegisterPayload;

function secret(): string {
  return process.env.GUARD_SESSION_SECRET || process.env.GUARD_LINK_SECRET || process.env.GUARD_ADMIN_KEY || '';
}

export function sessionsEnabled(): boolean {
  return secret().length >= 16;
}

export function sessionRequired(): boolean {
  return process.env.GUARD_REQUIRE_SESSION === '1';
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

async function hmac(data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function sign(payload: AnyPayload): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `sg1.${body}.${b64url(await hmac(body))}`;
}

/** Signature check only; expiry is the caller's decision (refresh accepts older tokens). */
async function open(token: string): Promise<AnyPayload | null> {
  if (!sessionsEnabled() || !token.startsWith('sg1.')) return null;
  const [, body, sig] = token.split('.');
  if (!body || !sig) return null;
  try {
    if (!sameBytes(fromB64url(sig), await hmac(body))) return null;
    return JSON.parse(new TextDecoder().decode(fromB64url(body)));
  } catch {
    return null;
  }
}

const now = () => Math.floor(Date.now() / 1000);

export async function issueSession(guardId: string, deviceId: string, version: number): Promise<{ token: string; expiresAt: number } | null> {
  if (!sessionsEnabled()) return null;
  const iat = now();
  const exp = iat + SESSION_TTL_SEC;
  return { token: await sign({ t: 'session', g: guardId, d: deviceId, v: version, iat, exp }), expiresAt: exp * 1000 };
}

export async function issueRegisterTicket(phone: string): Promise<string | null> {
  if (!sessionsEnabled()) return null;
  const iat = now();
  return sign({ t: 'register', p: phone, iat, exp: iat + REGISTER_TTL_SEC });
}

/** A current (unexpired) session, or null. */
export async function readSession(token: string): Promise<SessionPayload | null> {
  const p = await open(token);
  if (!p || p.t !== 'session' || p.exp < now()) return null;
  return p;
}

/** A session that may be expired but is still inside the refresh window. */
export async function readRefreshable(token: string): Promise<SessionPayload | null> {
  const p = await open(token);
  if (!p || p.t !== 'session' || p.iat + REFRESH_WINDOW_SEC < now()) return null;
  return p;
}

export async function readRegisterTicket(token: string): Promise<RegisterPayload | null> {
  const p = await open(token);
  if (!p || p.t !== 'register' || p.exp < now()) return null;
  return p;
}

export function bearer(req: Request): string {
  const h = req.headers.get('authorization') ?? '';
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
}

/** Header the proxy sets (after stripping any client-supplied copy) for routes that need it. */
export const SUBJECT_HEADER = 'x-guard-session-subject';

// ---------------------------------------------------------------- proxy gate

/** Routes that must work without a guard session. */
function isPublic(pathname: string, method: string, url: URL): boolean {
  if (pathname.startsWith('/api/guard/auth/')) return true; // send-otp, verify-otp, register, refresh
  if (pathname === '/api/guard/version' || pathname === '/api/guard/i18n') return true;
  if (pathname === '/api/guard/sos/inbound') return true; // SMS gateway, its own shared key
  // Signed links opened outside the app.
  if (method === 'GET' && pathname === '/api/guard/media' && url.searchParams.get('s')) return true;
  if (method === 'GET' && pathname === '/api/guard/earnings/pdf') return true;
  return false;
}

export type GateResult =
  | { ok: true; subject: string | null }
  | { ok: false; status: number; code: string; message: string };

/**
 * Decide whether a guard API request may proceed. `claimed` is every guard id the request names
 * as its actor (guardId / supervisorId, from the query or a JSON body).
 */
export async function gateGuardApi(req: Request, pathname: string, claimed: string[]): Promise<GateResult> {
  const url = new URL(req.url);
  if (isPublic(pathname, req.method, url)) return { ok: true, subject: null };
  // Agency / ops calls carry the admin key; the route itself validates it.
  if (req.headers.get('x-guard-admin-key')) return { ok: true, subject: null };

  const token = bearer(req);
  // An SOS must never be refused for a missing or stale login (PRD 18.9: nothing blocks SOS).
  const isSos = pathname === '/api/guard/sos' && req.method === 'POST';

  if (!token) {
    if (sessionRequired() && !isSos) {
      return { ok: false, status: 401, code: 'session_required', message: 'Please sign in again.' };
    }
    return { ok: true, subject: null };
  }

  const session = await readSession(token);
  if (!session) {
    if (isSos || !sessionRequired()) return { ok: true, subject: null };
    return { ok: false, status: 401, code: 'session_expired', message: 'Your session has expired.' };
  }

  const others = claimed.filter((id) => id && id !== session.g);
  if (others.length > 0) {
    return { ok: false, status: 403, code: 'session_mismatch', message: 'This request is not for the signed-in guard.' };
  }
  return { ok: true, subject: session.g };
}

/** The actor ids a request names. Only these keys identify the caller. */
export function actorIds(fromQuery: URLSearchParams, body: unknown): string[] {
  const ids = new Set<string>();
  for (const k of ['guardId', 'supervisorId']) {
    const q = fromQuery.get(k);
    if (q) ids.add(q);
  }
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    for (const k of ['guardId', 'supervisorId']) {
      if (typeof b[k] === 'string' && b[k]) ids.add(b[k] as string);
    }
  }
  return [...ids];
}
