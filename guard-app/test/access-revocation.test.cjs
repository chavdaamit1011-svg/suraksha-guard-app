const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { test } = require('node:test');

function client(fetch) {
  const saved = new Map();
  const secure = {
    get: async key => saved.get(key) ?? null,
    set: async (key, value) => { saved.set(key, value); },
    del: async key => { saved.delete(key); },
  };
  const modules = {};
  function load(name) {
    if (modules[name]) return modules[name];
    const file = path.join(__dirname, '../src/lib', `${name}.ts`);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exports = {};
    const requireMock = id => {
      if (id === '@/config') return { API_BASE_URL: 'http://test.local' };
      if (id === '@/lib/storage') return { secure, KEYS: { session: 'session' } };
      if (id === '@/lib/session') return load('session');
      throw Error(`Unexpected import ${id}`);
    };
    vm.runInNewContext(code, { exports, require: requireMock, fetch, URL, AbortController, setTimeout, clearTimeout });
    modules[name] = exports;
    return exports;
  }
  return { ...load('session'), api: load('api').api, saved };
}
const reply = (status, data) => new Response(JSON.stringify(data), { status });
const revoked = { success: false, code: 'guard_removed', action: 'LOGOUT' };

test('deleted guard clears token and notifies app to sign out', async () => {
  const c = client(async () => reply(401, revoked));
  let signedOut = 0;
  c.onSignedOut(() => signedOut++);
  await c.saveSession('old-token', Date.now() + 7 * 86400000);
  await assert.rejects(c.api.access('guard-a'), { code: 'guard_removed' });
  assert.equal(signedOut, 1);
  assert.equal(c.hasSession(), false);
  assert.equal(c.saved.has('session'), false);
});

test('legacy cached login without a token also signs out', async () => {
  const c = client(async () => reply(401, revoked));
  let signedOut = false;
  c.onSignedOut(() => { signedOut = true; });
  await assert.rejects(c.api.access('guard-a'));
  assert.equal(signedOut, true);
});

test('network outage and backend error do not log out an active guard', async () => {
  for (const fetch of [async () => { throw Error('offline'); }, async () => reply(503, { success: false })]) {
    const c = client(fetch);
    let signedOut = false;
    c.onSignedOut(() => { signedOut = true; });
    await c.saveSession('token', Date.now() + 7 * 86400000);
    await assert.rejects(c.api.access('guard-a'));
    assert.equal(signedOut, false);
    assert.equal(c.hasSession(), true);
  }
});

test('deletion on retry after session renewal also signs out', async () => {
  let requests = 0;
  const c = client(async url => {
    if (url.endsWith('/auth/refresh')) return reply(200, { sessionToken: 'new-token', sessionExpiresAt: Date.now() + 7 * 86400000 });
    return ++requests === 1 ? reply(401, { code: 'session_expired' }) : reply(401, revoked);
  });
  let signedOut = false;
  c.onSignedOut(() => { signedOut = true; });
  await c.saveSession('old-token', Date.now() + 7 * 86400000);
  await assert.rejects(c.api.access('guard-a'));
  assert.equal(signedOut, true);
  assert.equal(c.hasSession(), false);
});
