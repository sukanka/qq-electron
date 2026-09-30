'use strict';

const channel = 'browser-window-proxy';
const compatibilityProxies = new WeakSet();

function installRendererWindowProxy({ ipcRenderer, globalObject = globalThis } = {}) {
  const existing = globalObject.proxyInvoke;
  if (typeof existing === 'function') return false;
  if (existing !== undefined) {
    throw new TypeError('QQ proxyInvoke already exists and is not a function');
  }

  ipcRenderer ??= require('electron').ipcRenderer;
  if (typeof ipcRenderer?.invoke !== 'function') {
    throw new TypeError('Window proxy requires ipcRenderer.invoke');
  }

  // Match QQ's preloadAux bridge. QQ owns the main-process handler and decides
  // which BrowserWindow methods it exposes through this channel.
  const proxyInvoke = (...args) => ipcRenderer.invoke(channel, ...args);
  Object.defineProperty(globalObject, 'proxyInvoke', {
    configurable: true,
    enumerable: true,
    writable: false,
    value: proxyInvoke,
  });
  compatibilityProxies.add(proxyInvoke);
  return true;
}

function isCompatibilityWindowProxy(value) {
  return typeof value === 'function' && compatibilityProxies.has(value);
}

module.exports = { installRendererWindowProxy, isCompatibilityWindowProxy };
