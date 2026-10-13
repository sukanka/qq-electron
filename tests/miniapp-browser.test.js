'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { installMiniAppBrowser } = require('../miniapp-browser.js');

function record(url = 'https://example.org/article') {
  return { elements: [{ elementType: 10, arkElement: {
    bytesData: JSON.stringify({ meta: { detail_1: { qqdocurl: url } } }),
  } }] };
}

function fixture({ loadChunk, platform = 'linux' } = {}) {
  const globalObject = {};
  const opened = [];
  const loaded = [];
  const menu = {
    text: '用浏览器打开', icon: 'Link', when() { return true; },
    handler(message) { assert.equal(this, menu); opened.push(message); },
  };
  const ready = new Set();
  const requireModule = Object.assign((id) => {
    assert.equal(id, 26643);
    assert.deepEqual([...ready].sort(), [453, 87189]);
    return { Z: menu };
  }, {
    async e(id) { loaded.push(id); await loadChunk?.(id); ready.add(id); },
  });
  installMiniAppBrowser({ globalObject, platform });
  class MiniAppShare {
    constructor(info) { this.clickArkInfo = info; this.calls = []; }
    isMyTarget() { return true; }
    isTencentDocMiniApp() { return this.isDoc === true; }
    openMiniAppUrl() {}
    execute(...args) { this.calls.push(args); return this.result; }
  }
  const chunk = [[123], {
    456(module) {
      Object.defineProperty(module.exports, 'Z', { get: () => MiniAppShare });
    },
  }];
  globalObject.webpackChunkqq_chat ??= [];
  globalObject.webpackChunkqq_chat.push(chunk);
  const module = { exports: {} };
  chunk[1][456](module, module.exports, requireModule);
  return { MiniAppShare, globalObject, menu, opened, loaded, requireModule };
}

test('passes the original record to the real menu entry, ignoring rewritten scan URLs', async () => {
  const f = fixture();
  const message = record();
  const instance = new f.MiniAppShare({
    meta: { detail_1: { url: 'https://m.q.qq.com/a/p/123' } },
    msgRecord: message,
  });
  instance.url = 'miniapp://open/123';
  await instance.execute();
  assert.deepEqual(f.loaded.sort(), [453, 87189]);
  assert.equal(f.opened.length, 1);
  assert.equal(f.opened[0], message);
  assert.deepEqual(instance.calls, []);
});

test('does not guess a link from metadata when the original record is unavailable', () => {
  const f = fixture();
  for (const info of [undefined, {}, { msgRecord: {} }, {
    meta: { detail_1: { url: 'https://m.q.qq.com/a/p/123' } },
  }]) {
    const instance = new f.MiniAppShare(info);
    const promise = instance.result = Promise.resolve('original result');
    const argument = { source: 'click' };
    assert.equal(instance.execute(argument, 2), promise);
    assert.deepEqual(instance.calls, [[argument, 2]]);
  }
  assert.deepEqual(f.loaded, []);
  assert.deepEqual(f.opened, []);
});

test('Tencent Docs and other platforms keep the original action', () => {
  for (const options of [{ platform: 'linux' }, { platform: 'win32' }, { platform: 'darwin' }]) {
    const f = fixture(options);
    const instance = new f.MiniAppShare({ msgRecord: record() });
    instance.isDoc = options.platform === 'linux';
    const promise = instance.result = Promise.resolve('QQ result');
    assert.equal(instance.execute('click'), promise);
    assert.deepEqual(instance.calls, [['click']]);
    assert.deepEqual(f.loaded, []);
    assert.deepEqual(f.opened, []);
  }
});

test('concurrent clicks preserve their records while sharing the menu load', async () => {
  let finishLoad;
  const pending = new Promise((resolve) => { finishLoad = resolve; });
  const f = fixture({ loadChunk: () => pending });
  const first = record('https://example.org/first');
  const second = record('https://example.org/second');
  const instance = new f.MiniAppShare({ msgRecord: first });
  const firstClick = instance.execute();
  instance.clickArkInfo = { msgRecord: second };
  const secondClick = instance.execute();
  assert.deepEqual(f.opened, []);
  finishLoad();
  await Promise.all([firstClick, secondClick]);
  assert.deepEqual(f.loaded.sort(), [453, 87189]);
  assert.equal(f.opened[0], first);
  assert.equal(f.opened[1], second);
  await instance.execute();
  assert.equal(f.loaded.length, 2);
  assert.equal(f.opened[2], second);
});

test('a failed chunk load rejects without launching a scan page and can be retried', async () => {
  const error = new Error('QQ chunk unavailable');
  let fail = true;
  const f = fixture({ loadChunk() { if (fail) throw error; } });
  const instance = new f.MiniAppShare({ msgRecord: record() });
  await assert.rejects(instance.execute(), (actual) => actual === error);
  assert.deepEqual(f.opened, []);
  assert.deepEqual(instance.calls, []);
  fail = false;
  await instance.execute();
  assert.equal(f.opened.length, 1);
});

test('rejects a mismatched menu and propagates handler failures without a second action', async () => {
  const f = fixture();
  const instance = new f.MiniAppShare({ msgRecord: record() });
  f.menu.text = 'unrelated menu';
  await assert.rejects(instance.execute(), /QQ browser context-menu implementation is unavailable/);
  f.menu.text = '用浏览器打开';
  const error = new Error('QQ browser action failed');
  f.menu.handler = () => { throw error; };
  await assert.rejects(instance.execute(), (actual) => actual === error);
  assert.deepEqual(instance.calls, []);
  assert.deepEqual(f.opened, []);
});

test('repeated preloads and export aliases do not wrap the action twice', async () => {
  const f = fixture();
  const execute = f.MiniAppShare.prototype.execute;
  assert.equal(installMiniAppBrowser({ globalObject: f.globalObject, platform: 'linux' }), false);
  class OtherService { execute() { return 'normal link'; } }
  const original = OtherService.prototype.execute;
  const chunk = [[789], { 101(module) { module.exports = { Share: f.MiniAppShare, OtherService }; } }];
  f.globalObject.webpackChunkqq_chat.push(chunk);
  chunk[1][101]({ exports: {} }, {}, f.requireModule);
  assert.equal(f.MiniAppShare.prototype.execute, execute);
  assert.equal(OtherService.prototype.execute, original);
  await new f.MiniAppShare({ msgRecord: record() }).execute();
  assert.equal(f.opened.length, 1);
});
