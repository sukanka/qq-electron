'use strict';

const contextBridgePatched = Symbol.for(
  'qq-electron.context-bridge-patched',
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

function installContextBridgeCompatibility() {
  if (process.contextIsolated || globalThis[contextBridgePatched]) return;

  const { contextBridge } = require('electron');

  // In a shared renderer world these APIs can expose values directly. QQ's
  // encrypted preload still calls contextBridge even after checking that
  // context isolation is disabled.
  contextBridge.exposeInMainWorld = exposeInCurrentWorld;

  Object.defineProperty(globalThis, contextBridgePatched, { value: true });
}

module.exports = function loadRendererPreload(loader) {
  // QQ windows use a shared world so encrypted renderer chunks can fall back
  // to vm.Script.runInThisContext(). Adapt the original preload's bridge calls
  // to that same world before loading it.
  if (!process.contextIsolated) {
    installContextBridgeCompatibility();
  }

  require(`./application.asar/${loader.slice(2)}.js`);
  require('./disable-updates.js');
};
