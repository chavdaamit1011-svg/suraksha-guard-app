/**
 * Round 6: regressions for bugs found while testing the APK on a phone.
 *  - a check-in selfie uploaded before its record was never linked (and face check never ran)
 *  - the "no photo" flag stayed after the photo arrived
 *  - guard incidents were invisible to the agency portal (no agencyOwnerId), had no site name,
 *    and lost priority / location / injury answers / media to the strict Incident schema
 *  - a voice-only incident was rejected online
 *  - document alerts ignored expiry; alerts carried no count for translation
 * Runs against the staging server and test DB (never production).
 */
import crypto from 'crypto';
import mongoose from 'mongoose';

const BASE = 'http://127.0.0.1:4546';
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
async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = {};
  }
  return { status: res.status, json };
}
const uuid = () => crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
);
async function upload(kind, clientEventUuid) {
  const bytes = Buffer.concat([JPEG, crypto.randomBytes(8)]);
  const r = await api('/api/guard/media', {
    method: 'POST',
    body: { guardId: GUARD_A, kind, clientEventUuid, base64: bytes.toString('base64'), mime: 'image/jpeg' },
  });
  return r.json.mediaId;
}

await mongoose.connect('mongodb://127.0.0.1:27017/suraksha_guardtest');
const db = mongoose.connection.db;
const guard = await db.collection('apguards').findOne({ _id: new mongoose.Types.ObjectId(GUARD_A) });
const roster = await db.collection('agencyrosters').findOne({ 'assignedGuards.guardId': new mongoose.Types.ObjectId(GUARD_A) });

console.log('\n# Selfie uploaded before its check-in record');
{
  const u = uuid();
  const mediaId = await upload('selfie', u);
  const r = await api('/api/guard/sync', {
    method: 'POST',
    body: {
      guardId: GUARD_A,
      events: [{ client_event_uuid: u, capture_sequence_no: 920001, type: 'check_in', device_time: new Date().toISOString(), payload: { rosterId: String(roster._id), lat: 30.7333, lng: 76.7794, accuracy_m: 10 } }],
    },
  });
  check('check-in accepted', r.json.accepted?.includes(u), r.json);
  await sleep(1500);
  const att = await db.collection('guardattendances').findOne({ clientEventUuid: u });
  check('early selfie linked to the record', att?.selfieMediaId === mediaId, att?.selfieMediaId);
  check('no false "no photo" flag', !att?.reviewFlags?.includes('no_selfie_media'), att?.reviewFlags);
  check('face check ran for the late-linked selfie', !!att?.livenessResult, att?.livenessResult);
}

console.log('\n# Selfie uploaded after its record');
{
  const u = uuid();
  await api('/api/guard/sync', {
    method: 'POST',
    body: {
      guardId: GUARD_A,
      events: [{ client_event_uuid: u, capture_sequence_no: 920002, type: 'check_out', device_time: new Date().toISOString(), payload: { rosterId: String(roster._id), lat: 30.7333, lng: 76.7794 } }],
    },
  });
  let att = await db.collection('guardattendances').findOne({ clientEventUuid: u });
  check('record flagged while the photo is missing', att?.reviewFlags?.includes('no_selfie_media'), att?.reviewFlags);
  const mediaId = await upload('selfie', u);
  att = await db.collection('guardattendances').findOne({ clientEventUuid: u });
  check('photo linked on arrival', att?.selfieMediaId === mediaId);
  check('"no photo" flag removed once it arrives', !att?.reviewFlags?.includes('no_selfie_media'), att?.reviewFlags);
}

console.log('\n# Selfie and record arriving at the same moment (seen on a phone: 12 ms apart)');
{
  let linked = 0;
  const N = 10;
  for (let k = 0; k < N; k++) {
    const u = uuid();
    const [mediaId] = await Promise.all([
      upload('selfie', u),
      api('/api/guard/sync', {
        method: 'POST',
        body: {
          guardId: GUARD_A,
          events: [{ client_event_uuid: u, capture_sequence_no: 930000 + k, type: k % 2 ? 'check_out' : 'check_in', device_time: new Date().toISOString(), payload: { rosterId: String(roster._id) } }],
        },
      }),
    ]);
    await sleep(300);
    const att = await db.collection('guardattendances').findOne({ clientEventUuid: u });
    if (att?.selfieMediaId === mediaId && !att.reviewFlags?.includes('no_selfie_media')) linked++;
  }
  check(`concurrent upload + record always linked (${N} tries)`, linked === N, linked);
}

console.log('\n# Incidents');
{
  const u = uuid();
  const early = await upload('incident_photo', u);
  let r = await api('/api/guard/incident', {
    method: 'POST',
    body: { guardId: GUARD_A, clientEventUuid: u, rosterId: String(roster._id), type: 'damage', severity: 'serious', description: 'Barrier broken', injuries: true, policeInformed: false, lat: 30.7333, lng: 76.7794 },
  });
  check('online incident accepted', r.json.success && r.json.priority === 'P1', r.json);
  let inc = await db.collection('incidents').findOne({ bookingIncidentKey: u });
  check('scoped to the guard’s agency (visible in the portal)', inc?.agencyOwnerId === String(guard.agencyId ?? '') && inc.agencyOwnerId !== '', inc?.agencyOwnerId);
  check('site named from the roster', inc?.site === roster.siteName, inc?.site);
  check('priority kept despite the strict schema', inc?.priority === 'P1', inc?.priority);
  check('location kept', inc?.lat === 30.7333 && inc?.lng === 76.7794);
  check('injury / police answers kept', inc?.injuriesFlag === true && inc?.policeInformedFlag === false);
  check('photo uploaded before the record is attached', inc?.mediaIds?.includes(early), inc?.mediaIds);
  const late = await upload('incident_photo', u);
  inc = await db.collection('incidents').findOne({ bookingIncidentKey: u });
  check('photo uploaded after the record is attached', inc?.mediaIds?.includes(late), inc?.mediaIds);

  r = await api('/api/guard/incident', { method: 'POST', body: { guardId: GUARD_A, clientEventUuid: uuid(), type: 'theft', severity: 'low', mediaCount: 1 } });
  check('voice/photo-only report accepted online', r.json.success === true, r.json);
  r = await api('/api/guard/incident', { method: 'POST', body: { guardId: GUARD_A, clientEventUuid: uuid(), type: 'theft', severity: 'low' } });
  check('empty report still refused', r.status === 400, r.status);

  const off = uuid();
  r = await api('/api/guard/sync', {
    method: 'POST',
    body: {
      guardId: GUARD_A,
      events: [{ client_event_uuid: off, capture_sequence_no: 920003, type: 'incident', device_time: new Date().toISOString(), payload: { rosterId: String(roster._id), type: 'fire', severity: 'emergency', description: 'Smoke', injuries: false } }],
    },
  });
  inc = await db.collection('incidents').findOne({ bookingIncidentKey: off });
  check('offline incident: severity mapped (not raw "emergency")', inc?.severity === 'Critical' && inc?.priority === 'P0', inc?.severity);
  check('offline incident: agency-scoped and site named', inc?.agencyOwnerId === String(guard.agencyId ?? '') && inc?.site === roster.siteName, [inc?.agencyOwnerId, inc?.site]);
  check('offline incident: category is readable', inc?.category === 'Fire', inc?.category);

  r = await api(`/api/guard/incident?guardId=${GUARD_A}`);
  const mine = r.json.incidents?.find((x) => x.bookingIncidentKey === u);
  check('guard history shows priority and site', mine?.priority === 'P1' && mine?.site === roster.siteName, mine);
}

console.log('\n# Home alerts');
{
  await db.collection('apguards').updateOne({ _id: guard._id }, { $set: { kycVerified: true } });
  await db.collection('guardappprofiles').updateOne(
    { guardId: GUARD_A },
    { $set: { documents: [{ kind: 'psara', status: 'Verified', expiresOn: new Date(Date.now() - 86400000), mediaId: 'x' }] } },
    { upsert: true }
  );
  const r = await api(`/api/guard/today?guardId=${GUARD_A}`);
  const alert = r.json.bundle?.alerts?.find((a) => a.key === 'documents_expired');
  check('verified document past its date raises the expired alert', !!alert, r.json.bundle?.alerts);
  check('alert carries a count for translation', alert?.count === 1, alert);
  await db.collection('apguards').updateOne({ _id: guard._id }, { $set: { kycVerified: guard.kycVerified ?? false } });
  await db.collection('guardappprofiles').updateOne({ guardId: GUARD_A }, { $set: { documents: [] } });
}

await mongoose.disconnect();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('Failures:\n  ' + failures.join('\n  '));
  process.exit(1);
}
