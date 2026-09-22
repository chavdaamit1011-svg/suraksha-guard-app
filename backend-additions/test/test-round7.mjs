/**
 * Round 7: guard sessions (src/lib/guardSession.ts + the proxy gate).
 *
 *   node test/test-round7.mjs              — rollout mode (GUARD_REQUIRE_SESSION unset on the server)
 *   ENFORCED=1 node test/test-round7.mjs   — the server was started with GUARD_REQUIRE_SESSION=1
 *
 * Staging's signing secret is its GUARD_ADMIN_KEY (a local test value), which lets the test mint
 * an expired token. Runs against the staging server and test DB (never production).
 */
import crypto from 'crypto';
import mongoose from 'mongoose';

const BASE = 'http://127.0.0.1:4546';
const SECRET = 'test-admin-key-local-only';
const ENFORCED = process.env.ENFORCED === '1';
const GUARD_A = '6a92b25401423c3f1254b11b';
const GUARD_B = '6a92b25401423c3f1254b11c';
const PHONE_A = '9876500001';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ''}`);
  }
}
async function api(path, { method = 'GET', body, token, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text.slice(0, 80) };
  }
  return { status: res.status, json };
}
const b64url = (buf) => Buffer.from(buf).toString('base64url');
function mint(payload) {
  const body = b64url(JSON.stringify(payload));
  return `sg1.${body}.${b64url(crypto.createHmac('sha256', SECRET).update(body).digest())}`;
}
async function login(phone, deviceId) {
  const sent = await api('/api/guard/auth/send-otp', { method: 'POST', body: { phone } });
  return api('/api/guard/auth/verify-otp', { method: 'POST', body: { phone, otp: sent.json.devCode, deviceId } });
}

await mongoose.connect('mongodb://127.0.0.1:27017/suraksha_guardtest');
const db = mongoose.connection.db;
const profileA = await db.collection('guardappprofiles').findOne({ guardId: GUARD_A });
const deviceA = profileA?.boundDeviceId || 'test-device-a';

console.log(`\n# Mode: ${ENFORCED ? 'ENFORCED' : 'rollout'}`);

console.log('\n# Login issues a session');
const loginA = await login(PHONE_A, deviceA);
const tokenA = loginA.json.sessionToken;
check('OTP login returns a session token', typeof tokenA === 'string' && tokenA.startsWith('sg1.'), loginA.json);
check('session expiry is about 7 days out', Math.abs(loginA.json.sessionExpiresAt - Date.now() - 7 * 864e5) < 60_000);

const newPhone = `98765${String(Date.now()).slice(-5)}`;
const loginNew = await login(newPhone, 'dev-new');
check('unregistered phone gets a registration ticket, not a session', loginNew.json.exists === false && !!loginNew.json.registerTicket && !loginNew.json.sessionToken, loginNew.json);

console.log('\n# The token only speaks for its own guard');
let r = await api(`/api/guard/today?guardId=${GUARD_A}`, { token: tokenA });
check('own data with token → 200', r.status === 200, r.status);
r = await api(`/api/guard/today?guardId=${GUARD_B}`, { token: tokenA });
check("another guard's data with A's token → 403", r.status === 403 && r.json.code === 'session_mismatch', r);
r = await api('/api/guard/leave', { method: 'POST', token: tokenA, body: { guardId: GUARD_B, type: 'casual', from: '2099-01-01', to: '2099-01-01' } });
check("writing as another guard (JSON body) → 403", r.status === 403, r.status);
r = await api('/api/guard/supervisor/proxy', { method: 'POST', token: tokenA, body: { supervisorId: GUARD_B, subjectGuardId: GUARD_A, eventType: 'check_in', reason: 'phone_dead' } });
check('acting as another supervisor → 403', r.status === 403, r.status);

// Multipart upload: the proxy cannot read the form; the route checks the verified subject.
const form = new FormData();
form.set('guardId', GUARD_B);
form.set('kind', 'voice');
form.set('file', new Blob([Buffer.from('ID3fake')], { type: 'audio/mpeg' }), 'x.mp3');
let res = await fetch(`${BASE}/api/guard/media`, { method: 'POST', body: form, headers: { Authorization: `Bearer ${tokenA}`, 'x-guard-session-subject': GUARD_B } });
check("multipart upload for another guard (even with a spoofed subject header) → 403", res.status === 403, res.status);

console.log('\n# Renewal and sign-out');
r = await api('/api/guard/auth/refresh', { method: 'POST', token: tokenA });
check('refresh returns a new token', r.status === 200 && r.json.sessionToken?.startsWith('sg1.'), r.json);
const tokenA2 = r.json.sessionToken;
const oldIat = Math.floor(Date.now() / 1000) - 10 * 86400;
const expired = mint({ t: 'session', g: GUARD_A, d: deviceA, v: profileA?.sessionVersion ?? 0, iat: oldIat, exp: oldIat + 7 * 86400 });
r = await api('/api/guard/auth/refresh', { method: 'POST', token: expired });
check('an expired token inside the 90-day window still renews', r.status === 200, r.json);
const ancient = mint({ t: 'session', g: GUARD_A, d: deviceA, v: 0, iat: oldIat - 100 * 86400, exp: oldIat - 93 * 86400 });
r = await api('/api/guard/auth/refresh', { method: 'POST', token: ancient });
check('a token older than 90 days does not renew', r.status === 401, r.status);
const forged = tokenA.slice(0, -4) + (tokenA.endsWith('AAAA') ? 'BBBB' : 'AAAA');
r = await api('/api/guard/auth/refresh', { method: 'POST', token: forged });
check('a forged token does not renew', r.status === 401, r.status);
const otherDevice = mint({ t: 'session', g: GUARD_A, d: 'some-other-phone', v: profileA?.sessionVersion ?? 0, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 });
r = await api('/api/guard/auth/refresh', { method: 'POST', token: otherDevice });
check('a token from a phone that is not the bound one does not renew', r.status === 401 && r.json.code === 'device_changed', r.json);

r = await api('/api/guard/auth/logout', { method: 'POST', token: tokenA2 });
check('logout succeeds', r.json.success === true);
r = await api('/api/guard/auth/refresh', { method: 'POST', token: tokenA2 });
check('after logout the token no longer renews', r.status === 401 && r.json.code === 'session_revoked', r.json);
const relogin = await login(PHONE_A, deviceA);
r = await api('/api/guard/auth/refresh', { method: 'POST', token: relogin.json.sessionToken });
check('a fresh login works again after logout', r.status === 200, r.json);
const tokenFresh = relogin.json.sessionToken;

console.log('\n# Registration needs the OTP ticket');
r = await api('/api/guard/auth/register', { method: 'POST', body: { phone: newPhone, name: 'Test New', city: 'X', agencyId: 'suraksha-default', registerTicket: 'sg1.bogus.bogus' } });
check('a bad ticket is refused', r.status === 401 && r.json.code === 'otp_required', r.json);
r = await api('/api/guard/auth/register', { method: 'POST', body: { phone: '9999900000', name: 'Test New', city: 'X', agencyId: 'suraksha-default', registerTicket: loginNew.json.registerTicket } });
check("another phone's ticket is refused", r.status === 401, r.status);
r = await api('/api/guard/auth/register', { method: 'POST', body: { phone: newPhone, name: 'Test New', city: 'X', agencyId: 'suraksha-default', registerTicket: loginNew.json.registerTicket, deviceId: 'dev-new' } });
check('registration with the ticket succeeds and signs in', r.json.success === true && r.json.sessionToken?.startsWith('sg1.'), r.json);
await db.collection('apguards').deleteOne({ phone: `+91${newPhone}` });
await db.collection('guardappprofiles').deleteMany({ boundDeviceId: 'dev-new' });

console.log('\n# Always public');
r = await api('/api/guard/version');
check('version needs no session', r.status === 200);

if (!ENFORCED) {
  console.log('\n# Rollout mode: installed apps without a token keep working');
  r = await api(`/api/guard/today?guardId=${GUARD_A}`);
  check('no token → still served', r.status === 200, r.status);
  r = await api('/api/guard/auth/register', { method: 'POST', body: { phone: '9876599999', name: 'Legacy', city: 'X', agencyId: 'suraksha-default' } });
  check('legacy registration without a ticket still accepted', r.json.success === true, r.json);
  await db.collection('apguards').deleteOne({ phone: '+919876599999' });
} else {
  console.log('\n# Enforced mode');
  r = await api(`/api/guard/today?guardId=${GUARD_A}`);
  check('no token → 401 session_required', r.status === 401 && r.json.code === 'session_required', r.json);
  r = await api(`/api/guard/today?guardId=${GUARD_A}`, { token: expired });
  check('expired token → 401 session_expired (the app renews and retries)', r.status === 401 && r.json.code === 'session_expired', r.json);
  r = await api(`/api/guard/today?guardId=${GUARD_A}`, { token: tokenFresh });
  check('valid token → 200', r.status === 200, r.status);
  r = await api(`/api/guard/earnings?guardId=${GUARD_A}`);
  check('pay data without a token → 401', r.status === 401, r.status);
  r = await api('/api/guard/sos', { method: 'POST', body: { guardId: GUARD_A, clientEventUuid: crypto.randomUUID(), lat: 30.73, lng: 76.77 } });
  check('an SOS without a token is never refused', r.status !== 401 && r.status !== 403, r.status);
  r = await api('/api/guard/change-request?status=pending', { headers: { 'x-guard-admin-key': SECRET } });
  check('agency calls with the admin key pass', r.status === 200, r.status);
  r = await api('/api/guard/auth/register', { method: 'POST', body: { phone: '9876599998', name: 'No Ticket', city: 'X', agencyId: 'suraksha-default' } });
  check('registration without a ticket → 401', r.status === 401, r.json);
  const f2 = new FormData();
  f2.set('guardId', GUARD_A);
  f2.set('kind', 'voice');
  f2.set('file', new Blob([Buffer.from('ID3fake')], { type: 'audio/mpeg' }), 'x.mp3');
  res = await fetch(`${BASE}/api/guard/media`, { method: 'POST', body: f2 });
  check('multipart upload without a token → 401', res.status === 401, res.status);
  // Production routes behind the same gate.
  r = await api(`/api/guard/me?guardId=${GUARD_A}`);
  check('original /api/guard/me is gated too', r.status === 401, r.status);
}

await mongoose.disconnect();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('Failures:\n  ' + failures.join('\n  '));
  process.exit(1);
}
