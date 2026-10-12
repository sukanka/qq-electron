'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  getMiniAppBrowserURL,
  installMiniAppBrowser,
} = require('../miniapp-browser.js');

function card(detail, key = 'detail_1') {
  return { app: 'com.tencent.miniapp_01', meta: { [key]: detail } };
}

function fixture(openExternal = () => Promise.resolve()) {
  const globalObject = {};
  const shell = { openExternal };
  installMiniAppBrowser({ shell, globalObject });
  class MiniAppShare {
    constructor(info) { this.clickArkInfo = info; this.calls = []; }
    isMyTarget() { return true; }
    isTencentDocMiniApp() { return this.isDoc === true; }
    openMiniAppUrl() {}
    execute(...args) { this.calls.push(args); return this.result; }
  }
  const exports = {};
  // QQ uses getters for its exports, including classes from lazy chunks.
  const chunk = [[123], {
    456(module) {
      Object.defineProperty(module.exports, 'Z', { get: () => MiniAppShare });
    },
  }];
  globalObject.webpackChunkqq_chat.push(chunk);
  chunk[1][456]({ exports });
  return { globalObject, shell, MiniAppShare };
}

test('uses the browser menu field order and preserves the complete URL', () => {
  const url = 'https://example.org/article?a=1&text=%E4%B8%AD%E6%96%87#section';
  const detail = { qqdocurl: url, url: 'https://example.org/u', jumpUrl: 'https://example.org/j' };
  assert.equal(getMiniAppBrowserURL(card(detail)), url);
  delete detail.qqdocurl;
  assert.equal(getMiniAppBrowserURL(card(detail)), detail.url);
  delete detail.url;
  assert.equal(getMiniAppBrowserURL(card(detail)), detail.jumpUrl);
  assert.equal(getMiniAppBrowserURL(card(detail, 'miniapp')), detail.jumpUrl);
});

test('detail_1 wins over miniapp even when empty, as in QQ', () => {
  const info = card({ url: 'https://example.org/miniapp' }, 'miniapp');
  info.meta.detail_1 = { url: 'https://example.org/detail' };
  assert.equal(getMiniAppBrowserURL(info), info.meta.detail_1.url);
  info.meta.detail_1 = {};
  assert.equal(getMiniAppBrowserURL(info), null);
});

test('extracts the browser URL from the original message when needed', () => {
  const info = {
    msgRecord: { elements: [
      { textElement: { content: 'text' } },
      { arkElement: { bytesData: '{malformed' } },
      { arkElement: { bytesData: JSON.stringify(card({ url: 'https://example.org/card' })) } },
    ] },
  };
  assert.equal(getMiniAppBrowserURL(info), 'https://example.org/card');
  info.meta = { detail_1: { url: 'https://example.org/clicked-card' } };
  assert.equal(getMiniAppBrowserURL(info), 'https://example.org/clicked-card');
});

test('only sends usable web URLs to the browser, skipping app launch schemes', () => {
  for (const url of [
    '', 'not a URL', 'https://', 'https://example.org/\0hidden',
    'https://exam\tple.org', 'javascript:alert(1)', 'file:///tmp/card',
    'mqqapi://miniapp/open', 'miniapp://open/123', {}, 1,
  ]) {
    assert.equal(getMiniAppBrowserURL(card({ url })), null);
  }
  assert.equal(getMiniAppBrowserURL(card({
    url: 'mqqapi://miniapp/open', jumpUrl: 'https://example.org/web',
  })), 'https://example.org/web');
  for (const info of [undefined, null, {}, { meta: null }, { msgRecord: { elements: {} } }]) {
    assert.equal(getMiniAppBrowserURL(info), null);
  }
});

test('clicking a mini-app opens its webpage once through the existing shell', async () => {
  const calls = [];
  const promise = Promise.resolve();
  const { MiniAppShare, shell } = fixture(function (url) {
    assert.equal(this, shell);
    calls.push(url);
    return promise;
  });
  const instance = new MiniAppShare(card({ url: 'https://example.org/article' }));
  assert.equal(instance.execute(), promise);
  await promise;
  assert.deepEqual(calls, ['https://example.org/article']);
  assert.deepEqual(instance.calls, []);
});

test('Tencent Docs and cards without a webpage retain QQ behavior and arguments', async () => {
  const { MiniAppShare } = fixture(() => assert.fail('should keep QQ action'));
  for (const info of [undefined, {}, card({ appid: '123' }), card({ url: 'miniapp://open/123' })]) {
    const instance = new MiniAppShare(info);
    const promise = instance.result = Promise.resolve('QQ result');
    const argument = { source: 'click' };
    assert.equal(instance.execute(argument, 2), promise);
    assert.deepEqual(instance.calls, [[argument, 2]]);
    assert.equal(await promise, 'QQ result');
  }
  const doc = new MiniAppShare(card({ url: 'https://docs.qq.com/example' }));
  doc.isDoc = true;
  doc.execute('document');
  assert.deepEqual(doc.calls, [['document']]);
});

test('portal errors propagate without launching QQ or a second browser request', async () => {
  const error = Object.assign(new Error('cancelled'), { code: 'ERR_PORTAL_CANCELLED' });
  const { MiniAppShare } = fixture(() => Promise.reject(error));
  const instance = new MiniAppShare(card({ url: 'https://example.org' }));
  await assert.rejects(instance.execute(), (actual) => actual === error);
  assert.deepEqual(instance.calls, []);
});

test('repeated preloads preserve the installed action and unrelated modules', () => {
  const { MiniAppShare, globalObject, shell } = fixture();
  const execute = MiniAppShare.prototype.execute;
  assert.equal(installMiniAppBrowser({ globalObject, shell }), false);
  class OtherService { execute() { return 'normal link'; } }
  const original = OtherService.prototype.execute;
  const chunk = [[789], { 101(module) { module.exports = { MiniAppShare, OtherService }; } }];
  globalObject.webpackChunkqq_chat.push(chunk);
  chunk[1][101]({ exports: {} });
  assert.equal(MiniAppShare.prototype.execute, execute);
  assert.equal(OtherService.prototype.execute, original);
});
