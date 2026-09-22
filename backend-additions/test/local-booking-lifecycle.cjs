// Integration test: creates and removes one uniquely identified fixture, never a real order.
const { createRequire } = require('node:module');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const backend = path.resolve(__dirname, '../../../suraksha-app');
const req = createRequire(path.join(backend, 'package.json'));
req('@next/env').loadEnvConfig(backend, true, { info() {}, error() {} });
const mongoose = req('mongoose');
const bookingId = `TEST-GUARD-FLOW-${randomUUID()}`;
const guardId = new mongoose.Types.ObjectId().toString();
let insertedId;
let collection;
async function post(route, body) {
  const response = await fetch(`http://localhost:4545/api/guard/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:8081' },
    body: JSON.stringify({ bookingId, guardId, ...body }),
  });
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:8081');
  return { status: response.status, data: await response.json() };
}
(async () => {
  if (!process.env.MONGODB_URI) throw new Error('Missing local backend database.');
  await mongoose.connect(process.env.MONGODB_URI);
  collection = mongoose.connection.collection('bookings');
  const fixture = await collection.insertOne({ bookingId, customerEmail: 'guard-flow-test@example.invalid',
    serviceType: 'Bouncer', bookingStatus: 'ASSIGNED', assignedGuard: { guardId },
    dutyDetails: { arrivalOtp: '674219' }, priceQuote: { total: 0 }, createdAt: new Date(), updatedAt: new Date() });
  insertedId = fixture.insertedId;
  assert.equal((await post('start-duty', { otp: '000000' })).status, 400);
  assert.equal((await post('start-duty', { otp: '674219', guardId: new mongoose.Types.ObjectId().toString() })).status, 404);
  const start = await post('start-duty', { otp: '674219' });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  assert.equal(start.data.booking.bookingStatus, 'ACTIVE');
  assert.ok(start.data.booking.dutyDetails.dutyStartedAt);
  assert.equal((await post('complete-duty', { otp: '674219' })).status, 404);
  const checkout = await post('initiate-checkout', {});
  assert.equal(checkout.status, 200, JSON.stringify(checkout.data));
  assert.equal(checkout.data.booking.bookingStatus, 'CHECKOUT_INITIATED');
  // Test fixture's client code, retrieved as the client would receive it; never printed.
  const code = checkout.data.booking.dutyDetails.checkoutOtp;
  assert.equal((await post('complete-duty', { otp: '000000' })).status, 400);
  const complete = await post('complete-duty', { otp: code });
  assert.equal(complete.status, 200, JSON.stringify(complete.data));
  assert.equal(complete.data.booking.bookingStatus, 'COMPLETED');
  assert.ok(complete.data.booking.dutyDetails.dutyCompletedAt);
  assert.ok(complete.data.booking.invoiceNumber);
  assert.ok(complete.data.booking.settlement.settledAt);
  assert.equal((await post('complete-duty', { otp: code })).status, 404);
  console.log('PASS: assigned -> arrival OTP -> active -> checkout -> client OTP -> completed; invalid codes, wrong guard, out-of-order and repeat completion rejected.');
})().catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(async () => {
    if (insertedId) await collection.deleteOne({ _id: insertedId, bookingId });
    await mongoose.disconnect();
  });
