/**
 * SOS ladder + replacement offers, against the isolated staging server and test DB.
 * Run after seed-test.mjs. Production is never touched.
 */
import crypto from 'crypto';
import mongoose from 'mongoose';

const BASE = 'http://127.0.0.1:4546';
const GUARD_A = '6a92b25401423c3f1254b11b';
const GUARD_B = '6a92b25401423c3f1254b11c';
const ADMIN = { 'x-guard-admin-key': 'test-admin-key-local-only' };
const SMS_KEY = { 'x-guard-sms-key': 'test-sms-webhook-key' };
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

console.log('\n================ SOS ================');
const sosId = crypto.randomUUID();
const fire = await api('/api/guard/sos', {
  method: 'POST',
  body: {
    guardId: GUARD_A,
    sosId,
    lat: SITE.lat,
    lng: SITE.lng,
    batteryPct: 41,
    triggerMethod: 'long_press',
    channel: 'rest',
    siteName: 'Tower 9',
  },
});
check('SOS accepted', fire.json.success === true, fire.json);
check('sosId echoed back', fire.json.sosId === sosId);
check('first arrival is not a duplicate', fire.json.duplicate === false);

console.log('\n--- the same alarm arriving by a second channel ---');
const viaSms = await api('/api/guard/sos', {
  method: 'POST',
  body: { guardId: GUARD_A, sosId, lat: SITE.lat, lng: SITE.lng, channel: 'sms' },
});
check('second channel deduped', viaSms.json.duplicate === true, viaSms.json);
const sosDoc = await db.collection('guardfieldevents').findOne({ clientEventUuid: sosId });
check('both channels recorded on one event', (sosDoc?.meta?.channels ?? []).sort().join(',') === 'rest,sms', sosDoc?.meta?.channels);
check('still exactly one SOS row', await db.collection('guardfieldevents').countDocuments({ clientEventUuid: sosId }) === 1);
check('battery captured', sosDoc?.meta?.batteryPct === 41, sosDoc?.meta?.batteryPct);
check('status starts pending', sosDoc?.status === 'pending', sosDoc?.status);

console.log('\n--- acknowledgement polling ---');
const before = await api(`/api/guard/sos?guardId=${GUARD_A}&sosId=${sosId}`);
check('status readable', before.json.found === true, before.json);
check('no responder yet', !before.json.acknowledgedBy);

await db.collection('guardfieldevents').updateOne(
  { clientEventUuid: sosId },
  { $set: { acknowledgedBy: 'Operator Meena', status: 'acknowledged' } }
);
const after = await api(`/api/guard/sos?guardId=${GUARD_A}&sosId=${sosId}`);
check('responder name surfaces once an operator picks it up', after.json.acknowledgedBy === 'Operator Meena', after.json);

console.log('\n--- another guard cannot read it ---');
const otherGuard = await api(`/api/guard/sos?guardId=${GUARD_B}&sosId=${sosId}`);
check("another guard's poll finds nothing", otherGuard.json.found === false, otherGuard.json);

console.log('\n--- cancel keeps the record ---');
const cancel = await api('/api/guard/sos', {
  method: 'PATCH',
  body: { guardId: GUARD_A, sosId, reason: 'cancelled_by_guard' },
});
check('cancel accepted', cancel.json.success === true, cancel.json);
const cancelled = await db.collection('guardfieldevents').findOne({ clientEventUuid: sosId });
check('status is cancelled, row still exists', cancelled?.status === 'cancelled', cancelled?.status);
check('SOS is never deleted', !!cancelled);

console.log('\n================ SOS BY SMS ================');
const hhmmss = new Date(Date.now() + 330 * 60000).toISOString().slice(11, 19).replace(/:/g, '');
const smsBody = `SOS|${GUARD_B}|site9|${SITE.lat},${SITE.lng}|${hhmmss}|7`;

const noKey = await api('/api/guard/sos/inbound', { method: 'POST', body: { text: smsBody } });
check('webhook refuses without the shared secret', noKey.status === 401, noKey.status);

const inbound = await api('/api/guard/sos/inbound', {
  method: 'POST',
  headers: SMS_KEY,
  body: { text: smsBody, from: '+919876500002' },
});
check('structured SMS becomes a real SOS', inbound.json.success === true, inbound.json);
check('guard resolved from the sending number', inbound.json.guardId === GUARD_B, inbound.json.guardId);

const smsDoc = await db.collection('guardfieldevents').findOne({ clientEventUuid: inbound.json.sosId });
check('channel recorded as sms', smsDoc?.channel === 'sms', smsDoc?.channel);
check('coordinates parsed out of the SMS', Math.abs((smsDoc?.lat ?? 0) - SITE.lat) < 0.001, smsDoc?.lat);
check('battery parsed out of the SMS', smsDoc?.meta?.batteryPct === 7, smsDoc?.meta?.batteryPct);

console.log('\n--- the same alarm arriving twice by SMS ---');
const inbound2 = await api('/api/guard/sos/inbound', {
  method: 'POST',
  headers: SMS_KEY,
  body: { text: smsBody, from: '+919876500002' },
});
check('second SMS deduped into the same alarm', inbound2.json.duplicate === true && inbound2.json.sosId === inbound.json.sosId, inbound2.json);
check(
  'one incident, not two',
  (await db.collection('guardfieldevents').countDocuments({ guardId: GUARD_B, kind: 'sos' })) === 1
);

console.log('\n--- a mangled message still raises the alarm ---');
const truncated = await api('/api/guard/sos/inbound', {
  method: 'POST',
  headers: SMS_KEY,
  body: { text: `SOS|${GUARD_A}||`, from: '+919876500001' },
});
check('truncated SMS accepted', truncated.json.success === true, truncated.json);

const notSos = await api('/api/guard/sos/inbound', {
  method: 'POST',
  headers: SMS_KEY,
  body: { text: 'hello how are you', from: '+919876500001' },
});
check('an ordinary SMS is ignored, not an error', notSos.json.ignored === true, notSos.json);

console.log('\n================ REPLACEMENT OFFERS ================');
// Guard A's own roster row is the vacancy; guard B is a candidate.
const roster = await db.collection('agencyrosters').findOne({ 'assignedGuards.guardId': new mongoose.Types.ObjectId(GUARD_A) });
const rosterId = String(roster._id);

const noAuth = await api('/api/guard/replacement/dispatch', { method: 'POST', body: { rosterId } });
check('dispatch refuses without the admin key', noAuth.status === 401, noAuth.status);

const dispatch = await api('/api/guard/replacement/dispatch', {
  method: 'POST',
  headers: ADMIN,
  body: { rosterId, replacingGuardId: GUARD_A, reason: 'leave', incentivePaise: 35000, waveMinutes: 10 },
});
check('vacancy opened', dispatch.json.success === true && !!dispatch.json.vacancyId, dispatch.json);
check('offers dispatched to candidates', dispatch.json.offered >= 1, dispatch.json);
check('the guard being replaced is not offered their own shift', !dispatch.json.guardIds?.includes(GUARD_A), dispatch.json.guardIds);
// Guard B's 20:00–08:00 night shift only overlaps guard A's live shift when the suite runs in the
// evening or at night, so the expectation follows the actual windows rather than the clock.
{
  const bRoster = await db.collection('agencyrosters').findOne({ 'assignedGuards.guardId': new mongoose.Types.ObjectId(GUARD_B) });
  const win = (r) => {
    const [s, e] = r.timing.split('-').map((x) => x.trim());
    const toMin = (hhmm) => {
      const m = hhmm.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
      let h = Number(m[1]) % (m[3] ? 12 : 24);
      if (m[3] && m[3].toUpperCase() === 'PM') h += 12;
      return h * 60 + Number(m[2]);
    };
    const start = Date.parse(`${r.date}T00:00:00+05:30`) + toMin(s) * 60_000;
    let end = Date.parse(`${r.date}T00:00:00+05:30`) + toMin(e) * 60_000;
    if (end <= start) end += 24 * 3600_000;
    return [start, end];
  };
  const [aS, aE] = win(roster);
  const [bS, bE] = win(bRoster);
  const overlaps = aS < bE && bS < aE;
  check(
    overlaps
      ? 'a guard already on an overlapping shift is not offered it'
      : 'a guard whose shift does not overlap is offered it',
    overlaps ? !dispatch.json.guardIds?.includes(GUARD_B) : dispatch.json.guardIds?.includes(GUARD_B),
    { overlaps, offered: dispatch.json.guardIds }
  );
}

console.log('\n--- wave 1 stays close ---');
const wave1Offers = await db
  .collection('guardreplacementoffers')
  .find({ vacancyId: dispatch.json.vacancyId })
  .toArray();
const distances = wave1Offers.map((o) => o.distanceKm).filter((d) => d !== null && d !== undefined);
check('wave 1 only reaches guards within 8 km', distances.every((d) => d <= 8), distances);
check(
  'nearest candidate offered first',
  distances.length < 2 || distances[0] <= distances[distances.length - 1],
  distances
);

console.log('\n--- the guard sees the offer ---');
const guardOffers = await api(`/api/guard/replacement?guardId=${dispatch.json.guardIds[0]}`);
check('offer listed for the candidate', (guardOffers.json.offers?.length ?? 0) >= 1, guardOffers.json.offers?.length);
const offer = guardOffers.json.offers[0];
check('incentive carried in paise', offer.incentivePaise === 35000, offer.incentivePaise);
check('site name denormalised onto the offer', offer.siteName === 'Tower 9', offer.siteName);
check('expiry set', !!offer.expiresAt);

console.log('\n--- it also rides in the duty bundle ---');
const bundle = await api(`/api/guard/today?guardId=${dispatch.json.guardIds[0]}`);
check('bundle carries the offer', (bundle.json.bundle?.offers?.length ?? 0) >= 1, bundle.json.bundle?.offers?.length);
check(
  'alert strip surfaces it first',
  bundle.json.bundle?.alerts?.[0]?.key === 'replacement_offer',
  bundle.json.bundle?.alerts
);

console.log('\n--- first accept wins, and only one ---');
// Widen the wave so there are at least two candidates racing.
const wave2 = await api('/api/guard/replacement/dispatch', {
  method: 'POST',
  headers: ADMIN,
  body: { rosterId, replacingGuardId: GUARD_A, wave: 3, waveSize: 10, waveMinutes: 10 },
});
const allOffers = await db
  .collection('guardreplacementoffers')
  .find({ vacancyId: dispatch.json.vacancyId, status: 'pending' })
  .toArray();
check('at least two candidates in the race', allOffers.length >= 2, allOffers.length);

const racers = allOffers.slice(0, 2);
const results = await Promise.all(
  racers.map((o) =>
    api('/api/guard/replacement', {
      method: 'POST',
      body: { guardId: String(o.guardId), offerId: String(o._id), response: 'accept' },
    })
  )
);
const outcomes = results.map((r) => r.json.outcome).sort();
check('exactly one accepted, one told it was taken', outcomes.join(',') === 'accepted,taken', outcomes);

const vacancy = await db.collection('guardvacancies').findOne({ _id: new mongoose.Types.ObjectId(dispatch.json.vacancyId) });
check('vacancy marked filled', vacancy?.status === 'filled', vacancy?.status);
check('filledBy is the winner', !!vacancy?.filledBy);

const winnerId = String(vacancy.filledBy);
const rosterAfter = await db.collection('agencyrosters').findOne({ _id: new mongoose.Types.ObjectId(rosterId) });
const added = (rosterAfter.assignedGuards ?? []).filter((g) => String(g.guardId) === winnerId);
check('winner added to the roster exactly once', added.length === 1, added.length);
check('added as a reliever', added[0]?.isReliever === true, added[0]);
check('records who they replaced', added[0]?.replacedGuardName === 'Ravi Kumar Singh', added[0]?.replacedGuardName);

console.log('\n--- losers are closed out ---');
const losers = await db
  .collection('guardreplacementoffers')
  .find({ vacancyId: dispatch.json.vacancyId, status: 'pending' })
  .toArray();
check('no offers left pending on a filled vacancy', losers.length === 0, losers.length);

console.log('\n--- re-sending a settled decision ---');
const winnerOffer = racers.find((o) => String(o.guardId) === winnerId);
const replay = await api('/api/guard/replacement', {
  method: 'POST',
  body: { guardId: winnerId, offerId: String(winnerOffer._id), response: 'accept' },
});
check('replayed accept returns the settled outcome', replay.json.alreadyResponded === true && replay.json.outcome === 'accepted', replay.json);
const rosterAfter2 = await db.collection('agencyrosters').findOne({ _id: new mongoose.Types.ObjectId(rosterId) });
check(
  'replay did not add the guard twice',
  (rosterAfter2.assignedGuards ?? []).filter((g) => String(g.guardId) === winnerId).length === 1
);

console.log('\n--- a clashing shift is refused ---');
// Open a second vacancy on the SAME roster row and offer it to the guard who just took it.
await db.collection('guardvacancies').insertOne({
  agencyId: roster.agencyId,
  rosterId,
  shiftDate: roster.date,
  siteId: '',
  siteName: 'Tower 9',
  timing: roster.timing,
  shiftType: roster.shiftType,
  status: 'open',
  wave: 1,
  expiresAt: new Date(Date.now() + 600000),
  createdAt: new Date(),
  updatedAt: new Date(),
});
const v2 = await db.collection('guardvacancies').findOne({ rosterId, status: 'open' });
// Offer a DIFFERENT roster row's shift that overlaps what the winner now holds.
const nightRoster = await db.collection('agencyrosters').findOne({ shiftType: /Night/ });
if (nightRoster) {
  const clashVacancy = await db.collection('guardvacancies').insertOne({
    agencyId: nightRoster.agencyId,
    rosterId: String(nightRoster._id),
    shiftDate: nightRoster.date,
    siteName: nightRoster.siteName,
    timing: nightRoster.timing,
    shiftType: nightRoster.shiftType,
    status: 'open',
    wave: 1,
    expiresAt: new Date(Date.now() + 600000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const clashOffer = await db.collection('guardreplacementoffers').insertOne({
    vacancyId: String(clashVacancy.insertedId),
    guardId: String(nightRoster.assignedGuards[0].guardId), // already on that very shift
    siteName: nightRoster.siteName,
    shiftDate: nightRoster.date,
    timing: nightRoster.timing,
    shiftType: nightRoster.shiftType,
    incentivePaise: 0,
    wave: 1,
    expiresAt: new Date(Date.now() + 600000),
    status: 'pending',
    notifiedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const clash = await api('/api/guard/replacement', {
    method: 'POST',
    body: {
      guardId: String(nightRoster.assignedGuards[0].guardId),
      offerId: String(clashOffer.insertedId),
      response: 'accept',
    },
  });
  check('BR-001: overlapping shift refused', clash.json.outcome === 'conflict', clash.json);
  const stillOpen = await db.collection('guardvacancies').findOne({ _id: clashVacancy.insertedId });
  check('refused accept did not fill the vacancy', stillOpen?.status === 'open', stillOpen?.status);
}

console.log('\n--- expiry ---');
const expiredVac = await db.collection('guardvacancies').insertOne({
  rosterId,
  shiftDate: roster.date,
  siteName: 'Tower 9',
  timing: roster.timing,
  status: 'open',
  wave: 1,
  expiresAt: new Date(Date.now() - 60000),
  createdAt: new Date(),
  updatedAt: new Date(),
});
const expiredOffer = await db.collection('guardreplacementoffers').insertOne({
  vacancyId: String(expiredVac.insertedId),
  guardId: GUARD_B,
  siteName: 'Tower 9',
  shiftDate: roster.date,
  timing: roster.timing,
  incentivePaise: 0,
  wave: 1,
  expiresAt: new Date(Date.now() - 60000),
  status: 'pending',
  notifiedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
});
const lateAccept = await api('/api/guard/replacement', {
  method: 'POST',
  body: { guardId: GUARD_B, offerId: String(expiredOffer.insertedId), response: 'accept' },
});
check('accepting after expiry is refused', lateAccept.json.outcome === 'expired', lateAccept.json);

console.log('\n--- decline ---');
const dv = await db.collection('guardvacancies').insertOne({
  rosterId,
  shiftDate: roster.date,
  siteName: 'Tower 9',
  timing: roster.timing,
  status: 'open',
  wave: 1,
  expiresAt: new Date(Date.now() + 600000),
  createdAt: new Date(),
  updatedAt: new Date(),
});
const declineOffer = await db.collection('guardreplacementoffers').insertOne({
  vacancyId: String(dv.insertedId),
  guardId: GUARD_B,
  siteName: 'Tower 9',
  shiftDate: roster.date,
  timing: roster.timing,
  incentivePaise: 0,
  wave: 1,
  expiresAt: new Date(Date.now() + 600000),
  status: 'pending',
  notifiedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
});
const declined = await api('/api/guard/replacement', {
  method: 'POST',
  body: { guardId: GUARD_B, offerId: String(declineOffer.insertedId), response: 'decline' },
});
check('decline recorded', declined.json.outcome === 'declined', declined.json);
const stillOpenVac = await db.collection('guardvacancies').findOne({ _id: dv.insertedId });
check('declining leaves the vacancy open for others', stillOpenVac?.status === 'open', stillOpenVac?.status);

console.log('\n--- agency cancels the vacancy ---');
const cancelVac = await api(`/api/guard/replacement/dispatch?vacancyId=${dv.insertedId}`, {
  method: 'DELETE',
  headers: ADMIN,
});
check('vacancy cancelled', cancelVac.json.success === true, cancelVac.json);
const cancelledVac = await db.collection('guardvacancies').findOne({ _id: dv.insertedId });
check('status cancelled', cancelledVac?.status === 'cancelled', cancelledVac?.status);

await mongoose.disconnect();
console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
if (fail) console.log('FAILED: ' + failures.join(' | '));
process.exit(fail ? 1 : 0);
