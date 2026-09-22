import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserDeviceId } from '../src/lib/browserDevice.ts';

const storage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
};

test('migrates the current tab identity and keeps it after a tab closes', () => {
  const persistent = storage();
  const originalTab = storage({ 'sg.deviceId': 'nodev.original' });
  const generate = () => { throw new Error('must not generate a new device'); };
  assert.equal(browserDeviceId(persistent, originalTab, generate), 'nodev.original');
  assert.equal(browserDeviceId(persistent, storage(), generate), 'nodev.original');
  assert.equal(browserDeviceId(persistent, storage({ 'sg.deviceId': 'stale-tab' }), generate), 'nodev.original');
});

test('a separate browser receives a separate persistent identity', () => {
  const persistent = storage();
  let calls = 0;
  const create = () => `web.${++calls}`;
  assert.equal(browserDeviceId(persistent, storage(), create), 'web.1');
  assert.equal(browserDeviceId(persistent, storage(), create), 'web.1');
  assert.equal(browserDeviceId(storage(), storage(), create), 'web.2');
});

test('storage failure does not silently create a different identity on every request', () => {
  const unavailable = { getItem() { throw new Error('Storage unavailable'); }, setItem() {} };
  assert.throws(() => browserDeviceId(unavailable, storage(), () => 'random'), /Storage unavailable/);
});
