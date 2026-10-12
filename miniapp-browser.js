'use strict';

const { observeRendererModules } = require('./renderer-modules.js');

function webURL(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)
    || /[\u0000-\u001f\u007f]/.test(value)) return null;

  try {
    const url = new URL(value);
    return url.hostname ? value : null;
  } catch {
    return null;
  }
}

function cardBrowserURL(card) {
  // These are the fields used by QQ's "用浏览器打开" menu. detail_1 takes
  // precedence over miniapp, even when both are present in the same card.
  const detail = card?.meta?.detail_1 ?? card?.meta?.miniapp;
  if (!detail || typeof detail !== 'object') return null;
  return webURL(detail.qqdocurl) || webURL(detail.url) || webURL(detail.jumpUrl);
}

function getMiniAppBrowserURL(clickArkInfo) {
  const direct = cardBrowserURL(clickArkInfo);
  if (direct) return direct;

  // Some Ark routes keep only the message record on the click context.
  const elements = clickArkInfo?.msgRecord?.elements;
  if (!Array.isArray(elements)) return null;
  for (const element of elements) {
    const data = element?.arkElement?.bytesData;
    if (typeof data !== 'string') continue;
    try {
      const url = cardBrowserURL(JSON.parse(data));
      if (url) return url;
    } catch {
      // Malformed or unavailable card data should keep QQ's original action.
    }
  }
  return null;
}

function installMiniAppBrowser({ shell, globalObject = globalThis }) {
  const installed = Symbol.for('qq-electron.miniapp-browser');
  if (globalObject[installed]) return false;
  if (typeof shell?.openExternal !== 'function') {
    throw new TypeError('Mini-app browser fallback requires shell.openExternal');
  }

  const patchedTargets = new WeakSet();

  function patchCandidate(candidate) {
    if (typeof candidate !== 'function') return;
    const target = candidate.prototype;
    if (!target || patchedTargets.has(target)) return;

    const method = (name) => Object.getOwnPropertyDescriptor(target, name)?.value;
    // Identify MiniAppShare by its methods rather than QQ's changing chunk IDs.
    // QQMiniAppProcessor also delegates its Lua card clicks to this service.
    if (!['execute', 'isMyTarget', 'openMiniAppUrl', 'isTencentDocMiniApp']
      .every((name) => typeof method(name) === 'function')) return;

    const descriptor = Object.getOwnPropertyDescriptor(target, 'execute');
    const execute = descriptor.value;
    const isTencentDocMiniApp = method('isTencentDocMiniApp');
    try {
      Object.defineProperty(target, 'execute', {
        ...descriptor,
        value: function executeWithBrowserFallback(...args) {
          const url = getMiniAppBrowserURL(this.clickArkInfo);
          // Tencent Docs has its own supported desktop route. Other mini-app
          // cards cannot run on Linux; open their web content via the portal.
          if (url && !Reflect.apply(isTencentDocMiniApp, this, [])) {
            return shell.openExternal(url);
          }
          return Reflect.apply(execute, this, args);
        },
      });
      patchedTargets.add(target);
    } catch {
      // Leave an immutable QQ implementation intact.
    }
  }

  observeRendererModules({
    globalObject,
    onExports(exports) {
      patchCandidate(exports);
      if (!exports || !['object', 'function'].includes(typeof exports)) return;
      for (const key of Reflect.ownKeys(exports)) {
        if (key === 'prototype') continue;
        try {
          patchCandidate(Reflect.get(exports, key));
        } catch {
          // A circular Webpack export may not have initialized yet.
        }
      }
    },
  });
  Object.defineProperty(globalObject, installed, { value: true });
  return true;
}

module.exports = { getMiniAppBrowserURL, installMiniAppBrowser };
