/**
 * Earnings estimate + payslips (PRD 18.13). Runs against the staging server and test DB.
 * The whole point of these assertions is the trust rule: an estimate must never be presented,
 * or computed, as if it were settled pay.
 */
import crypto from 'crypto';
import mongoose from 'mongoose';

const BASE = 'http://127.0.0.1:4546';
const GUARD_A = '6a92b25401423c3f1254b11b'; // wage "₹16,500"
const GUARD_B = '6a92b25401423c3f1254b11c'; // wage "18000"
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

const period = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 7);

console.log('\n================ 1. WAGE PARSING ================');
const a = await api(`/api/guard/earnings?guardId=${GUARD_A}`);
check('earnings endpoint responds', a.json.success === true, a.status);
check('"₹16,500" parsed to paise', a.json.monthlyWagePaise === 1650000, a.json.monthlyWagePaise);

const b = await api(`/api/guard/earnings?guardId=${GUARD_B}`);
check('plain "18000" parsed to paise', b.json.monthlyWagePaise === 1800000, b.json.monthlyWagePaise);

console.log('\n================ 2. THE ESTIMATE ================');
const est = a.json.estimate;
check('an estimate is returned while the month runs', !!est, a.json);
check('and is explicitly marked as one', est?.isEstimate === true, est?.isEstimate);
check('deductions are never guessed at', est?.deductionsKnown === false, est?.deductionsKnown);
check('per-day rate derived from the monthly wage', est?.perDayPaise === Math.round(1650000 / 26), est?.perDayPaise);
check('period matches the current month', est?.period === period, { got: est?.period, want: period });

console.log('\n--- only shifts actually checked into count ---');
check('days present reflects attendance, not the roster', est.daysPresent <= est.daysScheduled, {
  present: est.daysPresent,
  scheduled: est.daysScheduled,
});
check('gross is days × rate plus overtime', est.grossPaise === est.basePaise + est.otPaise, est);
check('base is exactly days present × per-day', est.basePaise === est.daysPresent * est.perDayPaise, est);

console.log('\n--- a future shift is not counted as absent ---');
const futureNotAbsent = est.daysAbsent + est.daysPresent <= est.daysScheduled;
check('scheduled ≥ present + absent', futureNotAbsent, est);

console.log('\n--- flagged shifts are counted but surfaced ---');
check('unreviewed shifts are reported separately', typeof est.daysAwaitingReview === 'number', est.daysAwaitingReview);

console.log('\n================ 3. OVERTIME ================');
// Check a guard in and out of a shift, with the check-out well past the rostered end.
const roster = await db.collection('agencyrosters').findOne({
  'assignedGuards.guardId': new mongoose.Types.ObjectId(GUARD_B),
});
const rosterId = String(roster._id);
await db.collection('guardattendances').deleteMany({ guardId: GUARD_B });

const inUuid = crypto.randomUUID();
await api('/api/guard/attendance', {
  method: 'POST',
  body: {
    guardId: GUARD_B,
    clientEventUuid: inUuid,
    eventType: 'check_in',
    rosterId,
    deviceTime: new Date().toISOString(),
    lat: SITE.lat,
    lng: SITE.lng,
  },
});

// Place the check-out two hours after the shift's rostered end.
const shiftEnd = new Date(
  await (async () => {
    const bundle = await api(`/api/guard/today?guardId=${GUARD_B}`);
    const cur = bundle.json.bundle?.assignments?.find((x) => x.rosterId === rosterId);
    return cur?.endAt ?? new Date().toISOString();
  })()
);
const outUuid = crypto.randomUUID();
await api('/api/guard/attendance', {
  method: 'POST',
  body: {
    guardId: GUARD_B,
    clientEventUuid: outUuid,
    eventType: 'check_out',
    rosterId,
    deviceTime: new Date(shiftEnd.getTime() + 2 * 3600_000).toISOString(),
    lat: SITE.lat,
    lng: SITE.lng,
  },
});
// The ingest stores serverReceivedTime as now; force the stored time so overtime is measurable.
await db.collection('guardattendances').updateOne(
  { clientEventUuid: outUuid },
  { $set: { serverReceivedTime: new Date(shiftEnd.getTime() + 2 * 3600_000), estimatedTrueTime: null } }
);

const withOt = await api(`/api/guard/earnings?guardId=${GUARD_B}`);
check('overtime detected past the rostered end', withOt.json.estimate?.otHours >= 1.5, withOt.json.estimate?.otHours);
check('overtime is paid at the hourly rate', withOt.json.estimate?.otPaise > 0, withOt.json.estimate?.otPaise);

console.log('\n--- a few minutes over is not overtime ---');
await db.collection('guardattendances').updateOne(
  { clientEventUuid: outUuid },
  { $set: { serverReceivedTime: new Date(shiftEnd.getTime() + 5 * 60_000) } }
);
const noOt = await api(`/api/guard/earnings?guardId=${GUARD_B}`);
check('5 minutes over does not become overtime', noOt.json.estimate?.otHours === 0, noOt.json.estimate?.otHours);

console.log('\n================ 4. A FINALISED PAYSLIP SUPERSEDES THE ESTIMATE ================');
await db.collection('guardpayslips').deleteMany({ guardId: GUARD_A });
await db.collection('guardpayslips').insertOne({
  guardId: GUARD_A,
  agencyId: '6a9288474698fca31e3ff146',
  period,
  daysPresent: 24,
  daysAbsent: 2,
  paidLeave: 0,
  otHours: 6,
  earnings: [
    { code: 'basic', label: 'Basic', amountPaise: 1520000 },
    { code: 'overtime', label: 'Overtime', amountPaise: 47000 },
  ],
  deductions: [{ code: 'advance', label: 'Advance', amountPaise: 30000 }],
  grossPaise: 1567000,
  deductionsPaise: 30000,
  netPaise: 1537000,
  status: 'Pending',
  referenceNo: '',
  carriedForwardPaise: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const finalised = await api(`/api/guard/earnings?guardId=${GUARD_A}`);
check('the estimate disappears once payroll finalises', finalised.json.estimate === null, finalised.json.estimate);
check('the payslip is returned instead', finalised.json.payslips?.length === 1, finalised.json.payslips?.length);
const slip = finalised.json.payslips[0];
check('net pay carried in paise', slip.netPaise === 1537000, slip.netPaise);
check('earning lines returned', slip.earnings?.length === 2, slip.earnings?.length);
check('deduction lines returned', slip.deductions?.length === 1, slip.deductions?.length);
check('unpaid payslip has no reference yet', slip.referenceNo === '', slip.referenceNo);

console.log('\n--- once paid ---');
await db.collection('guardpayslips').updateOne(
  { guardId: GUARD_A, period },
  { $set: { status: 'Completed', paidOn: new Date(), referenceNo: 'UTR123456789' } }
);
const paid = await api(`/api/guard/earnings?guardId=${GUARD_A}`);
check('status becomes Completed', paid.json.payslips[0].status === 'Completed', paid.json.payslips[0].status);
check('bank reference shown verbatim', paid.json.payslips[0].referenceNo === 'UTR123456789', paid.json.payslips[0].referenceNo);
check('paid date returned', !!paid.json.payslips[0].paidOn);

console.log('\n================ 5. NEGATIVE NET IS NEVER SHOWN ================');
await db.collection('guardpayslips').updateOne(
  { guardId: GUARD_A, period },
  { $set: { netPaise: -50000, carriedForwardPaise: 50000 } }
);
const negative = await api(`/api/guard/earnings?guardId=${GUARD_A}`);
check('a negative net is clamped to zero', negative.json.payslips[0].netPaise === 0, negative.json.payslips[0].netPaise);
check('and the shortfall is carried forward instead', negative.json.payslips[0].carriedForwardPaise === 50000, negative.json.payslips[0].carriedForwardPaise);

console.log('\n================ 6. SELF-SCOPING ================');
const other = await api(`/api/guard/earnings?guardId=${GUARD_B}`);
check("guard B does not see guard A's payslip", (other.json.payslips ?? []).every((p) => p.netPaise !== 1537000), other.json.payslips);

const bad = await api('/api/guard/earnings?guardId=not-an-id');
check('invalid guardId gives 400, not a 500', bad.status === 400, bad.status);
const missing = await api('/api/guard/earnings');
check('missing guardId gives 400', missing.status === 400, missing.status);

await mongoose.disconnect();
console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
if (fail) console.log('FAILED: ' + failures.join(' | '));
process.exit(fail ? 1 : 0);
