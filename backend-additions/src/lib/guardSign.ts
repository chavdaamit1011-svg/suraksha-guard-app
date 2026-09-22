import crypto from 'crypto';

/**
 * Short-lived signed links for things that are opened outside the app's own requests: a payslip
 * PDF handed to the phone's viewer, or a guard's voice note opened by an ops user from a ticket.
 *
 * The secret is deliberately not `JWT_SECRET` (which has a hard-coded fallback elsewhere in the
 * codebase). With neither variable set, signing is refused and the links are simply not offered.
 */
function secret(): string {
  return process.env.GUARD_LINK_SECRET || process.env.GUARD_ADMIN_KEY || '';
}

export function linksEnabled(): boolean {
  return secret().length >= 16;
}

function mac(scope: string, subject: string, exp: number): string {
  return crypto.createHmac('sha256', secret()).update(`${scope}|${subject}|${exp}`).digest('base64url');
}

/** Returns `e` (expiry, unix seconds) and `s` (signature) query values, or null when disabled. */
export function signLink(scope: string, subject: string, ttlSec: number): { e: number; s: string } | null {
  if (!linksEnabled()) return null;
  const e = Math.floor(Date.now() / 1000) + ttlSec;
  return { e, s: mac(scope, subject, e) };
}

export function verifyLink(scope: string, subject: string, e: string | null, s: string | null): boolean {
  if (!linksEnabled() || !e || !s) return false;
  const exp = Number(e);
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  const expected = Buffer.from(mac(scope, subject, exp));
  const given = Buffer.from(s);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

export function isAdminRequest(req: Request): boolean {
  const expected = process.env.GUARD_ADMIN_KEY;
  if (!expected) return false;
  const given = req.headers.get('x-guard-admin-key') ?? '';
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** Absolute origin for links that leave the server (SMS, ticket text). */
export function publicOrigin(req: Request): string {
  return process.env.GUARD_PUBLIC_ORIGIN || new URL(req.url).origin;
}
