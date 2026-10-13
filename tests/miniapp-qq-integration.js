'use strict';

// Run with QQ's native compatibility library in Electron's Node mode:
// ELECTRON_RUN_AS_NODE=1 LD_PRELOAD=/usr/lib/QQ/libelectron-compat.so \
//   /usr/lib/electron40/electron tests/miniapp-qq-integration.js
// QQ_APP_DIR may point to another unpacked installation of the pinned QQ build.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { installMiniAppBrowser } = require('../miniapp-browser.js');
require('../code-cache.js');

const appDirectory = process.env.QQ_APP_DIR || '/usr/lib/QQ/resources/app';
const html = fs.readFileSync(
  path.join(appDirectory, 'application.asar/renderer/index.html'), 'utf8',
);
const loaded = [];
const opened = [];
let webpackRequire;
let major;
const context = vm.createContext({
  console, URL, URLSearchParams, Buffer, performance,
  setTimeout(callback, delay, ...args) {
    // QQ also schedules a 120-second chunk timeout. Every test chunk is local.
    return delay < 1000 ? setTimeout(callback, delay, ...args) : null;
  },
  clearTimeout,
});
context.self = context;
context.window = context;
context.navigator = { onLine: true, userAgent: 'Linux' };
context.location = {
  protocol: 'app:', href: 'app://./renderer/index.html',
  pathname: '/renderer/index.html', search: '', hash: '',
};
context.electron = {
  load(name) {
    loaded.push(name);
    major.load(name, module);
  },
};
context.document = {
  getElementsByTagName() { return []; },
  createElement(tagName) { return { tagName, setAttribute() {} }; },
  head: {
    appendChild(element) {
      // QQ's real Webpack loader inserts an inline electron.load() script.
      assert.equal(element.tagName, 'script');
      vm.runInContext(element.innerHTML, context);
      element.onload?.({ type: 'load', target: element });
    },
  },
};
context.webpackChunkqq_chat = [[
  [987654321], {}, (require) => { webpackRequire = require; },
]];
installMiniAppBrowser({ globalObject: context, platform: 'linux' });

const CompatibleScript = vm.Script;
vm.Script = class extends CompatibleScript {
  runInThisContext(options) { return this.runInContext(context, options); }
  runInMainContext(options) { return this.runInContext(context, options); }
};
major = require(path.join(appDirectory, 'major.node'));
context.electron.load('r_app');
assert.equal(typeof webpackRequire?.e, 'function');
// Keep QQ's real module/chunk loader, but do not start the desktop application.
webpackRequire.O = Object.assign(() => undefined, webpackRequire.O);
for (const [, name] of html.matchAll(/window\.electron\.load\('([^']+)'\)/g)) {
  if (name !== 'r_app') context.electron.load(name);
}
// MiniAppShare's original route also loads its base processor (module 52723).
context.electron.load('r_17033');
context.electron.load('r_46603');
assert.equal(typeof webpackRequire.m[26126], 'function');
assert.equal(webpackRequire.m[26643], undefined);
assert.equal(webpackRequire.m[61570], undefined);

// Keep the original MiniAppShare, menu, URL extraction, and classification
// factories. Substitute application services that require a running QQ login.
const stub = new Proxy(function serviceStub() { return stub; }, {
  get(target, key) {
    if (key === Symbol.toPrimitive) return () => '';
    if (key === 'then') return undefined;
    if (key === '__esModule') return true;
    return stub;
  },
  construct() { return stub; },
});
const config = {
  arkComponentIntercept: {
    jumpInterception: {
      miniapp01: {
        type: 'appid', appid: 'com.tencent.miniapp_01',
        extraValueReg: '^(1108338344|1108961705)$',
      },
      qqDocPush: { appid: 'com.tencent.miniapp_01', extraValueReg: '^1108338344$' },
    },
  },
};
const overrides = {
  69494: { gn: (_, target) => target, w6: () => () => {} },
  49611: { b: () => () => {} },
  24522: { y: () => () => {} },
  52723: { Z: class {} },
  41773: {
    container: {
      get(Type) {
        return typeof Type?.prototype?.urlSafeOpen === 'function'
          ? new Type() : config;
      },
    },
  },
  3747: { kg: { info() {}, warn() {}, error() {} } },
  1405: { dG(url) { opened.push(url); } },
};
const realModules = new Set([
  26126, 26643, 61570, 45068, 26637, 19121, 9781,
  46921, 35401, 57092, 94957, 93707, 99199,
]);
const cache = new Map();
function requireModule(id) {
  assert.equal(typeof webpackRequire.m[id], 'function', `Missing QQ module ${id}`);
  if (Object.hasOwn(overrides, id)) return overrides[id];
  if (!realModules.has(Number(id))) return stub;
  if (cache.has(id)) return cache.get(id).exports;
  const entry = { exports: {} };
  cache.set(id, entry);
  webpackRequire.m[id](entry, entry.exports, requireModule);
  return entry.exports;
}
Object.assign(requireModule, webpackRequire);

async function main() {
  const MiniAppShare = requireModule(26126).Z;
  const rawCard = {
    app: 'com.tencent.miniapp_01',
    meta: { detail_1: { appid: '123', qqdocurl: 'https://article.example/content' } },
  };
  const record = {
    sendStatus: 2, msgType: 11,
    elements: [{ elementType: 10, arkElement: { bytesData: JSON.stringify(rawCard) } }],
  };
  const service = new MiniAppShare();
  service.url = 'miniapp://open/1007?url=https%3A%2F%2Fscan.example%2F';
  service.clickArkInfo = {
    app: rawCard.app,
    meta: { detail_1: { appid: '123', qqdocurl: 'https://scan.example/phone-only' } },
    msgRecord: record,
  };
  assert.equal(service.isTencentDocMiniApp(), false);
  await service.execute();
  assert.equal(loaded.filter((name) => name === 'r_453').length, 1);
  assert.equal(loaded.filter((name) => name === 'r_87189').length, 1);
  assert.equal(typeof webpackRequire.m[26643], 'function');
  assert.equal(typeof webpackRequire.m[61570], 'function');
  assert.deepEqual(opened, ['https://article.example/content']);
  const defaultClickURLs = opened.splice(0);
  const menu = requireModule(26643).Z;
  assert.equal(menu.icon, 'Link');
  assert.equal(menu.when({ msgRecord: record }), true);
  menu.handler(record);
  assert.deepEqual(opened, defaultClickURLs);
  console.log('QQ integration passed: first click lazily loads the original browser action');
  console.log('Processed scan URL is ignored; default click matches the real right-click handler');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
