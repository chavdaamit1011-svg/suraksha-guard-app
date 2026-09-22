/**
 * Round 5: support tickets, payslip PDF, documents (upload link, expiry, offline, Aadhaar
 * masking), media access control, IVR on a second wake miss.
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
  const res = await fetch(path.startsWith('http') ? path : `${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json;
  try {
    json = JSON.parse(buf.toString('utf8'));
  } catch {
    json = {};
  }
  return { status: res.status, json, buf, type: res.headers.get('content-type') ?? '' };
}

const uuid = () => crypto.randomUUID();
// A tiny valid JPEG (1x1) for uploads.
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
);
async function upload(guardId, kind, clientEventUuid) {
  // Trailing bytes after the JPEG end marker make each upload unique; identical bytes would be
  // treated as reused media and answered with the earlier id.
  const bytes = Buffer.concat([JPEG, crypto.randomBytes(8)]);
  const r = await api('/api/guard/media', {
    method: 'POST',
    body: { guardId, kind, clientEventUuid, base64: bytes.toString('base64'), mime: 'image/jpeg' },
  });
  return r.json.mediaId;
}

await mongoose.connect('mongodb://127.0.0.1:27017/suraksha_guardtest');
const db = mongoose.connection.db;
await db.collection('supporttickets').deleteMany({ ticketId: /^GRD-/ });
await db.collection('guardappprofiles').updateMany({ guardId: { $in: [GUARD_A, GUARD_B] } }, { $set: { documents: [] } });

// ---------------------------------------------------------------- media access
console.log('\n# Media access control');
{
  const m = await upload(GUARD_A, 'voice', uuid());
  check('upload works', !!m);
  let r = await api(`/api/guard/media?mediaId=${m}`);
  check('no guardId, no signature → 403 (used to be served)', r.status === 403, r.status);
  r = await api(`/api/guard/media?mediaId=${m}&guardId=${GUARD_A}`);
  check('owner can read', r.status === 200);
  r = await api(`/api/guard/media?mediaId=${m}&guardId=${GUARD_B}`);
  check('other guard → 403', r.status === 403);
  r = await api(`/api/guard/media?mediaId=${m}`, { admin: true });
  check('admin key can read', r.status === 200);
  r = await api(`/api/guard/media?mediaId=${m}&e=9999999999&s=forged`);
  check('forged signature → 403', r.status === 403);
}

// ---------------------------------------------------------------- support
console.log('\n# Support tickets');
{
  let r = await api('/api/guard/support', { method: 'POST', body: { guardId: GUARD_A, clientEventUuid: uuid(), category: 'pay' } });
  check('empty ticket → 422', r.status === 422, r.json);

  const voiceUuid = uuid();
  const voice = await upload(GUARD_A, 'voice', voiceUuid);
  const other = await upload(GUARD_B, 'voice', uuid());
  const tUuid = uuid();
  r = await api('/api/guard/support', {
    method: 'POST',
    body: { guardId: GUARD_A, clientEventUuid: tUuid, category: 'pay', mediaIds: [voice, other], period: '2026-08' },
  });
  check('voice-only ticket created', r.json.success && /^GRD-/.test(r.json.ticketId), r.json);
  const ticketId = r.json.ticketId;

  r = await api('/api/guard/support', { method: 'POST', body: { guardId: GUARD_A, clientEventUuid: tUuid, category: 'pay', message: 'x' } });
  check('resend → duplicate, same ticket', r.json.duplicate === true && r.json.ticketId === ticketId, r.json);

  const doc = await db.collection('supporttickets').findOne({ ticketId });
  check('lands in the shared SupportTicket queue', doc?.status === 'Open' && doc.customerId === GUARD_A, doc?.status);
  check('pay tickets are High priority', doc?.priority === 'High', doc?.priority);
  check('period recorded in subject', doc?.subject.includes('2026-08'), doc?.subject);
  check("another guard's media is not attached", !doc?.message.includes(other), doc?.message);
  const link = doc?.message.match(/https?:\/\/\S+mediaId=\S+/)?.[0];
  check('ticket carries a signed voice link', !!link, doc?.message);
  if (link) {
    const local = link.replace(/^https?:\/\/[^/]+/, BASE);
    const played = await api(local);
    check('ops can open the signed link without a session', played.status === 200, played.status);
    const tampered = await api(local.replace(voice, other));
    check('signature does not transfer to another file', tampered.status === 403, tampered.status);
  }

  r = await api('/api/guard/support', { method: 'POST', body: { guardId: GUARD_A, clientEventUuid: uuid(), category: 'safety', message: 'Site in-charge abusing' } });
  const safety = await db.collection('supporttickets').findOne({ ticketId: r.json.ticketId });
  check('safety tickets are Urgent', safety?.priority === 'Urgent', safety?.priority);

  await db.collection('supporttickets').updateOne(
    { ticketId },
    { $set: { status: 'Resolved', adminResponse: 'Overtime added to next payslip', resolutionNotes: 'internal: agency fault' }, $push: { replies: { sender: 'Ops', senderRole: 'ops', message: 'Checking with payroll', createdAt: new Date() } } }
  );
  r = await api(`/api/guard/support?guardId=${GUARD_A}`);
  const mine = r.json.tickets?.find((x) => x.ticketId === ticketId);
  check('guard sees status and staff reply', mine?.status === 'Resolved' && mine.replies[0]?.message === 'Checking with payroll', mine);
  check('guard sees the response, not internal notes', mine?.resolution === 'Overtime added to next payslip');
  r = await api(`/api/guard/support?guardId=${GUARD_B}`);
  check("guard B does not see A's tickets", !r.json.tickets?.some((x) => x.ticketId === ticketId));
}

// ---------------------------------------------------------------- payslip PDF
console.log('\n# Payslip PDF');
{
  await db.collection('guardpayslips').deleteMany({ guardId: GUARD_A, period: { $in: ['2026-06', '2026-05'] } });
  await db.collection('guardpayslips').insertMany([
    {
      guardId: GUARD_A, period: '2026-06', status: 'Completed', daysPresent: 26, daysAbsent: 4, paidLeave: 0, otHours: 6,
      earnings: [{ code: 'basic', label: 'Basic wage', amountPaise: 1650000 }, { code: 'overtime', label: 'Overtime (6 h)', amountPaise: 45000 }],
      deductions: [{ code: 'pf', label: 'PF', amountPaise: 198000 }],
      grossPaise: 1695000, deductionsPaise: 198000, netPaise: 1497000, paidOn: new Date('2026-07-05'), referenceNo: 'UTR123456789', carriedForwardPaise: 0,
    },
    { guardId: GUARD_A, period: '2026-05', status: 'Draft', grossPaise: 1, netPaise: 1, earnings: [], deductions: [] },
  ]);

  let r = await api('/api/guard/earnings/pdf', { method: 'POST', body: { guardId: GUARD_A, period: '2026-05' } });
  check('draft payslip has no PDF', r.status === 404, r.status);
  r = await api('/api/guard/earnings/pdf', { method: 'POST', body: { guardId: GUARD_B, period: '2026-06' } });
  check("cannot get a link for someone else's month", r.status === 404, r.status);
  r = await api('/api/guard/earnings/pdf', { method: 'POST', body: { guardId: GUARD_A, period: '2026-06' } });
  check('link issued', r.json.success && r.json.url?.includes('/api/guard/earnings/pdf?'), r.json);
  const local = r.json.url.replace(/^https?:\/\/[^/]+/, BASE);
  const pdf = await api(local);
  const text = pdf.buf.toString('latin1');
  check('serves a PDF', pdf.status === 200 && pdf.type.includes('application/pdf') && text.startsWith('%PDF-1.4') && text.trimEnd().endsWith('%%EOF'), pdf.type);
  check('net pay in paise-exact rupees', text.includes('Rs. 14,970.00'));
  check('UTR printed', text.includes('UTR123456789'));
  const xref = Number(text.match(/startxref\n(\d+)/)?.[1]);
  check('xref offset is correct', text.slice(xref, xref + 4) === 'xref', text.slice(xref, xref + 10));
  const tampered = await api(local.replace('2026-06', '2026-05'));
  check('changing the month breaks the signature', tampered.status === 403, tampered.status);
  const expired = await api(local.replace(/e=\d+/, 'e=1000'));
  check('expired link refused', expired.status === 403, expired.status);
  await db.collection('guardpayslips').deleteMany({ guardId: GUARD_A, period: { $in: ['2026-06', '2026-05'] } });
}

// ---------------------------------------------------------------- documents
console.log('\n# Documents');
{
  let r = await api('/api/guard/documents', { method: 'POST', body: { guardId: GUARD_A, kind: 'pan' } });
  check('no scan reference → 400', r.status === 400, r.status);

  const other = await upload(GUARD_B, 'document', uuid());
  r = await api('/api/guard/documents', { method: 'POST', body: { guardId: GUARD_A, kind: 'pan', mediaId: other, clientEventUuid: uuid() } });
  check("another guard's scan cannot back a document", r.status === 422, r.status);

  const aUuid = uuid();
  const aMedia = await upload(GUARD_A, 'document', aUuid);
  r = await api('/api/guard/documents', { method: 'POST', body: { guardId: GUARD_A, kind: 'aadhaar', mediaId: aMedia, clientEventUuid: aUuid, number: '1234 5678 9012' } });
  check('Aadhaar stored masked only', r.json.number === 'XXXX XXXX 9012', r.json);
  const prof = await db.collection('guardappprofiles').findOne({ guardId: GUARD_A });
  check('full Aadhaar never reaches the database', !JSON.stringify(prof).includes('123456789012') && !JSON.stringify(prof).includes('1234 5678'));

  r = await api('/api/guard/documents', { method: 'POST', body: { guardId: GUARD_A, kind: 'aadhaar', mediaId: aMedia, clientEventUuid: aUuid } });
  check('same scan re-sent → duplicate', r.json.duplicate === true, r.json);

  // Offline: record first (via sync), scan uploads later under the same uuid.
  const pUuid = uuid();
  const evUuid = uuid();
  const soon = new Date(Date.now() + 10 * 24 * 3600_000).toISOString().slice(0, 10);
  r = await api('/api/guard/sync', {
    method: 'POST',
    body: { guardId: GUARD_A, events: [{ client_event_uuid: evUuid, capture_sequence_no: 910001, type: 'document', device_time: new Date().toISOString(), payload: { kind: 'psara', mediaUuid: pUuid, number: 'psara/12345', expiresOn: soon } }] },
  });
  check('offline document accepted by sync', r.json.accepted?.includes(evUuid), r.json);
  r = await api(`/api/guard/documents?guardId=${GUARD_A}`);
  let psara = r.json.documents?.find((d) => d.kind === 'psara');
  check('recorded, waiting for its scan', psara?.awaitingUpload === true && psara.hasImage === false, psara);
  await upload(GUARD_A, 'document', pUuid);
  r = await api(`/api/guard/documents?guardId=${GUARD_A}`);
  psara = r.json.documents?.find((d) => d.kind === 'psara');
  check('late scan linked on read', psara?.hasImage === true && psara.awaitingUpload === false, psara);

  // Expiry is computed when read.
  const past = new Date(Date.now() - 2 * 24 * 3600_000);
  const nearly = new Date(Date.now() + 10 * 24 * 3600_000);
  await db.collection('guardappprofiles').updateOne(
    { guardId: GUARD_A },
    { $push: { documents: { $each: [
      { kind: 'police', status: 'Verified', expiresOn: past, number: '', mediaId: 'x' },
      { kind: 'bank', status: 'Verified', expiresOn: nearly, number: '', mediaId: 'y' },
    ] } } }
  );
  r = await api(`/api/guard/documents?guardId=${GUARD_A}`);
  const byKind = Object.fromEntries((r.json.documents ?? []).map((d) => [d.kind, d.status]));
  check('verified but past expiry → Expired', byKind.police === 'Expired', byKind);
  check('verified, expiring within 30 days → Expiring', byKind.bank === 'Expiring', byKind);

  r = await api('/api/guard/sync', {
    method: 'POST',
    body: { guardId: GUARD_A, events: [{ client_event_uuid: uuid(), capture_sequence_no: 910002, type: 'document', device_time: new Date().toISOString(), payload: { kind: 'passport', mediaUuid: uuid() } }] },
  });
  check('bad document kind → permanent failure, not retried', r.json.results?.[0]?.ok === false && !r.json.results[0].retry, r.json.results);

  r = await api('/api/guard/documents/ocr', { method: 'POST', body: { guardId: GUARD_A, kind: 'pan', mediaId: aMedia } });
  check('OCR without a provider → available:false (optional feature)', r.json.success && r.json.available === false, r.json);
}

// ---------------------------------------------------------------- IVR
console.log('\n# IVR on second wake miss');
{
  await db.collection('guardwakeschedules').deleteMany({ guardId: GUARD_B, rosterId: { $exists: false } });
  const due = new Date(Date.now() - 4 * 60_000);
  const { insertedId: w } = await db.collection('guardwakeschedules').insertOne({ guardId: GUARD_B, dueAt: due, ackWindowSec: 120, status: 'pending', missCount: 0, escalatedAt: '' });
  await api('/api/guard/wake-check', { method: 'POST', body: { guardId: GUARD_B, wakeId: String(w), missed: true, attempt: 1, clientEventUuid: uuid() } });
  let row = await db.collection('guardwakeschedules').findOne({ _id: w });
  check('no call on the first miss', !row.ivrStatus, row.ivrStatus);
  await api('/api/guard/wake-check', { method: 'POST', body: { guardId: GUARD_B, wakeId: String(w), missed: true, attempt: 2, clientEventUuid: uuid() } });
  await new Promise((r) => setTimeout(r, 1500));
  row = await db.collection('guardwakeschedules').findOne({ _id: w });
  check('second miss attempts the call (no provider on staging → not_configured)', row.ivrStatus === 'not_configured' && !!row.ivrAt, row);
  const at = row.ivrAt;
  await api(`/api/guard/wake-check?guardId=${GUARD_B}`);
  await new Promise((r) => setTimeout(r, 800));
  row = await db.collection('guardwakeschedules').findOne({ _id: w });
  check('never called twice for one slot', String(row.ivrAt) === String(at));

  // Server sweep: a dead phone reports nothing, the server calls anyway.
  const { insertedId: w2 } = await db.collection('guardwakeschedules').insertOne({ guardId: GUARD_B, dueAt: new Date(Date.now() - 30 * 60_000), ackWindowSec: 120, status: 'pending', missCount: 0, escalatedAt: '' });
  await api(`/api/guard/wake-check?guardId=${GUARD_B}`);
  await new Promise((r) => setTimeout(r, 1500));
  row = await db.collection('guardwakeschedules').findOne({ _id: w2 });
  check('sweep-detected miss also triggers the call', row.status === 'missed' && row.ivrStatus === 'not_configured', row);
  await db.collection('guardwakeschedules').deleteMany({ _id: { $in: [w, w2] } });
}

// ---------------------------------------------------------------- version
console.log('\n# Version');
{
  const r = await api('/api/guard/version');
  check('helpline fields present (empty when unset)', 'helpline' in r.json && 'commandCenter' in r.json, r.json);
}

await db.collection('supporttickets').deleteMany({ ticketId: /^GRD-/ });
await db.collection('guardappprofiles').updateMany({ guardId: { $in: [GUARD_A, GUARD_B] } }, { $set: { documents: [] } });
await mongoose.disconnect();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('Failures:\n  ' + failures.join('\n  '));
  process.exit(1);
}
