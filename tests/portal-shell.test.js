'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { installPortalShell } = require('../portal-shell.js');

function fixture(openURI) {
  let loads = 0;
  const otherMethod = () => 'unchanged';
  const shell = {
    openExternal() { assert.fail('must never fall back to spawning xdg-open'); },
    openPath: otherMethod,
  };
  const loader = () => { loads++; return { openURI }; };
  installPortalShell(shell, loader);
  return { shell, loader, otherMethod, get loads() { return loads; } };
}

test('opens through the portal, preserving the URI and Promise<void> API', async () => {
  const calls = [];
  let complete;
  const request = new Promise((resolve) => { complete = resolve; });
  const f = fixture((url) => { calls.push(url); return request; });
  assert.equal(f.loads, 0);
  const uri = 'https://example.org/article?a=1&text=%E4%B8%AD%E6%96%87#section';
  const result = f.shell.openExternal(uri, { activate: false });
  let settled = false;
  result.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(calls, [uri]);
  complete();
  assert.equal(await result, undefined);
  await f.shell.openExternal('mailto:someone@example.org?subject=test');
  await f.shell.openExternal('mqqapi://example/action');
  await f.shell.openExternal('file:///tmp/with%20spaces.txt');
  assert.equal(f.loads, 1);
  assert.equal(f.shell.openPath, f.otherMethod);
});

test('propagates cancellation, unavailable service and timeout without fallback', async () => {
  for (const code of ['ERR_PORTAL_CANCELLED', 'ERR_PORTAL_UNAVAILABLE', 'ERR_PORTAL_TIMEOUT', 'ERR_PORTAL_FAILED']) {
    const error = Object.assign(new Error(code), { code });
    const f = fixture(() => Promise.reject(error));
    await assert.rejects(f.shell.openExternal('https://example.org'), (actual) => actual === error);
  }
});

test('rejects invalid URI arguments before loading native code', async () => {
  const f = fixture(() => assert.fail('invalid URI reached the portal'));
  for (const uri of [undefined, null, {}, 12, '', '/tmp/a', 'example.org', 'https://example.org\0hidden']) {
    await assert.rejects(f.shell.openExternal(uri), TypeError);
  }
  assert.equal(f.loads, 0);
});

test('repeated preload installation preserves the bridge', () => {
  const f = fixture(() => Promise.resolve());
  const installed = f.shell.openExternal;
  assert.equal(installPortalShell(f.shell, () => assert.fail('second loader called')), false);
  assert.equal(f.shell.openExternal, installed);
});

test('a missing native module rejects the Promise without invoking the old shell', async () => {
  const shell = { openExternal() { assert.fail('old shell called'); } };
  const error = Object.assign(new Error('addon missing'), { code: 'MODULE_NOT_FOUND' });
  installPortalShell(shell, () => { throw error; });
  await assert.rejects(shell.openExternal('https://example.org'), (actual) => actual === error);
});
