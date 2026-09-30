'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  installRendererWindowProxy,
  isCompatibilityWindowProxy,
} = require('../window-proxy.js');

test('bridge uses the QQ channel and preserves every argument and the Promise', async () => {
  const calls = [];
  const promise = Promise.resolve('window result');
  const ipcRenderer = { invoke(...args) { assert.equal(this, ipcRenderer); calls.push(args); return promise; } };
  const globalObject = {};
  assert.equal(installRendererWindowProxy({ ipcRenderer, globalObject }), true);
  const options = { animate: false };
  const result = globalObject.proxyInvoke('setBackgroundColor', '#112233', options);
  assert.equal(result, promise);
  assert.deepEqual(calls, [['browser-window-proxy', 'setBackgroundColor', '#112233', options]]);
  assert.equal(calls[0][3], options);
  assert.equal(await result, 'window result');
});

test('repeated installation preserves the fallback function', () => {
  const globalObject = {};
  const ipcRenderer = { invoke: () => Promise.resolve() };
  assert.equal(installRendererWindowProxy({ ipcRenderer, globalObject }), true);
  const existing = globalObject.proxyInvoke;
  assert.equal(installRendererWindowProxy({ globalObject }), false);
  assert.equal(globalObject.proxyInvoke, existing);
  assert.equal(isCompatibilityWindowProxy(existing), true);
});

test('renderer preserves an existing function', () => {
  const existing = () => 'Tencent implementation';
  const globalObject = { proxyInvoke: existing };
  assert.equal(installRendererWindowProxy({ globalObject }), false);
  assert.equal(globalObject.proxyInvoke, existing);
  assert.equal(isCompatibilityWindowProxy(existing), false);
});

test('renderer reports an existing invalid bridge', () => {
  for (const value of [null, 0, '', {}]) {
    assert.throws(
      () => installRendererWindowProxy({ globalObject: { proxyInvoke: value } }),
      { name: 'TypeError', message: 'QQ proxyInvoke already exists and is not a function' },
    );
  }
});

test('IPC rejection propagates without swallowing a TypeError', async () => {
  const failure = new TypeError('native window failure');
  const globalObject = {};
  const promise = Promise.reject(failure);
  installRendererWindowProxy({ ipcRenderer: { invoke: () => promise }, globalObject });
  assert.equal(globalObject.proxyInvoke('setTitle', 'title'), promise);
  await assert.rejects(promise, (error) => error === failure);
});

test('synchronous IPC errors propagate unchanged', () => {
  const failure = new TypeError('invalid IPC arguments');
  const globalObject = {};
  installRendererWindowProxy({ ipcRenderer: { invoke() { throw failure; } }, globalObject });
  assert.throws(() => globalObject.proxyInvoke('show'), (error) => error === failure);
});

test('QQ can replace a fallback with its native preloadAux bridge', () => {
  const globalObject = {};
  installRendererWindowProxy({ ipcRenderer: { invoke: () => Promise.resolve() }, globalObject });
  const fallback = globalObject.proxyInvoke;
  const descriptor = Object.getOwnPropertyDescriptor(globalObject, 'proxyInvoke');
  assert.equal(descriptor.configurable, true);
  assert.equal(descriptor.enumerable, true);
  assert.equal(descriptor.writable, false);
  assert.equal(isCompatibilityWindowProxy(fallback), true);

  const original = () => 'Tencent implementation';
  Object.defineProperty(globalObject, 'proxyInvoke', {
    configurable: true,
    enumerable: true,
    writable: false,
    value: original,
  });
  assert.equal(globalObject.proxyInvoke, original);
  assert.equal(isCompatibilityWindowProxy(original), false);
  assert.equal(installRendererWindowProxy({ globalObject }), false);
});

test('compatibility marker accepts only functions created by this module', () => {
  for (const value of [undefined, null, 0, {}, () => {}]) {
    assert.equal(isCompatibilityWindowProxy(value), false);
  }
});
