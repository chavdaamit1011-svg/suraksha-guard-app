/**
 * Round 8: guard assistant (rules path) and the two-tap check-in KPI.
 * Staging has no ANTHROPIC_API_KEY, so only the no-model answers are exercised here.
 * Runs against the staging server and test DB (never production).
 */
import mongoose from 'mongoose';

const BASE = 'http://127.0.0.1:4546';
const ADMIN = { 'x-guard-admin-key': 'test-admin-key-local-only' };
const GUARD_A = '6a92b25401423c3f1254b11b';

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
async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = {};
  try {
    json = await res.json();
  } catch {
    /* not json */
  }
  return { status: res.status, json };
}
const ask = (message, lang = 'en') => api('/api/guard/assistant', { method: 'POST', body: { guardId: GUARD_A, message, lang } });

await mongoose.connect('mongodb://127.0.0.1:27017/suraksha_guardtest');
const db = mongoose.connection.db;
const roster = await db.collection('agencyrosters').findOne({ 'assignedGuards.guardId': new mongoose.Types.ObjectId(GUARD_A) });

console.log('\n# Assistant: answered from the guard\'s own data');
let r = await ask('When is my duty?');
check('shift question answered from the roster', r.json.source === 'rules' && r.json.reply?.includes(roster.siteName), r.json);
r = await ask('मेरी छुट्टी कितनी बची है?', 'hi');
check('leave question in Hindi answered in Hindi with the balance', /बची/.test(r.json.reply ?? '') && /\d/.test(r.json.reply ?? ''), r.json);
r = await ask('salary kab aayegi', 'en');
check('pay question answered (no payslip yet → points to the estimate)', r.json.source === 'rules' && /payslip|estimate/i.test(r.json.reply ?? ''), r.json);
r = await ask('meri chhutti kitni bachi hai');
check('Roman-Hindi leave question (seen on a phone) answered with the balance', r.json.source === 'rules' && /Leave left/.test(r.json.reply ?? ''), r.json);
r = await ask('tankhwah kab aayegi');
check('Roman-Hindi pay question answered', r.json.source === 'rules' && /payslip|estimate/i.test(r.json.reply ?? ''), r.json);
r = await ask('someone is attacking me');
check('danger → SOS and 112 guidance', /SOS/.test(r.json.reply ?? '') && /112/.test(r.json.reply ?? ''), r.json);
r = await ask('what is the capital of France');
check('anything else without an API key → says what it can help with', r.json.source === 'rules' && /Help/.test(r.json.reply ?? ''), r.json);
r = await ask('   ');
check('empty question → 400', r.status === 400, r.status);
r = await api('/api/guard/assistant', { method: 'POST', body: { guardId: 'nope', message: 'hi' } });
check('bad guard id → 400', r.status === 400, r.status);
const other = await ask('When is my duty?');
check('never claims to act ("I have marked…")', !/(i have|maine) (marked|applied|raised)/i.test(other.json.reply ?? ''));

console.log('\n# Two-tap KPI');
await db.collection('activities').deleteMany({ event: 'checkin_taps', 'metadata.test': 'round8' });
const now = new Date();
const mk = (taps, seconds, extra = {}) => ({
  event: 'checkin_taps', platform: 'suraksha', pageUrl: 'guard-app://checkin_taps', createdAt: now,
  metadata: { test: 'round8', kind: 'in', taps, seconds, reasonRequired: false, autoCapture: true, ...extra },
});
await db.collection('activities').insertMany([
  mk(2, 8), mk(2, 10), mk(2, 12), mk(3, 20, { autoCapture: false }), mk(4, 30, { reasonRequired: true }),
]);
r = await api('/api/guard/kpi?days=1');
check('KPI needs the admin key', r.status === 401, r.status);
r = await api('/api/guard/kpi?days=1', { headers: ADMIN });
check('median taps computed', r.json.all?.medianTaps === 2, r.json.all);
check('share at the 2-tap target', r.json.all?.atTargetPct === 60, r.json.all);
check('exception path separated out', r.json.withoutReason?.count === r.json.all?.count - 1, [r.json.withoutReason?.count, r.json.all?.count]);
check('auto-capture share', r.json.all?.autoCapturePct === 80, r.json.all);
await db.collection('activities').deleteMany({ event: 'checkin_taps', 'metadata.test': 'round8' });

console.log('\n# On-device face check verdict');
{
  const u1 = crypto.randomUUID();
  const u2 = crypto.randomUUID();
  const ev = (u, seq, face_check) => ({
    client_event_uuid: u, capture_sequence_no: seq, type: 'check_in', device_time: new Date().toISOString(),
    payload: { rosterId: String(roster._id), lat: 30.7333, lng: 76.7794, accuracy_m: 10, face_check },
  });
  r = await api('/api/guard/sync', { method: 'POST', body: { guardId: GUARD_A, events: [ev(u1, 980001, 'eyes_closed'), ev(u2, 980002, 'bogus<script>')] } });
  check('both events accepted', r.json.accepted?.includes(u1) && r.json.accepted?.includes(u2), r.json);
  const a1 = await db.collection('guardattendances').findOne({ clientEventUuid: u1 });
  const a2 = await db.collection('guardattendances').findOne({ clientEventUuid: u2 });
  check('failed device face check becomes a review flag', a1?.reviewFlags?.includes('device_face_eyes_closed'), a1?.reviewFlags);
  check('unknown verdicts are ignored', !(a2?.reviewFlags ?? []).some((f) => f.startsWith('device_face_')), a2?.reviewFlags);
  await db.collection('guardattendances').deleteMany({ clientEventUuid: { $in: [u1, u2] } });
}

await mongoose.disconnect();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('Failures:\n  ' + failures.join('\n  '));
  process.exit(1);
}
