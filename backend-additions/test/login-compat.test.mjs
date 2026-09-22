import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardPhonePattern } from '../src/lib/guardPhone.ts';
import { guardCorsHeaders } from '../src/lib/guardCors.ts';

test('AP phone formatting matches the OTP-verified number only', () => {
  const pattern = guardPhonePattern('+919876543210');
  for (const value of ['9876543210', '+919876543210', '+91 9876543210', '+91 98765 43210', '91-98765-43210']) {
    assert.equal(pattern.test(value), true, value);
  }
  for (const value of ['9876543211', '+449876543210', '19876543210', '98765432100', '']) {
    assert.equal(pattern.test(value), false, value);
  }
  assert.throws(() => guardPhonePattern('123'));
});

test('CORS allows local development and explicit production origins only', () => {
  const env = process.env.NODE_ENV;
  const origins = process.env.GUARD_WEB_ORIGINS;
  try {
    process.env.NODE_ENV = 'development';
    assert.equal(guardCorsHeaders('http://localhost:8081')['Access-Control-Allow-Origin'], 'http://localhost:8081');
    assert.equal(guardCorsHeaders('https://untrusted.example'), null);
    assert.equal(guardCorsHeaders(null), null);
    process.env.NODE_ENV = 'production';
    assert.equal(guardCorsHeaders('http://localhost:8081'), null);
    process.env.GUARD_WEB_ORIGINS = 'https://guard.example';
    assert.ok(guardCorsHeaders('https://guard.example'));
    assert.ok(guardCorsHeaders('https://guards.surakshaguards.in'));
  } finally {
    if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env;
    if (origins === undefined) delete process.env.GUARD_WEB_ORIGINS; else process.env.GUARD_WEB_ORIGINS = origins;
  }
});
