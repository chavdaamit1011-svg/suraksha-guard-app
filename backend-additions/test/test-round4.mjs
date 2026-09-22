/**
 * Round 4: leave validation, personal-detail change requests, patrol observations, wake
 * re-prompt/escalation, incident severity, version tiers.
 * Runs against the staging server and test DB (never production).
 */
import crypto from 'crypto';
import mongoose from 'mongoose';

const BASE = 'http://127.0.0.1:4546';
const ADMIN_KEY = 'test-admin-key-local-only';
const GUARD_A = '6a92b25401423c3f1254b11b';
const GUARD_B = '6a92b25401423c3f1254b11c';

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

async function api(path, opts = {}) {
  const headers = {};
  if (opts.body) headers['Content-Type'] = 'application/json';
  if (opts.admin) headers['x-guard-admin-key'] = ADMIN_KEY;
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

const uuid = () => crypto.randomUUID();
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const plus = (key, n) => {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

await mongoose.connect('mongodb://127.0.0.1:27017/suraksha_guardtest');
const db = mongoose.connection.db;
const guardsCol = db.collection('apguards');
const originalA = await guardsCol.findOne({ _id: new mongoose.Types.ObjectId(GUARD_A) });
// The seed's name — restored at the end even if an earlier run died before its cleanup.
originalA.name = 'Ravi Kumar Singh';
originalA.initials = 'R';
await guardsCol.updateOne({ _id: originalA._id }, { $set: { name: originalA.name, initials: originalA.initials } });
// Wake slots this test inserts carry no rosterId; seeded ones always do.
await db.collection('guardwakeschedules').deleteMany({ guardId: GUARD_B, rosterId: { $exists: false } });

await db.collection('guardfieldevents').deleteMany({ guardId: { $in: [GUARD_A, GUARD_B] }, kind: 'leave' });
await db.collection('guardchangerequests').deleteMany({ guardId: { $in: [GUARD_A, GUARD_B] } });
await db.collection('guardappprofiles').updateMany(
  { guardId: { $in: [GUARD_A, GUARD_B] } },
  { $unset: { payout: '', dob: '', emergencyContact: '' } }
);

const today = istToday();

// ---------------------------------------------------------------- leave
console.log('\n# Leave');
{
  let r = await api('/api/guard/leave', { method: 'POST', body: { guardId: GUARD_A, type: 'holiday', from: plus(today, 5), to: plus(today, 5) } });
  check('unknown type → 422 bad_type', r.status === 422 && r.json.code === 'bad_type', r.json);

  r = await api('/api/guard/leave', { method: 'POST', body: { guardId: GUARD_A, type: 'casual', from: plus(today, 6), to: plus(today, 5) } });
  check('end before start → bad_range', r.json.code === 'bad_range', r.json);

  r = await api('/api/guard/leave', { method: 'POST', body: { guardId: GUARD_A, type: 'casual', from: plus(today, -2), to: plus(today, -2) } });
  check('casual in the past → past_date', r.json.code === 'past_date', r.json);

  r = await api('/api/guard/leave', { method: 'POST', body: { guardId: GUARD_A, type: 'sick', from: plus(today, -1), to: plus(today, -1) } });
  check('sick in the past without reason → reason_required', r.json.code === 'reason_required', r.json);

  r = await api('/api/guard/leave', {
    method: 'POST',
    body: { guardId: GUARD_A, type: 'sick', from: plus(today, -1), to: plus(today, -1), reason: 'fever' },
  });
  check('sick in the past with reason → accepted, retrospective', r.json.success && r.json.retrospective === true, r.json);

  const threeDay = uuid();
  r = await api('/api/guard/leave', {
    method: 'POST',
    body: { guardId: GUARD_A, clientEventUuid: threeDay, type: 'casual', from: plus(today, 20), to: plus(today, 22) },
  });
  check('3-day casual → pending, days 3', r.json.status === 'pending' && r.json.days === 3, r.json);

  r = await api('/api/guard/leave', { method: 'POST', body: { guardId: GUARD_A, clientEventUuid: threeDay, type: 'casual', from: plus(today, 20), to: plus(today, 22) } });
  check('resend same uuid → duplicate', r.json.duplicate === true, r.json);

  r = await api('/api/guard/leave', { method: 'POST', body: { guardId: GUARD_A, type: 'casual', from: plus(today, 22), to: plus(today, 23) } });
  check('overlapping request → overlap', r.json.code === 'overlap', r.json);

  r = await api('/api/guard/leave', { method: 'POST', body: { guardId: GUARD_A, type: 'casual', from: plus(today, 30), to: plus(today, 30), halfDay: true } });
  check('half day → 0.5 days', r.json.days === 0.5, r.json);

  // A day the guard worked cannot be leave.
  const workedDay = plus(today, 40);
  const attUuid = uuid();
  await db.collection('guardattendances').insertOne({ guardId: GUARD_A, eventType: 'check_in', shiftDate: workedDay, clientEventUuid: attUuid, createdAt: new Date() });
  r = await api('/api/guard/leave', { method: 'POST', body: { guardId: GUARD_A, type: 'casual', from: workedDay, to: workedDay } });
  check('leave on a worked day → already_worked', r.json.code === 'already_worked', r.json);

  // Offline path: same rules, but an invalid request is stored as rejected (not dropped).
  const offlineBad = uuid();
  r = await api('/api/guard/sync', {
    method: 'POST',
    body: {
      guardId: GUARD_A,
      events: [{ client_event_uuid: offlineBad, capture_sequence_no: 900001, type: 'leave', device_time: new Date().toISOString(), payload: { leaveType: 'casual', from: workedDay, to: workedDay } }],
    },
  });
  const stored = await db.collection('guardfieldevents').findOne({ clientEventUuid: offlineBad });
  check('offline leave on a worked day → accepted by sync, stored rejected', r.json.accepted?.includes(offlineBad) && stored?.status === 'rejected', stored?.status);
  await db.collection('guardattendances').deleteOne({ clientEventUuid: attUuid });

  r = await api(`/api/guard/leave?guardId=${GUARD_A}`);
  const casual = r.json.balance?.find((b) => b.type === 'casual');
  const sick = r.json.balance?.find((b) => b.type === 'sick');
  const unpaid = r.json.balance?.find((b) => b.type === 'unpaid');
  check('balance counts days: casual used 3.5', casual?.used === 3.5 && casual?.left === 8.5, casual);
  check('balance: sick used 1 of 7', sick?.used === 1 && sick?.left === 6, sick);
  check('unpaid has no balance', unpaid?.left === null, unpaid);
  check('rejected rows are listed with their note', r.json.leaves?.some((l) => l.status === 'rejected' && l.decisionNote), r.json.leaves?.map((l) => l.status));

  r = await api('/api/guard/leave', { method: 'PATCH', body: { guardId: GUARD_A, clientEventUuid: threeDay } });
  check('withdraw pending → cancelled', r.json.status === 'cancelled', r.json);
  r = await api('/api/guard/leave', { method: 'PATCH', body: { guardId: GUARD_A, clientEventUuid: threeDay } });
  check('withdraw twice → 409', r.status === 409, r.status);
  r = await api(`/api/guard/leave?guardId=${GUARD_A}`);
  check('withdrawn leave returns to balance', r.json.balance?.find((b) => b.type === 'casual')?.used === 0.5, r.json.balance);
}

// ---------------------------------------------------------------- change requests
console.log('\n# Change requests');
{
  let r = await api('/api/guard/change-request', { method: 'POST', body: { guardId: GUARD_A, field: 'wage', value: '99999' } });
  check('unchangeable field → 400', r.status === 400 && r.json.code === 'bad_field', r.json);

  r = await api('/api/guard/change-request', { method: 'POST', body: { guardId: GUARD_A, field: 'address', value: '12, Sector 9, Chandigarh' } });
  check('address → applied at once', r.json.request?.status === 'applied', r.json);
  const g = await guardsCol.findOne({ _id: new mongoose.Types.ObjectId(GUARD_A) });
  check('address written to APGuard', g.address === '12, Sector 9, Chandigarh', g.address);

  r = await api('/api/guard/change-request', { method: 'POST', body: { guardId: GUARD_A, field: 'emergencyContact', value: { name: 'Sita', phone: '12345', relation: 'spouse' } } });
  check('bad emergency phone → 422', r.status === 422, r.json);
  r = await api('/api/guard/change-request', { method: 'POST', body: { guardId: GUARD_A, field: 'emergencyContact', value: { name: 'Sita', phone: '9876543210', relation: 'spouse' } } });
  check('emergency contact applied, phone masked in display', r.json.request?.status === 'applied' && !r.json.request.display.includes('9876543210'), r.json.request?.display);

  // Identity: locked, needs proof, decided by the agency.
  r = await api('/api/guard/change-request', { method: 'POST', body: { guardId: GUARD_A, field: 'name', value: 'Ramesh Kumar Singh' } });
  check('name without proof → proof_required', r.json.code === 'proof_required', r.json);
  r = await api('/api/guard/change-request', { method: 'POST', body: { guardId: GUARD_A, field: 'name', value: 'R4mesh' } });
  check('name with digits → 422', r.status === 422, r.json);
  r = await api('/api/guard/change-request', { method: 'POST', body: { guardId: GUARD_A, field: 'name', value: 'Ramesh Kumar Singh', reason: 'Spelling as on Aadhaar' } });
  const nameReq = r.json.request;
  check('name change → pending', nameReq?.status === 'pending', r.json);
  let g2 = await guardsCol.findOne({ _id: new mongoose.Types.ObjectId(GUARD_A) });
  check('name not changed before approval', g2.name === originalA.name, g2.name);

  r = await api('/api/guard/change-request', { method: 'POST', body: { guardId: GUARD_A, field: 'name', value: 'Other Name', reason: 'x' } });
  check('second live request for same field → 409', r.status === 409 && r.json.code === 'already_pending', r.json);

  r = await api('/api/guard/change-request', { method: 'PATCH', body: { requestId: nameReq.requestId, action: 'approve' } });
  check('approve without admin key → treated as guard, refused', r.status === 400, r.status);

  r = await api('/api/guard/change-request', { method: 'PATCH', admin: true, body: { requestId: nameReq.requestId, action: 'approve', decidedBy: 'ops-test' } });
  check('agency approves → applied', r.json.request?.status === 'applied', r.json);
  g2 = await guardsCol.findOne({ _id: new mongoose.Types.ObjectId(GUARD_A) });
  check('approved name written to APGuard', g2.name === 'Ramesh Kumar Singh' && g2.initials === 'R', g2.name);

  r = await api('/api/guard/change-request', { method: 'POST', body: { guardId: GUARD_A, field: 'dob', value: '2015-01-01', reason: 'x' } });
  check('dob under 18 → 422', r.status === 422, r.json);
  r = await api('/api/guard/change-request', { method: 'POST', body: { guardId: GUARD_A, field: 'dob', value: '1990-05-17', reason: 'wrong year' } });
  const dobReq = r.json.request;
  r = await api('/api/guard/change-request', { method: 'PATCH', admin: true, body: { requestId: dobReq.requestId, action: 'reject', note: 'Document unclear' } });
  check('agency rejects with note', r.json.request?.status === 'rejected' && r.json.request.decisionNote === 'Document unclear', r.json);
  r = await api('/api/guard/change-request', { method: 'PATCH', admin: true, body: { requestId: dobReq.requestId, action: 'approve' } });
  check('deciding twice → 409', r.status === 409, r.status);

  // Payout: OTP, cool-off, cancel, sweep.
  const bank = { accountHolder: 'Ramesh Kumar', accountNumber: '123456789012', ifsc: 'SBIN0001234' };
  r = await api('/api/guard/change-request', { method: 'POST', body: { guardId: GUARD_A, field: 'bank', value: { ...bank, ifsc: 'SBIN1234' } } });
  check('bad IFSC → 422 before any OTP check', r.status === 422 && r.json.code === 'bad_value', r.json);
  r = await api('/api/guard/change-request', { method: 'POST', body: { guardId: GUARD_A, field: 'bank', value: bank } });
  check('bank without OTP → otp_required', r.json.code === 'otp_required', r.json);

  const phone = originalA.phone;
  const sent = await api('/api/guard/auth/send-otp', { method: 'POST', body: { phone } });
  const code = sent.json.devCode;
  check('OTP issued (dev code available on staging)', !!code, sent.json);
  const wrong = code === '000000' ? '111111' : '000000';
  r = await api('/api/guard/change-request', { method: 'POST', body: { guardId: GUARD_A, field: 'bank', value: bank, otp: wrong } });
  check('wrong OTP → otp_invalid', r.json.code === 'otp_invalid', r.json);
  r = await api('/api/guard/change-request', { method: 'POST', body: { guardId: GUARD_A, field: 'bank', value: bank, otp: code } });
  const bankReq = r.json.request;
  check('bank with OTP → cooling_off', bankReq?.status === 'cooling_off', r.json);
  const hours = (Date.parse(bankReq.effectiveAt) - Date.now()) / 3600_000;
  check('effective ~24 h later', hours > 23.9 && hours <= 24, hours);
  check('account number masked in response', !JSON.stringify(r.json).includes('123456789012') && bankReq.display.includes('9012'), bankReq.display);
  r = await api('/api/guard/change-request', { method: 'POST', body: { guardId: GUARD_A, field: 'bank', value: bank, otp: code } });
  check('OTP cannot be replayed', r.json.code === 'already_pending' || r.json.code === 'otp_expired', r.json);

  r = await api(`/api/guard/change-request?guardId=${GUARD_A}`);
  check('payout not applied during cool-off', r.json.details?.payout === '', r.json.details);
  check('guard GET never carries the full account number', !JSON.stringify(r.json).includes('123456789012'));
  check('rules advertise the locked fields', JSON.stringify(r.json.rules?.locked) === '["name","dob"]', r.json.rules);

  r = await api(`/api/guard/change-request?sweep=1&asOf=${encodeURIComponent(new Date(Date.now() + 25 * 3600_000).toISOString())}`, { admin: true });
  check('sweep after cool-off applies it', r.json.swept === 1, r.json.swept);
  const prof = await db.collection('guardappprofiles').findOne({ guardId: GUARD_A });
  check('payout stored with full number for payroll', prof?.payout?.accountNumber === '123456789012' && prof.payout.accountLast4 === '9012', prof?.payout);
  r = await api(`/api/guard/change-request?guardId=${GUARD_A}`);
  check('guard sees masked payout', r.json.details?.payout === 'Ramesh Kumar · ••••9012 · SBIN0001234', r.json.details?.payout);

  // Stolen-phone case: a UPI change, cancelled by the guard during the cool-off.
  r = await api('/api/guard/change-request', { method: 'POST', body: { guardId: GUARD_A, field: 'upi', value: { vpa: 'thief@okaxis' }, otp: '123456' } });
  const upiReq = r.json.request;
  check('UPI change (demo OTP, no gateway) → cooling_off', upiReq?.status === 'cooling_off', r.json);
  r = await api('/api/guard/change-request', { method: 'PATCH', body: { guardId: GUARD_B, requestId: upiReq.requestId, action: 'cancel' } });
  check("another guard cannot cancel it", r.status === 409, r.status);
  r = await api('/api/guard/change-request', { method: 'PATCH', body: { guardId: GUARD_A, requestId: upiReq.requestId, action: 'cancel' } });
  check('guard cancels during cool-off', r.json.request?.status === 'cancelled', r.json);
  r = await api(`/api/guard/change-request?sweep=1&asOf=${encodeURIComponent(new Date(Date.now() + 48 * 3600_000).toISOString())}`, { admin: true });
  check('cancelled change is never applied', r.json.swept === 0, r.json.swept);
  const prof2 = await db.collection('guardappprofiles').findOne({ guardId: GUARD_A });
  check('payout still the bank account', prof2?.payout?.method === 'bank', prof2?.payout?.method);

  r = await api('/api/guard/change-request?status=pending', { admin: true });
  check('admin queue lists by status', Array.isArray(r.json.requests), r.json);
}

// ---------------------------------------------------------------- patrol observations
console.log('\n# Patrol observations');
{
  const scanUuid = uuid();
  let r = await api('/api/guard/patrol', { method: 'POST', body: { guardId: GUARD_A, clientEventUuid: scanUuid, checkpointCode: 'SG-TW9-CP1', method: 'qr', lat: 30.7333, lng: 76.7794 } });
  check('scan recorded', r.json.success, r.json);

  r = await api('/api/guard/patrol', { method: 'PATCH', body: { guardId: GUARD_A, scanUuid, observationType: 'issue', note: 'Side gate lock broken' } });
  check('issue observation accepted', r.json.success, r.json);
  const scan = await db.collection('guardfieldevents').findOne({ clientEventUuid: scanUuid });
  check('issue folded into the scan', scan?.meta?.observationType === 'issue' && scan.reason === 'Side gate lock broken', scan?.meta);
  check('issue flags the scan for review', scan?.reviewFlags?.includes('patrol_issue'), scan?.reviewFlags);

  r = await api('/api/guard/patrol', { method: 'PATCH', body: { guardId: GUARD_B, scanUuid, observationType: 'all_ok' } });
  check("another guard cannot annotate the scan", r.status === 404, r.status);
  r = await api('/api/guard/patrol', { method: 'PATCH', body: { guardId: GUARD_A, scanUuid: uuid(), observationType: 'note' } });
  check('unknown scan → 404', r.status === 404, r.status);

  // Offline: observation before its scan has landed is retried, not dropped.
  const lateScan = uuid();
  const obs = uuid();
  const now = new Date().toISOString();
  r = await api('/api/guard/sync', {
    method: 'POST',
    body: { guardId: GUARD_A, events: [{ client_event_uuid: obs, capture_sequence_no: 900003, type: 'patrol_observation', device_time: now, payload: { scanUuid: lateScan, observation_type: 'note', note: 'lights off' } }] },
  });
  const res = r.json.results?.find((x) => x.uuid === obs);
  check('observation without its scan → retry, not accepted', res?.retry === true && !r.json.accepted?.includes(obs), r.json);

  r = await api('/api/guard/sync', {
    method: 'POST',
    body: {
      guardId: GUARD_A,
      events: [
        { client_event_uuid: obs, capture_sequence_no: 900003, type: 'patrol_observation', device_time: now, payload: { scanUuid: lateScan, observation_type: 'note', note: 'lights off' } },
        { client_event_uuid: lateScan, capture_sequence_no: 900002, type: 'patrol_scan', device_time: now, payload: { checkpointCode: 'SG-TW9-CP2', method: 'qr' } },
      ],
    },
  });
  check('scan + observation in one batch → both accepted', r.json.accepted?.includes(lateScan) && r.json.accepted?.includes(obs), r.json);
  const late = await db.collection('guardfieldevents').findOne({ clientEventUuid: lateScan });
  check('offline observation attached', late?.meta?.observationType === 'note' && late.reason === 'lights off', late?.meta);
}

// ---------------------------------------------------------------- wake re-prompt
console.log('\n# Wake re-prompt and escalation');
{
  const due = new Date(Date.now() - 3 * 60_000);
  const { insertedId: w1 } = await db.collection('guardwakeschedules').insertOne({ guardId: GUARD_B, dueAt: due, ackWindowSec: 120, status: 'pending', missCount: 0, escalatedAt: '' });
  let r = await api('/api/guard/wake-check', { method: 'POST', body: { guardId: GUARD_B, wakeId: String(w1), missed: true, attempt: 1, clientEventUuid: uuid() } });
  let row = await db.collection('guardwakeschedules').findOne({ _id: w1 });
  check('first miss → reprompted, missCount 1', row.status === 'reprompted' && row.missCount === 1, { resp: r.json, row: row.status });

  r = await api('/api/guard/wake-check', { method: 'POST', body: { guardId: GUARD_B, wakeId: String(w1), missed: true, attempt: 2, clientEventUuid: uuid() } });
  row = await db.collection('guardwakeschedules').findOne({ _id: w1 });
  check('second miss → missed and escalated', row.status === 'missed' && row.missCount === 2 && !!row.escalatedAt, { resp: r.json, row });

  // (guardId, dueAt) is unique, so the second slot needs its own time.
  const { insertedId: w2 } = await db.collection('guardwakeschedules').insertOne({ guardId: GUARD_B, dueAt: new Date(due.getTime() - 60_000), ackWindowSec: 120, status: 'pending', missCount: 0, escalatedAt: '' });
  await api('/api/guard/wake-check', { method: 'POST', body: { guardId: GUARD_B, wakeId: String(w2), missed: true, attempt: 1, clientEventUuid: uuid() } });
  r = await api('/api/guard/wake-check', { method: 'POST', body: { guardId: GUARD_B, wakeId: String(w2), attempt: 2, respondedMs: 4000, clientEventUuid: uuid() } });
  row = await db.collection('guardwakeschedules').findOne({ _id: w2 });
  check('answered on the re-prompt → acknowledged_late', row.status === 'acknowledged_late', { resp: r.json, row: row.status });
  await db.collection('guardwakeschedules').deleteMany({ _id: { $in: [w1, w2] } });
}

// ---------------------------------------------------------------- incident
console.log('\n# Incident');
{
  let r = await api('/api/guard/incident', { method: 'POST', body: { guardId: GUARD_A, type: 'theft', severity: 'low' } });
  check('no description and no media → refused', r.status >= 400 && r.status < 500, r.status);
  r = await api('/api/guard/incident', { method: 'POST', body: { guardId: GUARD_A, clientEventUuid: uuid(), type: 'fire', severity: 'emergency', description: 'Smoke from the basement', injuriesFlag: true } });
  check('emergency → escalated', r.json.success && r.json.escalated === true, r.json);
  r = await api('/api/guard/incident', { method: 'POST', body: { guardId: GUARD_A, clientEventUuid: uuid(), type: 'damage', severity: 'low', description: 'Broken bulb' } });
  check('low → not escalated', r.json.success && !r.json.escalated, r.json);
  r = await api(`/api/guard/incident?guardId=${GUARD_A}`);
  check('guard lists own incidents', Array.isArray(r.json.incidents) && r.json.incidents.length >= 2, r.json.incidents?.length);
}

// ---------------------------------------------------------------- version
console.log('\n# Version');
{
  const r = await api('/api/guard/version');
  check('version advertises tiers', r.json.success && 'minSupported' in r.json && 'blockBelow' in r.json, r.json);
  check('degraded mode never disables duty features', Array.isArray(r.json.degradedDisables) && !r.json.degradedDisables.some((f) => ['attendance', 'sos', 'incident'].includes(f)), r.json.degradedDisables);
}

// ---------------------------------------------------------------- cleanup
await guardsCol.updateOne(
  { _id: originalA._id },
  { $set: { name: originalA.name, initials: originalA.initials ?? 'G', address: originalA.address ?? '' } }
);
await db.collection('guardchangerequests').deleteMany({ guardId: { $in: [GUARD_A, GUARD_B] } });
await db.collection('guardfieldevents').deleteMany({ guardId: { $in: [GUARD_A, GUARD_B] }, kind: 'leave' });
await mongoose.disconnect();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('Failures:\n  ' + failures.join('\n  '));
  process.exit(1);
}
