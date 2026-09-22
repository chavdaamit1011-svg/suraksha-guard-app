/**
 * Face enrolment + verification banding, and device-binding enforcement.
 * Runs against the isolated staging server and test DB. Production is never touched.
 */
import crypto from 'crypto';
import mongoose from 'mongoose';

const BASE = 'http://127.0.0.1:4546';
const GUARD_A = '6a92b25401423c3f1254b11b';
const GUARD_B = '6a92b25401423c3f1254b11c';
const ADMIN = { 'x-guard-admin-key': 'test-admin-key-local-only' };
const SITE = { lat: 30.7333, lng: 76.7794 };

const JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
/** A different 1x1 JPEG, so the two enrolment images are not byte-identical. */
const JPEG_B64_ALT =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

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
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers ?? {}) },
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await mongoose.connect('mongodb://127.0.0.1:27017/suraksha_guardtest');
const db = mongoose.connection.db;

console.log('\n================ 1. FACE ENROLMENT ================');
const before = await api(`/api/guard/face/enroll?guardId=${GUARD_A}`);
check('not enrolled initially', before.json.enrolled === false, before.json);
check('reports whether a provider is configured', typeof before.json.verificationAvailable === 'boolean', before.json);

const legacy = await api('/api/guard/face/enroll', {
  method: 'POST',
  body: { guardId: GUARD_A, imageUri: 'file:///data/user/0/app/cache/selfie.jpg' },
});
check('a device path is accepted for older builds', legacy.json.success === true, legacy.json);
check('but is reported as not comparable', legacy.json.comparable === false, legacy.json);

const enrolUpload = await api('/api/guard/media', {
  method: 'POST',
  body: { guardId: GUARD_A, kind: 'selfie', base64: JPEG_B64_ALT, mime: 'image/jpeg' },
});
check('enrolment image uploads', !!enrolUpload.json.mediaId, enrolUpload.json);

const enrol = await api('/api/guard/face/enroll', {
  method: 'POST',
  body: { guardId: GUARD_A, mediaId: enrolUpload.json.mediaId },
});
check('enrolment by mediaId accepted', enrol.json.success === true, enrol.json);
check('and is comparable', enrol.json.comparable === true, enrol.json);
check('template ref issued', /^tmpl_/.test(enrol.json.faceTemplateRef ?? ''), enrol.json.faceTemplateRef);

const enrolledOthersMedia = await api('/api/guard/face/enroll', {
  method: 'POST',
  body: { guardId: GUARD_B, mediaId: enrolUpload.json.mediaId },
});
check("cannot enrol with another guard's media", enrolledOthersMedia.status === 404, enrolledOthersMedia.status);

const after = await api(`/api/guard/face/enroll?guardId=${GUARD_A}`);
check('now reported as enrolled', after.json.enrolled === true, after.json);
check('and comparable', after.json.comparable === true, after.json);

const profile = await db.collection('guardappprofiles').findOne({ guardId: GUARD_A });
check('enrolment history kept for re-enrolment', (profile?.faceEnrolHistory ?? []).length >= 1, profile?.faceEnrolHistory?.length);

console.log('\n================ 2. FACE CHECK ON A CHECK-IN ================');
const roster = await db.collection('agencyrosters').findOne({ 'assignedGuards.guardId': new mongoose.Types.ObjectId(GUARD_A) });
const uuid = crypto.randomUUID();

await api('/api/guard/attendance', {
  method: 'POST',
  body: {
    guardId: GUARD_A,
    clientEventUuid: uuid,
    eventType: 'check_in',
    rosterId: String(roster._id),
    deviceTime: new Date().toISOString(),
    lat: SITE.lat,
    lng: SITE.lng,
    accuracyM: 10,
  },
});
const beforeSelfie = await db.collection('guardattendances').findOne({ clientEventUuid: uuid });
check('check-in starts without a face score', beforeSelfie?.faceMatchScore == null, beforeSelfie?.faceMatchScore);

const selfie = await api('/api/guard/media', {
  method: 'POST',
  body: { guardId: GUARD_A, kind: 'selfie', base64: JPEG_B64, mime: 'image/jpeg', clientEventUuid: uuid },
});
check('check-in selfie uploaded', selfie.json.success === true, selfie.json);

// The comparison is deliberately not awaited by the upload, so give it a moment.
await sleep(1500);
const scored = await db.collection('guardattendances').findOne({ clientEventUuid: uuid });

check('a face verdict was recorded', !!scored?.livenessResult, scored?.livenessResult);
check('the provider used is recorded', !!scored?.meta?.faceProvider, scored?.meta?.faceProvider);

// With no provider configured the honest verdict is `unavailable`, which must route to a
// supervisor rather than silently pass or silently fail.
if (scored?.livenessResult === 'unavailable') {
  check('no provider → verdict is unavailable', true);
  check(
    'and the event is flagged for supervisor verification',
    (scored?.reviewFlags ?? []).some((f) => f === 'face_check_unavailable' || f === 'face_not_enrolled'),
    scored?.reviewFlags
  );
  check('confidence downgraded, not left as high', scored?.confidence !== 'high', scored?.confidence);
  check('reason recorded for the supervisor', !!scored?.meta?.faceReason, scored?.meta?.faceReason);
} else {
  check('a real provider returned a score', typeof scored?.faceMatchScore === 'number', scored?.faceMatchScore);
  check('verdict is one of the three bands', ['match', 'review', 'mismatch'].includes(scored?.livenessResult), scored?.livenessResult);
}

console.log('\n--- a failed face check never blocks duty ---');
check('the attendance record still exists', !!scored);
check('the check-in was not rejected', scored?.eventType === 'check_in');
check('geofence verdict unaffected by the face outcome', scored?.geofenceResult === 'inside', scored?.geofenceResult);

console.log('\n--- it surfaces in the supervisor review queue ---');
await api('/api/guard/supervisor/grant', {
  method: 'POST',
  headers: ADMIN,
  body: { guardId: GUARD_B, isSupervisor: true },
});
const team = await api(`/api/guard/supervisor/team?guardId=${GUARD_B}`);
const inQueue = team.json.reviewQueue?.some((i) => i.itemId === uuid);
check('flagged check-in reaches a supervisor', inQueue === true, team.json.reviewQueue?.map((i) => i.itemId));

console.log('\n--- repeated low scores suggest re-enrolment rather than endless flags ---');
const prof2 = await db.collection('guardappprofiles').findOne({ guardId: GUARD_A });
check('a low-score counter is tracked', typeof prof2?.consecutiveLowFaceScores === 'number', prof2?.consecutiveLowFaceScores);

console.log('\n================ 3. DEVICE BINDING ================');
await db.collection('guardappprofiles').updateOne(
  { guardId: GUARD_A },
  { $set: { boundDeviceId: '', pendingDeviceId: '' } }
);

const unbound = await api(`/api/guard/device?guardId=${GUARD_A}&deviceId=phone-one`);
check('no binding yet → unbound', unbound.json.standing === 'unbound', unbound.json);
check('and duty data is allowed', unbound.json.allowed === true);

// Bind phone one, the way verify-otp does at first login.
await db.collection('guardappprofiles').updateOne(
  { guardId: GUARD_A },
  { $set: { boundDeviceId: 'phone-one', deviceModel: 'CPH2495' } }
);

const bound = await api(`/api/guard/device?guardId=${GUARD_A}&deviceId=phone-one`);
check('the bound phone is ok', bound.json.standing === 'ok', bound.json);

const todayOne = await api(`/api/guard/today?guardId=${GUARD_A}&deviceId=phone-one`);
check('bound phone gets the full duty bundle', !todayOne.json.deviceBlocked && !!todayOne.json.bundle?.current, {
  blocked: todayOne.json.deviceBlocked,
  current: !!todayOne.json.bundle?.current,
});

console.log('\n--- a second phone ---');
const verify = await api('/api/guard/auth/verify-otp', {
  method: 'POST',
  body: { phone: '+919876500001', otp: '123456', deviceId: 'phone-two', deviceModel: 'SM-G991B' },
});
check('login on a second phone succeeds', verify.json.verified === true, verify.json);
check('but is reported as a pending device change', verify.json.deviceStatus === 'change_pending', verify.json.deviceStatus);

const todayTwo = await api(`/api/guard/today?guardId=${GUARD_A}&deviceId=phone-two`);
check('the second phone is blocked from duty data', todayTwo.json.deviceBlocked === true, todayTwo.json.deviceBlocked);
check('no assignment is leaked to it', todayTwo.json.bundle?.current === null, todayTwo.json.bundle?.current);
check('no roster is leaked to it', (todayTwo.json.bundle?.assignments ?? []).length === 0);
check('it is told why', todayTwo.json.bundle?.alerts?.[0]?.key === 'device_change_pending', todayTwo.json.bundle?.alerts);
check('the guard identity is still returned so the app can render', !!todayTwo.json.bundle?.guard?.name, todayTwo.json.bundle?.guard);

const todayOneStill = await api(`/api/guard/today?guardId=${GUARD_A}&deviceId=phone-one`);
check('the original phone keeps working throughout', !todayOneStill.json.deviceBlocked && !!todayOneStill.json.bundle?.current);

console.log('\n--- a third phone while a change is pending ---');
const todayThree = await api(`/api/guard/today?guardId=${GUARD_A}&deviceId=phone-three`);
check('third phone blocked', todayThree.json.deviceBlocked === true, todayThree.json.deviceBlocked);
check('and reported as blocked, not merely pending', todayThree.json.deviceStanding === 'blocked', todayThree.json.deviceStanding);

console.log('\n--- approval ---');
const noKey = await api('/api/guard/device', { method: 'POST', body: { guardId: GUARD_A, decision: 'approve' } });
check('approval refuses without the admin key', noKey.status === 401, noKey.status);

const badDecision = await api('/api/guard/device', {
  method: 'POST',
  headers: ADMIN,
  body: { guardId: GUARD_A, decision: 'maybe' },
});
check('unknown decision refused', badDecision.status === 400, badDecision.status);

const approve = await api('/api/guard/device', {
  method: 'POST',
  headers: ADMIN,
  body: { guardId: GUARD_A, decision: 'approve', deviceModel: 'SM-G991B' },
});
check('approval accepted', approve.json.success === true && approve.json.decision === 'approve', approve.json);

const todayTwoAfter = await api(`/api/guard/today?guardId=${GUARD_A}&deviceId=phone-two`);
check('the new phone now gets duty data', !todayTwoAfter.json.deviceBlocked && !!todayTwoAfter.json.bundle?.current, {
  blocked: todayTwoAfter.json.deviceBlocked,
});

const todayOneAfter = await api(`/api/guard/today?guardId=${GUARD_A}&deviceId=phone-one`);
check('and the old phone loses it', todayOneAfter.json.deviceBlocked === true, todayOneAfter.json.deviceBlocked);

console.log('\n--- rejection ---');
await db.collection('guardappprofiles').updateOne(
  { guardId: GUARD_A },
  { $set: { boundDeviceId: 'phone-one', pendingDeviceId: 'phone-two' } }
);
const reject = await api('/api/guard/device', {
  method: 'POST',
  headers: ADMIN,
  body: { guardId: GUARD_A, decision: 'reject' },
});
check('rejection accepted', reject.json.success === true, reject.json);
const afterReject = await api(`/api/guard/device?guardId=${GUARD_A}&deviceId=phone-two`);
check('the rejected phone is blocked', afterReject.json.standing === 'blocked', afterReject.json);
const boundKept = await api(`/api/guard/device?guardId=${GUARD_A}&deviceId=phone-one`);
check('the original binding is kept', boundKept.json.standing === 'ok', boundKept.json);

console.log('\n--- support-assisted unbind ---');
const unbind = await api('/api/guard/device', {
  method: 'POST',
  headers: ADMIN,
  body: { guardId: GUARD_A, decision: 'unbind' },
});
check('unbind accepted', unbind.json.success === true, unbind.json);
const afterUnbind = await api(`/api/guard/device?guardId=${GUARD_A}&deviceId=phone-nine`);
check('any phone can now claim the binding', afterUnbind.json.standing === 'unbound', afterUnbind.json);

console.log('\n--- older app builds that send no device id ---');
const noDeviceId = await api(`/api/guard/today?guardId=${GUARD_A}`);
check('a request with no deviceId is not blocked', !noDeviceId.json.deviceBlocked, noDeviceId.json.deviceBlocked);

console.log('\n--- the admin can list pending changes ---');
await db.collection('guardappprofiles').updateOne(
  { guardId: GUARD_A },
  { $set: { boundDeviceId: 'phone-one', pendingDeviceId: 'phone-two' } }
);
const pendingList = await api('/api/guard/device?guardId=pending', { headers: ADMIN });
check('pending list returned', (pendingList.json.pending?.length ?? 0) >= 1, pendingList.json.pending?.length);
check('with the guard attached', !!pendingList.json.pending?.[0]?.guard?.name, pendingList.json.pending?.[0]?.guard);

await mongoose.disconnect();
console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
if (fail) console.log('FAILED: ' + failures.join(' | '));
process.exit(fail ? 1 : 0);
