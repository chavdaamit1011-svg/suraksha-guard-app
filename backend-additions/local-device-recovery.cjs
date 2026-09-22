// Support repair for one explicitly approved pending device. Inspect is read-only.
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const backend = path.resolve(__dirname, '../../suraksha-app');
const backendRequire = createRequire(path.join(backend, 'package.json'));
backendRequire('@next/env').loadEnvConfig(backend, true, { info() {}, error() {} });
const mongoose = backendRequire('mongoose');
const fingerprint = (id) => createHash('sha256').update(id || '').digest('hex');

(async () => {
  if (!process.env.MONGODB_URI) throw new Error('Backend database is not configured.');
  await mongoose.connect(process.env.MONGODB_URI);
  const guard = await mongoose.connection.collection('apguards').findOne({ phone: '+91 9998665632' });
  if (!guard) throw new Error('Expected guard not found.');
  const profiles = mongoose.connection.collection('guardappprofiles');
  const profile = await profiles.findOne({ guardId: String(guard._id) });
  if (!profile) throw new Error('No device profile found.');
  const expected = process.argv[2];
  if (expected) {
    if (!profile.pendingDeviceId || fingerprint(profile.pendingDeviceId) !== expected) {
      throw new Error('Pending device changed or is missing. Inspect and confirm again.');
    }
    const result = await profiles.updateOne({
      _id: profile._id, boundDeviceId: profile.boundDeviceId, pendingDeviceId: profile.pendingDeviceId,
    }, { $set: {
      boundDeviceId: profile.pendingDeviceId, pendingDeviceId: '', lastDeviceChangeAt: new Date(), updatedAt: new Date(),
    } });
    if (result.modifiedCount !== 1) throw new Error('Device changed concurrently; no approval applied.');
    const check = async (deviceId) => {
      const query = new URLSearchParams({ guardId: String(guard._id), deviceId });
      const response = await fetch(`http://localhost:4545/api/guard/today?${query}`);
      if (!response.ok) throw new Error(`Duty API returned ${response.status}`);
      return response.json();
    };
    const current = await check(profile.pendingDeviceId);
    if (!current.success || current.deviceBlocked) throw new Error('Approved device still cannot load duty.');
    if (profile.boundDeviceId && profile.boundDeviceId !== profile.pendingDeviceId) {
      const previous = await check(profile.boundDeviceId);
      if (!previous.deviceBlocked) throw new Error('Previous device unexpectedly retained access.');
    }
    console.log(JSON.stringify({ approved: true, guardId: String(guard._id),
      dutyAccessible: true, bookingId: current.bundle?.booking?.bookingId,
      bookingStatus: current.bundle?.booking?.bookingStatus }));
  } else {
    console.log(JSON.stringify({ guardId: String(guard._id), bound: !!profile.boundDeviceId,
      pending: !!profile.pendingDeviceId, pendingFingerprint: fingerprint(profile.pendingDeviceId),
      deviceModel: profile.deviceModel, lastChange: profile.lastDeviceChangeAt }));
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
