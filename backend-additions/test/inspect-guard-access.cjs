const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../../../suraksha-app');
const req = createRequire(path.join(root, 'package.json'));
req('@next/env').loadEnvConfig(root, true, { info() {}, error() {} });
const m = req('mongoose');
(async () => {
  const digits = process.argv[2];
  if (!/^\d{10}$/.test(digits || '')) throw new Error('Pass the 10-digit phone to inspect.');
  await m.connect(process.env.MONGODB_URI);
  const pattern = new RegExp(digits.split('').join('\\D*') + '$');
  console.log(JSON.stringify(await m.connection.collection('apguards').find({ phone: pattern }, {
    projection: { _id: 1, agencyId: 1, authSource: 1, opsRecordId: 1, registrationStatus: 1, registeredAt: 1, status: 1 },
  }).toArray()));
  console.log('Ops matches:', await m.connection.collection('ops_records').countDocuments({ module: 'guards',
    $or: [{ 'payload.phone': pattern }, { 'data.phone': pattern }],
  }));
})().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => m.disconnect());
