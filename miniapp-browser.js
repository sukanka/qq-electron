'use strict';

const { observeRendererModules } = require('./renderer-modules.js');

function installMiniAppBrowser({ globalObject = globalThis, platform = process.platform } = {}) {
  const installed = Symbol.for('qq-electron.miniapp-browser');
  if (platform !== 'linux' || globalObject[installed]) return false;

  const patchedTargets = new WeakSet();
  const browserMenus = new WeakMap();

  function loadBrowserMenu(requireModule) {
    if (!browserMenus.has(requireModule)) {
      // QQ 3.2.34-53644: the browser menu lives in chunk 453; its menu-type
      // enum lives in 87189. Neither is necessarily loaded before a right click.
      // Reuse the original handler, including its URL extraction and opening
      // service, rather than interpreting the rewritten Ark click metadata.
      const loading = Promise.all([
        requireModule.e(87189),
        requireModule.e(453),
      ]).then(() => {
        const menu = requireModule(26643)?.Z;
        if (menu?.text !== '用浏览器打开' || menu.icon !== 'Link'
          || typeof menu.handler !== 'function' || typeof menu.when !== 'function') {
          throw new Error('QQ browser context-menu implementation is unavailable');
        }
        return menu;
      }).catch((error) => {
        browserMenus.delete(requireModule);
        throw error;
      });
      browserMenus.set(requireModule, loading);
    }
    return browserMenus.get(requireModule);
  }

  function patchCandidate(candidate, requireModule) {
    if (typeof candidate !== 'function' || typeof requireModule !== 'function'
      || typeof requireModule.e !== 'function') return;
    const target = candidate.prototype;
    if (!target || patchedTargets.has(target)) return;

    const method = (name) => Object.getOwnPropertyDescriptor(target, name)?.value;
    // QQMiniAppProcessor also delegates Lua card clicks to MiniAppShare.
    if (!['execute', 'isMyTarget', 'openMiniAppUrl', 'isTencentDocMiniApp']
      .every((name) => typeof method(name) === 'function')) return;

    const descriptor = Object.getOwnPropertyDescriptor(target, 'execute');
    const execute = descriptor.value;
    const isTencentDocMiniApp = method('isTencentDocMiniApp');
    try {
      Object.defineProperty(target, 'execute', {
        ...descriptor,
        value: function executeWithBrowserFallback(...args) {
          // The packaged Linux QQ reports isOpenMiniAppSupported() === false.
          // Tencent Docs has a separate desktop route which must stay intact.
          const record = this.clickArkInfo?.msgRecord;
          if (!Array.isArray(record?.elements)
            || Reflect.apply(isTencentDocMiniApp, this, [])) {
            return Reflect.apply(execute, this, args);
          }

          // Capture the original message now: this service is reused and a
          // subsequent click can replace clickArkInfo while the chunks load.
          return loadBrowserMenu(requireModule).then((menu) => menu.handler(record));
        },
      });
      patchedTargets.add(target);
    } catch {
      // Leave an immutable QQ implementation intact.
    }
  }

  observeRendererModules({
    globalObject,
    onExports(exports, requireModule) {
      patchCandidate(exports, requireModule);
      if (!exports || !['object', 'function'].includes(typeof exports)) return;
      for (const key of Reflect.ownKeys(exports)) {
        if (key === 'prototype') continue;
        try {
          patchCandidate(Reflect.get(exports, key), requireModule);
        } catch {
          // A circular Webpack export may not have initialized yet.
        }
      }
    },
  });
  Object.defineProperty(globalObject, installed, { value: true });
  return true;
}

module.exports = { installMiniAppBrowser };
