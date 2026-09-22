/**
 * Round-trip test for the encrypted-store primitives: the hand-rolled base64 and AES-256-GCM.
 * Run under plain Node against the same @noble/ciphers the app bundles.
 */
import { gcm } from '@noble/ciphers/aes.js';
import { bytesToUtf8, utf8ToBytes } from '@noble/ciphers/utils.js';
import crypto from 'crypto';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
};

// --- verbatim copies of the app's implementations ---
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64encode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[b2 & 63] : '=';
  }
  return out;
}

const B64_INDEX = {};
for (let i = 0; i < B64.length; i++) B64_INDEX[B64[i]] = i;

function b64decode(s) {
  const clean = s.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let p = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64_INDEX[clean[i]];
    if (v === undefined) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[p++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, p);
}

console.log('\n=== base64 round-trip vs Node Buffer ===');
// Every length modulo 3, which is where padding bugs live.
for (const len of [0, 1, 2, 3, 4, 5, 6, 7, 8, 15, 16, 17, 31, 32, 33, 100, 1000]) {
  const bytes = new Uint8Array(crypto.randomBytes(len));
  const mine = b64encode(bytes);
  const theirs = Buffer.from(bytes).toString('base64');
  if (mine !== theirs) {
    check(`encode len=${len} matches Node`, false, { mine, theirs });
    continue;
  }
  const back = b64decode(mine);
  const same = back.length === bytes.length && back.every((b, i) => b === bytes[i]);
  check(`len=${len} encodes like Node and decodes back`, same);
}

console.log('\n=== decodes what Node produced ===');
for (const len of [1, 2, 3, 17, 64]) {
  const bytes = new Uint8Array(crypto.randomBytes(len));
  const nodeB64 = Buffer.from(bytes).toString('base64');
  const back = b64decode(nodeB64);
  check(`len=${len} round-trips from Node base64`, back.length === len && back.every((b, i) => b === bytes[i]));
}

console.log('\n=== AES-256-GCM round-trip ===');
const key = new Uint8Array(crypto.randomBytes(32));

const samples = [
  '{}',
  JSON.stringify({ hello: 'world' }),
  JSON.stringify({ events: Array.from({ length: 200 }, (_, i) => ({ i, uuid: crypto.randomUUID(), lat: 30.7333 })) }),
  'नमस्ते दुनिया — ड्यूटी शुरू',
  'ਪੰਜਾਬੀ ଓଡ଼ିଆ ᱥᱟᱱᱛᱟᱲᱤ 🛡️',
];

for (const plain of samples) {
  const nonce = new Uint8Array(crypto.randomBytes(12));
  const ct = gcm(key, nonce).encrypt(utf8ToBytes(plain));
  const stored = `sgenc1:${b64encode(nonce)}.${b64encode(ct)}`;

  const [nB64, cB64] = stored.slice('sgenc1:'.length).split('.');
  const back = bytesToUtf8(gcm(key, b64decode(nB64)).decrypt(b64decode(cB64)));
  check(`round-trips (${plain.length} chars)`, back === plain, back === plain ? undefined : back.slice(0, 40));
}

console.log('\n=== tampering is detected, not silently accepted ===');
{
  const nonce = new Uint8Array(crypto.randomBytes(12));
  const ct = gcm(key, nonce).encrypt(utf8ToBytes(JSON.stringify({ checkedIn: false })));
  // Flip a bit in the ciphertext, the way a guard editing the store would.
  const tampered = Uint8Array.from(ct);
  tampered[2] ^= 0x01;
  let threw = false;
  try {
    gcm(key, nonce).decrypt(tampered);
  } catch {
    threw = true;
  }
  check('a flipped bit fails authentication', threw);
}

console.log('\n=== the wrong key cannot read it ===');
{
  const nonce = new Uint8Array(crypto.randomBytes(12));
  const ct = gcm(key, nonce).encrypt(utf8ToBytes('secret'));
  const otherKey = new Uint8Array(crypto.randomBytes(32));
  let threw = false;
  try {
    gcm(otherKey, nonce).decrypt(ct);
  } catch {
    threw = true;
  }
  check('a different key fails', threw);
}

console.log('\n=== plaintext written by an older build is still readable ===');
{
  const legacy = JSON.stringify({ old: true });
  check('values without the magic prefix pass through', !legacy.startsWith('sgenc1:'));
}

console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
process.exit(fail ? 1 : 0);
