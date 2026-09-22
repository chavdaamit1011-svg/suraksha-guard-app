/**
 * Supervisor (field) tab — team view, verification, proxy attendance, site visits.
 * Runs against the isolated staging server and test DB. Production is never touched.
 */
import crypto from 'crypto';
import mongoose from 'mongoose';

const BASE = 'http://127.0.0.1:4546';
const GUARD_A = '6a92b25401423c3f1254b11b'; // day shift at Tower 9
const GUARD_B = '6a92b25401423c3f1254b11c'; // night shift at Tower 9
const ADMIN = { 'x-guard-admin-key': 'test-admin-key-local-only' };
const SITE = { lat: 30.7333, lng: 76.7794 };

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

await mongoose.connect('mongodb://127.0.0.1:27017/suraksha_guardtest');
const db = mongoose.connection.db;

console.log('\n================ 1. A PLAIN GUARD HAS NO TEAM TAB ================');
const asGuard = await api(`/api/guard/supervisor/team?guardId=${GUARD_B}`);
check('request succeeds', asGuard.status === 200, asGuard.status);
check('but isSupervisor is false', asGuard.json.isSupervisor === false, asGuard.json);
check('and no team is leaked', (asGuard.json.team?.length ?? 0) === 0);

console.log('\n================ 2. GRANTING SUPERVISOR AUTHORITY ================');
const noKey = await api('/api/guard/supervisor/grant', { method: 'POST', body: { guardId: GUARD_A } });
check('grant refuses without the admin key', noKey.status === 401, noKey.status);

const grant = await api('/api/guard/supervisor/grant', {
  method: 'POST',
  headers: ADMIN,
  body: { guardId: GUARD_A, isSupervisor: true, permissions: ['attendance.verify', 'attendance.proxy'] },
});
check('grant accepted', grant.json.success === true, grant.json);

const badPerm = await api('/api/guard/supervisor/grant', {
  method: 'POST',
  headers: ADMIN,
  body: { guardId: GUARD_A, permissions: ['delete.everything'] },
});
check('unknown permission refused', badPerm.status === 400, badPerm.status);

console.log('\n================ 3. THE TEAM VIEW ================');
const team = await api(`/api/guard/supervisor/team?guardId=${GUARD_A}`);
check('isSupervisor now true', team.json.isSupervisor === true, team.json.isSupervisor);
check('can verify', team.json.canVerify === true);
check('can proxy', team.json.canProxy === true);
check('broadcast withheld (not granted)', team.json.canBroadcast === false, team.json.canBroadcast);
check('team populated from the supervisor\'s own sites', (team.json.team?.length ?? 0) >= 1, team.json.team?.length);
check('site scope reported', (team.json.siteNames ?? []).includes('Tower 9'), team.json.siteNames);

const mateB = team.json.team?.find((m) => m.guardId === GUARD_B);
check('the night-shift guard is on the team', !!mateB, team.json.team?.map((m) => [m.name, m.state]));
check('each member carries a live state chip', typeof mateB?.state === 'string', mateB?.state);
check('counts returned', typeof team.json.counts?.total === 'number', team.json.counts);

console.log('\n================ 4. THE REVIEW QUEUE ================');
// Plant a check-in that the trust engine will flag: outside the geofence, mock location.
const flaggedUuid = crypto.randomUUID();
const mateRosterId = mateB?.rosterId;
const flagged = await api('/api/guard/attendance', {
  method: 'POST',
  body: {
    guardId: GUARD_B,
    clientEventUuid: flaggedUuid,
    eventType: 'check_in',
    rosterId: mateRosterId,
    deviceTime: new Date().toISOString(),
    lat: SITE.lat + 0.01, // ~1.1 km away
    lng: SITE.lng,
    accuracyM: 30,
    isMockLocation: true,
    outsideReason: 'traffic',
  },
});
check('flagged event accepted (never blocked)', flagged.json.success === true, flagged.json);
check('confidence is not high', flagged.json.trust?.confidence !== 'high', flagged.json.trust);

const withQueue = await api(`/api/guard/supervisor/team?guardId=${GUARD_A}`);
const queued = withQueue.json.reviewQueue?.find((i) => i.itemId === flaggedUuid);
check('flagged event appears in the review queue', !!queued, withQueue.json.reviewQueue?.map((i) => i.itemId));
check('queue item carries the flags', (queued?.flags ?? []).includes('mock_location'), queued?.flags);
check('queue item carries the distance', queued?.distanceM > 1000, queued?.distanceM);
check("queue item carries the guard's stated reason", queued?.outsideReason === 'traffic', queued?.outsideReason);

console.log('\n================ 5. VERIFICATION ================');
const rejectNoReason = await api('/api/guard/supervisor/verify', {
  method: 'POST',
  body: { supervisorId: GUARD_A, itemId: flaggedUuid, kind: 'attendance', decision: 'rejected' },
});
check('rejecting without a reason is refused', rejectNoReason.status === 400, rejectNoReason.status);

const badReason = await api('/api/guard/supervisor/verify', {
  method: 'POST',
  body: { supervisorId: GUARD_A, itemId: flaggedUuid, kind: 'attendance', decision: 'approved', reason: 'made_up' },
});
check('unknown reason code refused', badReason.status === 400, badReason.status);

const byNonSupervisor = await api('/api/guard/supervisor/verify', {
  method: 'POST',
  body: { supervisorId: GUARD_B, itemId: flaggedUuid, kind: 'attendance', decision: 'approved' },
});
check('a plain guard cannot verify', byNonSupervisor.status === 403, byNonSupervisor.status);

const approve = await api('/api/guard/supervisor/verify', {
  method: 'POST',
  body: {
    supervisorId: GUARD_A,
    itemId: flaggedUuid,
    kind: 'attendance',
    decision: 'approved',
    reason: 'confirmed_present',
  },
});
check('supervisor approval accepted', approve.json.success === true && approve.json.decision === 'approved', approve.json);

const decided = await db.collection('guardattendances').findOne({ clientEventUuid: flaggedUuid });
check('decision recorded with the supervisor identity', decided?.reviewedBy === GUARD_A, decided?.reviewedBy);
check('reason recorded', decided?.reviewReason === 'confirmed_present', decided?.reviewReason);
check('confidence restored on approval', decided?.confidence === 'high', decided?.confidence);

console.log('\n--- the original capture is never rewritten ---');
check('original flags intact', (decided?.reviewFlags ?? []).includes('mock_location'), decided?.reviewFlags);
check('original geofence verdict intact', decided?.geofenceResult === 'outside', decided?.geofenceResult);
check('original distance intact', decided?.distanceM > 1000, decided?.distanceM);
check('original trust score intact', decided?.eventTrustScore < 75, decided?.eventTrustScore);

console.log('\n--- deciding twice ---');
const again = await api('/api/guard/supervisor/verify', {
  method: 'POST',
  body: { supervisorId: GUARD_A, itemId: flaggedUuid, kind: 'attendance', decision: 'rejected', reason: 'not_at_post' },
});
check('a settled item reports its existing decision', again.json.alreadyDecided === true && again.json.decision === 'approved', again.json);

const afterSecond = await db.collection('guardattendances').findOne({ clientEventUuid: flaggedUuid });
check('the second attempt did not overwrite the first', afterSecond?.reviewDecision === 'approved', afterSecond?.reviewDecision);

console.log('\n--- resolved items leave the queue ---');
const cleared = await api(`/api/guard/supervisor/team?guardId=${GUARD_A}`);
check('decided item no longer queued', !cleared.json.reviewQueue?.some((i) => i.itemId === flaggedUuid));

console.log('\n================ 6. PROXY ATTENDANCE ================');
// Clear the night guard's attendance so a proxy check-in is meaningful.
await db.collection('guardattendances').deleteMany({ guardId: GUARD_B });

const noReason = await api('/api/guard/supervisor/proxy', {
  method: 'POST',
  body: { supervisorId: GUARD_A, subjectGuardId: GUARD_B, eventType: 'check_in', rosterId: mateRosterId },
});
check('proxy without a reason is refused', noReason.status === 400, noReason.status);

const proxyByGuard = await api('/api/guard/supervisor/proxy', {
  method: 'POST',
  body: {
    supervisorId: GUARD_B,
    subjectGuardId: GUARD_A,
    eventType: 'check_in',
    rosterId: mateRosterId,
    reason: 'phone_dead',
  },
});
check('a plain guard cannot proxy', proxyByGuard.status === 403, proxyByGuard.status);

const proxyUuid = crypto.randomUUID();
const proxy = await api('/api/guard/supervisor/proxy', {
  method: 'POST',
  body: {
    supervisorId: GUARD_A,
    subjectGuardId: GUARD_B,
    rosterId: mateRosterId,
    eventType: 'check_in',
    reason: 'phone_dead',
    clientEventUuid: proxyUuid,
    deviceTime: new Date().toISOString(),
    lat: SITE.lat,
    lng: SITE.lng,
    accuracyM: 10,
  },
});
check('proxy accepted', proxy.json.success === true, proxy.json);
check('geofenced against the supervisor position', proxy.json.geofenceResult === 'inside', proxy.json.geofenceResult);
check('reported as flagged', proxy.json.flagged === true);

const proxyDoc = await db.collection('guardattendances').findOne({ clientEventUuid: proxyUuid });
check('recorded against the SUBJECT guard', proxyDoc?.guardId === GUARD_B, proxyDoc?.guardId);
check('names the acting supervisor', proxyDoc?.proxyBy === GUARD_A, proxyDoc?.proxyBy);
check('always flagged', (proxyDoc?.reviewFlags ?? []).includes('proxy_attendance'), proxyDoc?.reviewFlags);
check('never high confidence, however good the signals', proxyDoc?.confidence === 'low', proxyDoc?.confidence);
check('reason stored', proxyDoc?.meta?.proxyReason === 'phone_dead', proxyDoc?.meta?.proxyReason);

console.log('\n--- the team view shows it as a proxy ---');
const afterProxy = await api(`/api/guard/supervisor/team?guardId=${GUARD_A}`);
const proxied = afterProxy.json.team?.find((m) => m.guardId === GUARD_B);
check('member now shows checked in', !!proxied?.checkedInAt, proxied?.checkedInAt);
check('and is marked as proxied', proxied?.proxyBy === GUARD_A, proxied?.proxyBy);

console.log('\n--- the supervisor can see their own proxy history ---');
const history = await api(`/api/guard/supervisor/proxy?supervisorId=${GUARD_A}`);
check('proxy history returned', (history.json.events?.length ?? 0) >= 1, history.json.events?.length);

console.log('\n================ 7. OUT-OF-SCOPE GUARDS ================');
// A guard rostered nowhere near this supervisor's sites.
const stranger = await db.collection('apguards').findOne({ id: 'G-FREE-1' });
const outOfScope = await api('/api/guard/supervisor/proxy', {
  method: 'POST',
  body: {
    supervisorId: GUARD_A,
    subjectGuardId: String(stranger._id),
    eventType: 'check_in',
    reason: 'phone_dead',
  },
});
check('cannot proxy a guard who is not on the team', outOfScope.status === 403, outOfScope.status);

console.log('\n================ 8. SITE VISIT ================');
const visitUuid = crypto.randomUUID();
const visit = await api('/api/guard/supervisor/site-visit', {
  method: 'POST',
  body: {
    supervisorId: GUARD_A,
    siteName: 'Tower 9',
    clientEventUuid: visitUuid,
    lat: SITE.lat,
    lng: SITE.lng,
    notes: 'Gate manned, register up to date.',
    guardsSeen: [GUARD_B],
  },
});
check('site visit recorded', visit.json.success === true, visit.json);
check('geo-stamped against the site', visit.json.geofenceResult === 'inside', visit.json.geofenceResult);

const visitDoc = await db.collection('guardfieldevents').findOne({ clientEventUuid: visitUuid });
check('stored as a site_visit', visitDoc?.kind === 'site_visit', visitDoc?.kind);
check('notes stored', visitDoc?.reason?.includes('register'), visitDoc?.reason);
check('guards seen recorded', (visitDoc?.meta?.guardsSeen ?? []).includes(GUARD_B), visitDoc?.meta?.guardsSeen);

const visitFar = await api('/api/guard/supervisor/site-visit', {
  method: 'POST',
  body: {
    supervisorId: GUARD_A,
    siteName: 'Tower 9',
    clientEventUuid: crypto.randomUUID(),
    lat: SITE.lat + 0.02,
    lng: SITE.lng,
    notes: 'Claiming a visit from 2 km away',
  },
});
check('a visit logged from far away is marked outside', visitFar.json.geofenceResult === 'outside', visitFar.json);

const visits = await api(`/api/guard/supervisor/site-visit?supervisorId=${GUARD_A}`);
check('visit history returned', (visits.json.visits?.length ?? 0) >= 2, visits.json.visits?.length);

console.log('\n================ 9. REVOKING ================');
await api('/api/guard/supervisor/grant', {
  method: 'POST',
  headers: ADMIN,
  body: { guardId: GUARD_A, isSupervisor: false },
});
const revoked = await api(`/api/guard/supervisor/team?guardId=${GUARD_A}`);
// The title-based fallback still applies, so an explicit revoke only bites when the job title
// is not itself supervisory. Guard A is a 'Gate Guard', so the tab should now be gone.
check('revoked supervisor loses the tab', revoked.json.isSupervisor === false, revoked.json.isSupervisor);

const revokedVerify = await api('/api/guard/supervisor/verify', {
  method: 'POST',
  body: { supervisorId: GUARD_A, itemId: proxyUuid, kind: 'attendance', decision: 'approved' },
});
check('and loses the authority with it', revokedVerify.status === 403, revokedVerify.status);

await mongoose.disconnect();
console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
if (fail) console.log('FAILED: ' + failures.join(' | '));
process.exit(fail ? 1 : 0);
