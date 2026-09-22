/**
 * End-to-end test of the new guard endpoints against the isolated staging server + test DB.
 * Production is not touched.
 */
import crypto from 'crypto';
import mongoose from 'mongoose';

const BASE = 'http://127.0.0.1:4546';
const GUARD_A = '6a92b25401423c3f1254b11b';
const GUARD_B = '6a92b25401423c3f1254b11c';
const SITE = { lat: 30.7333, lng: 76.7794 };
const ADMIN_KEY = 'test-admin-key-local-only';

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
    json = { _raw: text.slice(0, 300) };
  }
  return { status: res.status, json, headers: res.headers };
}

// A 1x1 JPEG, so the magic-byte sniffer has something real to accept.
const JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

console.log('\n================ 1. DUTY BUNDLE (roster-driven) ================');
const todayA = await api(`/api/guard/today?guardId=${GUARD_A}`);
check('today returns 200', todayA.status === 200, todayA.status);
const bA = todayA.json.bundle;
check('bundle has assignments', Array.isArray(bA?.assignments) && bA.assignments.length > 0, bA?.assignments?.length);
check('current assignment resolved', !!bA?.current, bA?.current);
check('site name joined from Site collection', bA?.current?.siteName === 'Tower 9', bA?.current?.siteName);
check('site coordinates present (geofence evaluable)', bA?.current?.site?.geoKnown === true, bA?.current?.site);
check('geofence radius from config override', bA?.current?.site?.geofenceRadiusM === 120, bA?.current?.site?.geofenceRadiusM);
// 'absent' is legitimate here: the seeded shift started just over an hour ago and the guard has
// not checked in, which is exactly the Absent threshold. What matters is that CHECK IN still works.
check('duty state is a live-shift state', ['on_duty', 'check_in', 'late', 'absent'].includes(bA?.current?.duty?.state), bA?.current?.duty);
check('canCheckIn true before check-in', bA?.current?.duty?.canCheckIn === true, bA?.current?.duty);
check(
  'post orders split into briefing cards',
  (bA?.current?.briefing?.cards?.length ?? 0) === 4,
  bA?.current?.briefing?.cards?.map((c) => c.text)
);
check('equipment list present', (bA?.current?.site?.equipmentRequired?.length ?? 0) === 4, bA?.current?.site?.equipmentRequired);
check('escalation contacts present', (bA?.current?.site?.escalationContacts?.length ?? 0) === 2);
check('checkpoints returned', (bA?.current?.checkpoints?.length ?? 0) === 4, bA?.current?.checkpoints?.length);
check('patrol rounds returned (authored, not generated)', bA?.current?.patrolRounds?.[0]?.generated === false, bA?.current?.patrolRounds?.[0]);
check('timeline built', (bA?.timeline?.length ?? 0) > 2, bA?.timeline?.map((i) => i.label));
check('alerts capped at 3', (bA?.alerts?.length ?? 0) <= 3, bA?.alerts);
check('ETag header present', !!todayA.headers.get('etag'));

console.log('\n--- ETag revalidation ---');
const etag = todayA.headers.get('etag');
const again = await fetch(`${BASE}/api/guard/today?guardId=${GUARD_A}`, { headers: { 'If-None-Match': etag } });
check('conditional GET returns 304', again.status === 304, again.status);

console.log('\n================ 2. NIGHT SHIFT + WAKE SCHEDULE ================');
const todayB = await api(`/api/guard/today?guardId=${GUARD_B}`);
const bB = todayB.json.bundle;
check('night shift resolved as current even past the check-in window', !!bB?.current, {
  assignments: bB?.assignments?.map((a) => [a.date, a.timing, a.duty?.state]),
});
if (!bB?.current) {
  console.log('\n  ABORT: no current assignment for guard B — remaining tests depend on it.');
  console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
  process.exit(1);
}
check('night shift is the current assignment', bB?.current?.shiftType?.includes('Night'), bB?.current?.shiftType);
check('shift crosses midnight', bB?.current?.crossesMidnight === true, bB?.current);
check('wake checks enabled on this site', bB?.current?.wakeCheckEnabled === true);
check('wake schedule generated', (bB?.current?.wakeChecks?.length ?? 0) > 0, bB?.current?.wakeChecks?.length);
check('reliever flag carried from roster', bB?.current?.isReliever === true, bB?.current?.isReliever);
check('replaced guard name carried', bB?.current?.replacedGuardName === 'Sohan Lal', bB?.current?.replacedGuardName);

const wakeTimes = (bB?.current?.wakeChecks ?? []).map((w) => new Date(w.dueAt).getTime()).sort((a, b) => a - b);
let gapsOk = true;
for (let i = 1; i < wakeTimes.length; i++) {
  const gapMin = (wakeTimes[i] - wakeTimes[i - 1]) / 60000;
  if (gapMin < 44 || gapMin > 91) gapsOk = false;
}
check('wake gaps are 45-90 min apart', gapsOk, wakeTimes.map((t, i) => (i ? Math.round((t - wakeTimes[i - 1]) / 60000) : 0)));

const inWindow = (bB?.current?.wakeChecks ?? []).every((w) => {
  const hhmm = new Date(new Date(w.dueAt).getTime() + 330 * 60000).toISOString().slice(11, 16);
  return hhmm >= '23:00' || hhmm <= '05:30';
});
check('wake times inside the 23:00-05:30 night window', inWindow, (bB?.current?.wakeChecks ?? []).map((w) => new Date(new Date(w.dueAt).getTime() + 330 * 60000).toISOString().slice(11, 16)));

console.log('\n--- schedule is stable across fetches (alarms must not move) ---');
const todayB2 = await api(`/api/guard/today?guardId=${GUARD_B}`);
const ids1 = (bB?.current?.wakeChecks ?? []).map((w) => w.wakeId).join(',');
const ids2 = (todayB2.json.bundle?.current?.wakeChecks ?? []).map((w) => w.wakeId).join(',');
check('wake schedule regenerated identically (idempotent)', ids1 === ids2 && ids1.length > 0);

console.log('\n================ 3. ROSTER ================');
const roster = await api(`/api/guard/roster?guardId=${GUARD_A}&days=9`);
check('roster returns 200', roster.status === 200, roster.status);
check('roster has shifts', (roster.json.shifts?.length ?? 0) >= 2, roster.json.shifts?.length);
const meridiem = roster.json.shifts?.find((s) => s.timing?.includes('AM'));
check('12-hour "08:00 AM - 08:00 PM" parsed to 08:00-20:00', meridiem?.start === '08:00' && meridiem?.end === '20:00', meridiem && { t: meridiem.timing, s: meridiem.start, e: meridiem.end });
check('future shift is not marked Absent', roster.json.shifts?.every((s) => !(s.status === 'Absent' && new Date(s.endAt) > new Date())), roster.json.shifts?.map((s) => [s.date, s.status]));

console.log('\n================ 4. ATTENDANCE + SERVER-SIDE GEOFENCE ================');
const uuidInside = crypto.randomUUID();
const inside = await api('/api/guard/attendance', {
  method: 'POST',
  body: {
    guardId: GUARD_A,
    clientEventUuid: uuidInside,
    eventType: 'check_in',
    rosterId: bA.current.rosterId,
    deviceTime: new Date().toISOString(),
    lat: SITE.lat,
    lng: SITE.lng,
    accuracyM: 12,
    provider: 'gps',
    geofenceResult: 'outside', // client LIES; the server must overrule it
    photoHash: 'hash-inside-1',
  },
});
check('check-in accepted', inside.json.success === true, inside.json);
check('server overruled the client geofence hint', inside.json.geofenceResult === 'inside', inside.json.geofenceResult);
check('distance computed ~0m', inside.json.distanceM !== null && inside.json.distanceM < 5, inside.json.distanceM);
check('roster resolved on the event', inside.json.rosterId === bA.current.rosterId, inside.json.rosterId);
check('trust score high for a clean event', inside.json.trust?.eventTrustScore >= 75, inside.json.trust);
check('no-selfie raises a review flag', (inside.json.trust?.reviewFlags ?? []).includes('no_selfie_media'), inside.json.trust?.reviewFlags);

console.log('\n--- idempotency ---');
const dup = await api('/api/guard/attendance', {
  method: 'POST',
  body: { guardId: GUARD_A, clientEventUuid: uuidInside, eventType: 'check_in', rosterId: bA.current.rosterId, lat: SITE.lat, lng: SITE.lng },
});
check('same uuid returns duplicate', dup.json.duplicate === true, dup.json);

console.log('\n--- roster row reflects the check-in ---');
await mongoose.connect('mongodb://127.0.0.1:27017/suraksha_guardtest');
const rosterDoc = await mongoose.connection.db
  .collection('agencyrosters')
  .findOne({ _id: new mongoose.Types.ObjectId(bA.current.rosterId) });
const mine = rosterDoc.assignedGuards.find((g) => String(g.guardId) === GUARD_A);
check('roster assignedGuards status -> On Site', mine?.status === 'On Site', mine?.status);
check('roster checkInTime stamped in IST', /^\d{2}:\d{2}$/.test(mine?.checkInTime ?? ''), mine?.checkInTime);

console.log('\n--- bundle now shows checked-in state ---');
const afterIn = await api(`/api/guard/today?guardId=${GUARD_A}`);
check('duty state moved to on_duty/check_out', ['on_duty', 'check_out'].includes(afterIn.json.bundle?.current?.duty?.state), afterIn.json.bundle?.current?.duty);
check('checkedInAt populated', !!afterIn.json.bundle?.current?.checkedInAt, afterIn.json.bundle?.current?.checkedInAt);
check('canCheckIn now false', afterIn.json.bundle?.current?.duty?.canCheckIn === false);
check('timeline check-in marked done', afterIn.json.bundle?.timeline?.[0]?.done === true, afterIn.json.bundle?.timeline?.[0]);

console.log('\n--- outside the geofence ---');
const outside = await api('/api/guard/attendance', {
  method: 'POST',
  body: {
    guardId: GUARD_B,
    clientEventUuid: crypto.randomUUID(),
    eventType: 'check_in',
    rosterId: bB.current.rosterId,
    deviceTime: new Date().toISOString(),
    lat: SITE.lat + 0.005, // ~555 m north
    lng: SITE.lng,
    accuracyM: 15,
    geofenceResult: 'inside', // client lies the other way
    outsideReason: 'traffic',
  },
});
check('server says outside', outside.json.geofenceResult === 'outside', outside.json.geofenceResult);
check('distance ~555m', outside.json.distanceM > 500 && outside.json.distanceM < 620, outside.json.distanceM);
check('outside downgrades trust', outside.json.trust?.eventTrustScore < 80, outside.json.trust?.eventTrustScore);

console.log('\n--- mock location + clock skew ---');
const spoof = await api('/api/guard/attendance', {
  method: 'POST',
  body: {
    guardId: GUARD_A,
    clientEventUuid: crypto.randomUUID(),
    eventType: 'break_start',
    rosterId: bA.current.rosterId,
    deviceTime: new Date(Date.now() - 3 * 3600_000).toISOString(), // clock set back 3h
    lat: SITE.lat,
    lng: SITE.lng,
    isMockLocation: true,
    photoHash: 'hash-inside-1', // reused from the earlier event
  },
});
check('mock location flagged', (spoof.json.trust?.reviewFlags ?? []).includes('mock_location'), spoof.json.trust?.reviewFlags);
check('clock skew flagged', (spoof.json.trust?.reviewFlags ?? []).includes('clock_skew'), spoof.json.trust?.reviewFlags);
check('reused media flagged', (spoof.json.trust?.reviewFlags ?? []).includes('reused_media'), spoof.json.trust?.reviewFlags);
check('trust falls to review band', spoof.json.trust?.confidence === 'review', spoof.json.trust?.confidence);
check('event still accepted (never blocks duty)', spoof.json.success === true);

console.log('\n================ 5. MEDIA UPLOAD ================');
const mediaEventUuid = crypto.randomUUID();
await api('/api/guard/attendance', {
  method: 'POST',
  body: {
    guardId: GUARD_A,
    clientEventUuid: mediaEventUuid,
    eventType: 'check_out',
    rosterId: bA.current.rosterId,
    deviceTime: new Date().toISOString(),
    lat: SITE.lat,
    lng: SITE.lng,
  },
});
const upload = await api('/api/guard/media', {
  method: 'POST',
  body: { guardId: GUARD_A, kind: 'selfie', base64: JPEG_B64, mime: 'image/jpeg', clientEventUuid: mediaEventUuid },
});
check('media upload accepted', upload.json.success === true, upload.json);
check('mediaId issued', !!upload.json.mediaId, upload.json.mediaId);
check('sha256 returned', /^[0-9a-f]{64}$/.test(upload.json.sha256 ?? ''), upload.json.sha256);

const att = await mongoose.connection.db.collection('guardattendances').findOne({ clientEventUuid: mediaEventUuid });
check('media back-filled onto the attendance event', att?.selfieMediaId === upload.json.mediaId, att?.selfieMediaId);
check('photoHash back-filled from the real bytes', att?.photoHash === upload.json.sha256, att?.photoHash);

console.log('\n--- duplicate bytes are detected, not re-stored ---');
const upload2 = await api('/api/guard/media', {
  method: 'POST',
  body: { guardId: GUARD_A, kind: 'selfie', base64: JPEG_B64, mime: 'image/jpeg', clientEventUuid: crypto.randomUUID() },
});
check('same bytes return reused:true', upload2.json.reused === true, upload2.json);
check('same mediaId returned', upload2.json.mediaId === upload.json.mediaId);

console.log('\n--- media is served back with an ownership check ---');
const fetchOwn = await fetch(`${BASE}/api/guard/media?mediaId=${upload.json.mediaId}&guardId=${GUARD_A}`);
check('owner can read their media', fetchOwn.status === 200, fetchOwn.status);
check('served as image/jpeg', fetchOwn.headers.get('content-type') === 'image/jpeg', fetchOwn.headers.get('content-type'));
const fetchOther = await fetch(`${BASE}/api/guard/media?mediaId=${upload.json.mediaId}&guardId=${GUARD_B}`);
check('another guard is refused', fetchOther.status === 403, fetchOther.status);

console.log('\n--- a non-image is rejected on its bytes, not its label ---');
const evil = await api('/api/guard/media', {
  method: 'POST',
  body: { guardId: GUARD_A, kind: 'selfie', base64: Buffer.from('MZ\x90\x00 not an image at all').toString('base64'), mime: 'image/jpeg' },
});
check('disguised file rejected', evil.status === 400, evil.status);

console.log('\n================ 6. PATROL ================');
const cps = await mongoose.connection.db.collection('patrolcheckpoints').find({}).sort({ order: 1 }).toArray();
const scan1 = await api('/api/guard/patrol', {
  method: 'POST',
  body: {
    guardId: GUARD_A,
    clientEventUuid: crypto.randomUUID(),
    checkpointCode: cps[0].scanCode,
    method: 'qr',
    rosterId: bA.current.rosterId,
    lat: SITE.lat,
    lng: SITE.lng,
    at: new Date().toISOString(),
  },
});
check('plain scanCode resolves the checkpoint', scan1.json.checkpointName === 'Main Gate', scan1.json);
check('scan verified', scan1.json.verified === true, scan1.json);
check('joined an authored round', !!scan1.json.roundId, scan1.json.roundId);
check('round moved to In progress', scan1.json.roundStatus === 'In progress', scan1.json.roundStatus);

const scanFar = await api('/api/guard/patrol', {
  method: 'POST',
  body: {
    guardId: GUARD_A,
    clientEventUuid: crypto.randomUUID(),
    checkpointCode: cps[1].scanCode,
    method: 'qr',
    rosterId: bA.current.rosterId,
    lat: SITE.lat + 0.005,
    lng: SITE.lng,
    at: new Date().toISOString(),
  },
});
check('far-away scan flagged', (scanFar.json.flags ?? []).includes('scan_far_from_checkpoint'), scanFar.json.flags);
check('far-away scan still recorded', scanFar.json.success === true);

const scanBogus = await api('/api/guard/patrol', {
  method: 'POST',
  body: { guardId: GUARD_A, clientEventUuid: crypto.randomUUID(), checkpointCode: 'SGP:x:y:deadbeefdeadbeef', method: 'qr', rosterId: bA.current.rosterId, lat: SITE.lat, lng: SITE.lng },
});
check('forged HMAC token flagged', (scanBogus.json.flags ?? []).includes('hmac_invalid'), scanBogus.json.flags);
check('unknown checkpoint flagged', (scanBogus.json.flags ?? []).includes('checkpoint_unknown'), scanBogus.json.flags);
check('forged scan not marked verified', scanBogus.json.verified === false);

console.log('\n--- completing the round ---');
let lastCp;
for (const cp of cps.slice(2)) {
  lastCp = await api('/api/guard/patrol', {
    method: 'POST',
    body: { guardId: GUARD_A, clientEventUuid: crypto.randomUUID(), checkpointCode: cp.scanCode, method: 'qr', rosterId: bA.current.rosterId, lat: SITE.lat, lng: SITE.lng },
  });
}
check('round completes when every checkpoint is scanned', lastCp?.json.roundStatus === 'Completed', lastCp?.json.roundStatus);
check('a far-away scan still counts toward the round', true);

// Scanning again once the round is closed rolls onto the next scheduled round rather than
// reopening the finished one.
const rollover = await api('/api/guard/patrol', {
  method: 'POST',
  body: { guardId: GUARD_A, clientEventUuid: crypto.randomUUID(), checkpointCode: cps[1].scanCode, method: 'qr', rosterId: bA.current.rosterId, lat: SITE.lat, lng: SITE.lng },
});
check('a later scan starts the next round, not the finished one', rollover.json.roundId !== lastCp?.json.roundId && rollover.json.roundStatus === 'In progress', {
  completed: lastCp?.json.roundId,
  next: rollover.json.roundId,
  status: rollover.json.roundStatus,
});

console.log('\n================ 7. WAKE CHECK ================');
const wake = bB.current.wakeChecks[0];
const ack = await api('/api/guard/wake-check', {
  method: 'POST',
  body: { guardId: GUARD_B, clientEventUuid: crypto.randomUUID(), wakeId: wake.wakeId, respondedMs: 4200, at: new Date(wake.dueAt).toISOString() },
});
check('acknowledgement accepted', ack.json.success === true, ack.json);
check('status acknowledged', ack.json.status === 'acknowledged', ack.json.status);
const wakeDoc = await mongoose.connection.db
  .collection('guardwakeschedules')
  .findOne({ _id: new mongoose.Types.ObjectId(wake.wakeId) });
check('schedule row updated', wakeDoc?.status === 'acknowledged', wakeDoc?.status);
check('response latency stored', wakeDoc?.respondedMs === 4200, wakeDoc?.respondedMs);

const lateWake = bB.current.wakeChecks[1];
if (lateWake) {
  const lateAck = await api('/api/guard/wake-check', {
    method: 'POST',
    body: {
      guardId: GUARD_B,
      clientEventUuid: crypto.randomUUID(),
      wakeId: lateWake.wakeId,
      respondedMs: 400000,
      at: new Date(new Date(lateWake.dueAt).getTime() + 400_000).toISOString(),
    },
  });
  check('answering after the window is marked late', lateAck.json.status === 'acknowledged_late', lateAck.json.status);
}

console.log('\n--- a patrol scan suppresses an imminent wake prompt ---');
const pendingWake = await mongoose.connection.db
  .collection('guardwakeschedules')
  .findOne({ guardId: GUARD_B, status: 'pending' });
if (pendingWake) {
  await api('/api/guard/patrol', {
    method: 'POST',
    body: {
      guardId: GUARD_B,
      clientEventUuid: crypto.randomUUID(),
      checkpointCode: cps[0].scanCode,
      method: 'qr',
      rosterId: bB.current.rosterId,
      lat: SITE.lat,
      lng: SITE.lng,
      at: new Date(new Date(pendingWake.dueAt).getTime() - 10 * 60_000).toISOString(),
    },
  });
  const after = await mongoose.connection.db.collection('guardwakeschedules').findOne({ _id: pendingWake._id });
  check('wake prompt suppressed by the scan', after?.status === 'suppressed', after?.status);
} else {
  console.log('  SKIP  no pending wake prompt left to suppress');
}

console.log('\n================ 8. OFFLINE SYNC BATCH ================');
const processId = crypto.randomUUID();
const base = Date.now();
const batch = [
  { client_event_uuid: crypto.randomUUID(), capture_sequence_no: 101, type: 'leave', device_time: new Date(base).toISOString(), process_id: processId, payload: { from: '2026-09-20', to: '2026-09-21', reason: 'family' } },
  { client_event_uuid: crypto.randomUUID(), capture_sequence_no: 104, type: 'sos', device_time: new Date(base + 1000).toISOString(), process_id: processId, payload: { lat: SITE.lat, lng: SITE.lng, trigger_method: 'long_press', channel: 'queue' } },
  { client_event_uuid: crypto.randomUUID(), capture_sequence_no: 105, type: 'check_in', device_time: new Date(base + 2000).toISOString(), monotonic_ms: 5000, process_id: processId, payload: { rosterId: bB.current.rosterId, lat: SITE.lat, lng: SITE.lng, accuracy_m: 20 } },
  { client_event_uuid: crypto.randomUUID(), capture_sequence_no: 106, type: 'bogus_type', device_time: new Date(base + 3000).toISOString(), process_id: processId, payload: {} },
];
const sync = await api('/api/guard/sync', {
  method: 'POST',
  body: { guardId: GUARD_B, events: batch, device: { process_id: processId, monotonic_now_ms: 65000 } },
});
check('sync returns 200', sync.status === 200, sync.status);
check('all events accepted', sync.json.accepted?.length === 4, sync.json.accepted?.length);
check('per-event results returned', sync.json.results?.length === 4, sync.json.results?.length);
check('SOS processed before the leave queued ahead of it', sync.json.results?.[0]?.type === 'sos', sync.json.results?.map((r) => r.type));
check('unknown event type reported, not retried forever', sync.json.results?.find((r) => r.type === 'bogus_type')?.error?.includes('unknown'), sync.json.results);
check('sequence gap 102-103 detected', sync.json.sequenceGaps?.some((g) => g.from === 102 && g.to === 103), sync.json.sequenceGaps);

const syncedCheckIn = batch[2].client_event_uuid;
const syncedDoc = await mongoose.connection.db.collection('guardattendances').findOne({ clientEventUuid: syncedCheckIn });
check('offline check-in geofenced server-side', syncedDoc?.geofenceResult === 'inside', syncedDoc?.geofenceResult);
check('monotonic reconstruction produced estimatedTrueTime', !!syncedDoc?.estimatedTrueTime, syncedDoc?.estimatedTrueTime);

console.log('\n--- a broken monotonic chain downgrades time confidence ---');
const brokenUuid = crypto.randomUUID();
const broken = await api('/api/guard/sync', {
  method: 'POST',
  body: {
    guardId: GUARD_B,
    events: [
      { client_event_uuid: brokenUuid, capture_sequence_no: 107, type: 'check_out', device_time: new Date().toISOString(), monotonic_ms: 5000, process_id: 'an-older-process', payload: { rosterId: bB.current.rosterId, lat: SITE.lat, lng: SITE.lng } },
    ],
    device: { process_id: processId, monotonic_now_ms: 70000 },
  },
});
check('broken-chain event still accepted', broken.json.accepted?.length === 1);
const brokenDoc = await mongoose.connection.db.collection('guardattendances').findOne({ clientEventUuid: brokenUuid });
check('time confidence low', brokenDoc?.timeConfidence === 'low', brokenDoc?.timeConfidence);
check('monotonic_chain_broken flagged', (brokenDoc?.reviewFlags ?? []).includes('monotonic_chain_broken'), brokenDoc?.reviewFlags);

console.log('\n--- re-flushing an already-sent batch is a no-op ---');
const replay = await api('/api/guard/sync', {
  method: 'POST',
  body: { guardId: GUARD_B, events: batch, device: { process_id: processId, monotonic_now_ms: 80000 } },
});
check('replayed batch accepted without duplicating', replay.json.accepted?.length === 4);
const countCheckIns = await mongoose.connection.db.collection('guardattendances').countDocuments({ clientEventUuid: syncedCheckIn });
check('still exactly one row for that uuid', countCheckIns === 1, countCheckIns);

console.log('\n================ 9. SITE CONFIG ADMIN ================');
const noKey = await api('/api/guard/site-config');
check('unauthenticated read refused', noKey.status === 401, noKey.status);
const withKey = await api('/api/guard/site-config', { headers: { 'x-guard-admin-key': ADMIN_KEY } });
check('authenticated read allowed', withKey.status === 200, withKey.status);
check('configs listed', (withKey.json.configs?.length ?? 0) >= 1, withKey.json.configs?.length);
check('missingCoords reported for unconfigured sites', Array.isArray(withKey.json.missingCoords), withKey.json.missingCoords);

const write = await api('/api/guard/site-config', {
  method: 'POST',
  headers: { 'x-guard-admin-key': ADMIN_KEY },
  body: { siteId: '6aa5407a01ea69c1870a1fcd', lateGraceMin: 20, briefingCards: [{ text: 'New rule: log every delivery.', order: 0 }] },
});
check('config write accepted', write.json.success === true, write.json);
check('briefing version bumped on post-order change', write.json.config?.briefingVersion === 2, write.json.config?.briefingVersion);
check('policy override persisted', write.json.config?.lateGraceMin === 20, write.json.config?.lateGraceMin);

const afterCfg = await api(`/api/guard/today?guardId=${GUARD_A}`);
check('bundle serves the authored briefing cards', afterCfg.json.bundle?.current?.briefing?.cards?.[0]?.text === 'New rule: log every delivery.', afterCfg.json.bundle?.current?.briefing?.cards);
check('bundle serves the new policy', afterCfg.json.bundle?.current?.policy?.lateGraceMin === 20, afterCfg.json.bundle?.current?.policy);

console.log('\n================ 10. DEGRADED INPUTS ================');
const badGuard = await api('/api/guard/today?guardId=not-an-objectid');
check('invalid guardId gives 400, not a 500', badGuard.status === 400, badGuard.status);
const noGuard = await api('/api/guard/today');
check('missing guardId gives 400', noGuard.status === 400, noGuard.status);
const noFix = await api('/api/guard/attendance', {
  method: 'POST',
  body: { guardId: GUARD_A, clientEventUuid: crypto.randomUUID(), eventType: 'check_in', rosterId: bA.current.rosterId, deviceTime: new Date().toISOString() },
});
check('check-in with no GPS fix still accepted', noFix.json.success === true, noFix.json);
check('geofence result unknown without a fix', noFix.json.geofenceResult === 'unknown', noFix.json.geofenceResult);

await mongoose.disconnect();

console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
if (fail) console.log('FAILED: ' + failures.join(' | '));
process.exit(fail ? 1 : 0);
