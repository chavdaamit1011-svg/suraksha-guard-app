const path = require('node:path');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const backend = path.resolve(__dirname, '../../../suraksha-app');
const req = createRequire(path.join(backend, 'package.json'));
req('@next/env').loadEnvConfig(backend, true, { info() {}, error() {} });
const mongoose = req('mongoose');
const ownerId = new mongoose.Types.ObjectId();
const apId = new mongoose.Types.ObjectId();
const opsId = new mongoose.Types.ObjectId();
const replacementId = new mongoose.Types.ObjectId();
const phone = `6${String(Date.now()).slice(-9)}`;
const opsPhone = `7${String(Date.now()).slice(-9)}`;
let db;
async function call(route, body) {
  const r = await fetch(`http://localhost:4545/api/guard/${route}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
}
const login = (phone) => call('auth/verify-otp', { phone, otp: '123456' });
const denied = (r) => { assert.equal(r.status, 401, JSON.stringify(r.data)); assert.equal(r.data.action, 'LOGOUT'); };
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  db = mongoose.connection;
  assert.equal(await db.collection('apguards').countDocuments({ phone: { $in: [phone, `+91 ${phone}`] } }), 0);
  await db.collection('users').insertOne({ _id: ownerId, email: `${ownerId}@test.invalid`, role: 'agency', portalType: 'agency', isActive: true });
  const guard = { _id: apId, phone: `+91 ${phone}`, name: 'ACCESS TEST', id: String(apId), status: 'Active', agencyId: String(ownerId) };
  await db.collection('apguards').insertOne(guard);
  const first = await login(`+91${phone}`);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.guard._id, String(apId));
  assert.equal(first.data.exists, true);
  await db.collection('apguards').deleteOne({ _id: apId });
  denied(await login(phone));
  denied(await call(`today?guardId=${apId}`));
  denied(await call('auth/send-otp', { phone }));
  assert.equal((await call('auth/register', { phone, name: 'Attempt to recreate' })).status, 403);
  await db.collection('apguards').insertOne({ ...guard, _id: replacementId });
  assert.equal((await login(phone)).data.guard._id, String(replacementId));
  await db.collection('users').deleteOne({ _id: ownerId });
  denied(await login(phone));
  denied(await call(`today?guardId=${replacementId}`));
  await db.collection('ops_records').insertOne({ _id: opsId, module: 'guards', status: 'Active', payload: { name: 'OPS ACCESS TEST', phone: `+91 ${opsPhone}`, isActive: true } });
  const ops = await login(opsPhone);
  assert.equal(ops.status, 200, JSON.stringify(ops.data));
  assert.equal(ops.data.guard._id, String(opsId));
  await db.collection('ops_records').deleteOne({ _id: opsId });
  denied(await login(opsPhone));
  denied(await call(`today?guardId=${opsId}`));
  console.log('PASS: AP-added guard login, phone formatting, deleted guard logout/relogin denial, self-registration denial, same phone re-added, deleted agency denial, Ops-added guard login and Ops deletion denial.');
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(async () => {
  if (db) {
    await db.collection('users').deleteOne({ _id: ownerId });
    await db.collection('apguards').deleteMany({ _id: { $in: [apId, opsId, replacementId] } });
    await db.collection('ops_records').deleteOne({ _id: opsId });
    await db.collection('guardappprofiles').deleteMany({ guardId: { $in: [apId, opsId, replacementId].map(String) } });
  }
  await mongoose.disconnect();
});
