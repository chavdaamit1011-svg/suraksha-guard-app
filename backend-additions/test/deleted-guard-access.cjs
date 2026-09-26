const path = require('node:path');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../../suraksha-app');
const req = createRequire(path.join(root, 'package.json'));
req('@next/env').loadEnvConfig(root, true, { info() {}, error() {} });
const mongoose = req('mongoose');
const ids = Array.from({ length: 7 }, () => new mongoose.Types.ObjectId());
const [owner, ap, ops, legacy, legacySource, replacement, projectionSource] = ids;
const nonce = String(Date.now()).slice(-8);
const apPhone = `61${nonce}`, opsPhone = `62${nonce}`, legacyPhone = `63${nonce}`, mirrorPhone = `64${nonce}`;
let db;
async function call(route, { token, method = 'GET', body } = {}) {
  const response = await fetch(`http://localhost:4545/api/${route}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}
const login = phone => call('guard/auth/verify-otp', { method: 'POST', body: { phone, otp: '123456', deviceId: 'deleted-guard-test' } });
const check = (id, token) => call(`guard/access?guardId=${id}`, { token });
function removed(result) {
  assert.equal(result.status, 401, JSON.stringify(result));
  assert.equal(result.data.code, 'guard_removed');
  assert.equal(result.data.action, 'LOGOUT');
}
async function cannotLogin(phone) {
  const result = await login(phone);
  assert.ok(!result.data.sessionToken && !result.data.guard, 'Deleted record must not issue a guard/session');
}
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  db = mongoose.connection;
  const phones = [apPhone, opsPhone, legacyPhone, mirrorPhone];
  assert.equal(await db.collection('apguards').countDocuments({ phone: { $in: phones } }), 0);
  await db.collection('users').insertOne({ _id: owner, email: `${owner}@test.invalid`, portalType: 'agency', role: 'agency', isActive: true });
  await db.collection('apguards').insertOne({ _id: ap, name: 'Revocation fixture', phone: apPhone, status: 'Active', agencyId: String(owner) });
  const apLogin = await login(apPhone);
  assert.equal(apLogin.data.guard?._id, String(ap));
  assert.equal((await check(ap, apLogin.data.sessionToken)).status, 200);
  await db.collection('apguards').deleteOne({ _id: ap });
  removed(await check(ap, apLogin.data.sessionToken));
  removed(await call(`guard/today?guardId=${ap}`, { token: apLogin.data.sessionToken }));
  await cannotLogin(apPhone);
  await db.collection('apguards').insertOne({ _id: replacement, name: 'Re-added fixture', phone: apPhone, status: 'Active', agencyId: String(owner) });
  assert.equal((await login(apPhone)).data.guard?._id, String(replacement));
  removed(await check(ap, apLogin.data.sessionToken));
  await db.collection('users').deleteOne({ _id: owner });
  removed(await check(replacement));
  console.log('PASS AP deletion, old session denied, re-add uses new identity, agency deletion');

  await db.collection('ops_records').insertOne({ _id: ops, module: 'guards', status: 'Active', payload: { name: 'Ops fixture', phone: opsPhone, status: 'Active' } });
  const opsLogin = await login(opsPhone);
  assert.equal(opsLogin.data.guard?._id, String(ops));
  assert.equal((await check(ops, opsLogin.data.sessionToken)).status, 200);
  const deletion = await call(`ops/guards?id=${ops}`, { method: 'DELETE' });
  assert.equal(deletion.status, 200);
  removed(await check(ops, opsLogin.data.sessionToken));
  await cannotLogin(opsPhone);
  console.log('PASS actual Ops DELETE revokes mirrored guard and login');

  await db.collection('apguards').insertOne({ _id: legacy, name: 'Legacy fixture', phone: legacyPhone, status: 'Active', agencyId: '', registrationStatus: 'APPROVED' });
  await db.collection('ops_records').insertOne({ _id: legacySource, module: 'guards', status: 'Active', data: { name: 'Legacy fixture', phone: legacyPhone } });
  assert.equal((await check(legacy)).status, 200);
  const linked = await db.collection('apguards').findOne({ _id: legacy });
  assert.equal(linked.opsRecordId, String(legacySource));
  await db.collection('ops_records').deleteOne({ _id: legacySource });
  removed(await check(legacy));
  await cannotLogin(legacyPhone);
  console.log('PASS legacy approved registration binds to Ops source then revokes');

  await db.collection('ops_records').insertOne({ _id: projectionSource, module: 'guards', status: 'Active', payload: { name: 'Mirror fixture', phone: mirrorPhone } });
  assert.equal((await login(mirrorPhone)).data.guard?._id, String(projectionSource));
  await db.collection('apguards').deleteOne({ _id: projectionSource });
  await cannotLogin(mirrorPhone);
  assert.equal(await db.collection('apguards').countDocuments({ _id: projectionSource }), 0);
  console.log('PASS AP deletion of Ops projection is not auto-recreated');
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  if (db) {
    await db.collection('users').deleteOne({ _id: owner });
    await db.collection('apguards').deleteMany({ _id: { $in: ids } });
    await db.collection('ops_records').deleteMany({ _id: { $in: ids } });
    await db.collection('guardappprofiles').deleteMany({ guardId: { $in: ids.map(String) } });
  }
  await mongoose.disconnect();
});
