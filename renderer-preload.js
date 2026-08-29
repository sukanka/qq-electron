'use strict';

const sharedWorldPatched = Symbol.for(
  'qq-electron.shared-renderer-patched',
);

function exposeInCurrentWorld(key, api) {
  if (typeof key !== 'string' || !key) {
    throw new TypeError('contextBridge key must be a non-empty string');
  }
  if (Object.prototype.hasOwnProperty.call(globalThis, key)) {
    throw new Error(`Cannot bind an existing global: ${key}`);
  }

  Object.defineProperty(globalThis, key, {
    configurable: false,
    enumerable: true,
    value: api,
    writable: false,
  });
}

function installSharedWorldCompatibility() {
  if (process.contextIsolated || globalThis[sharedWorldPatched]) return;

  const { contextBridge } = require('electron');
  const processProperty = Object.getOwnPropertyDescriptor(globalThis, 'process');

  if (!processProperty) {
    throw new Error('Electron renderer process global is unavailable');
  }

  // In a shared renderer world these APIs can expose values directly. QQ's
  // encrypted preload still calls contextBridge even after checking that
  // context isolation is disabled.
  contextBridge.exposeInMainWorld = exposeInCurrentWorld;

  // Electron removes Node globals after non-isolated preloads finish. QQ's
  // bytecode loader and asynchronous preload callbacks still use process, so
  // restore only that captured property after Electron's earlier listener.
  if (globalThis.location?.protocol === 'app:') {
    process.once('loaded', () => {
      if (!Object.prototype.hasOwnProperty.call(globalThis, 'process')) {
        Object.defineProperty(globalThis, 'process', processProperty);
      }
    });
  }

  Object.defineProperty(globalThis, sharedWorldPatched, { value: true });
}

module.exports = function loadRendererPreload(loader) {
  // QQ windows use a shared world so encrypted renderer chunks can fall back
  // to vm.Script.runInThisContext(). Adapt the original preload's bridge calls
  // to that same world before loading it.
  if (!process.contextIsolated) {
    installSharedWorldCompatibility();
  }

  require(`./application.asar/${loader.slice(2)}.js`);
  require('./disable-updates.js');
};
