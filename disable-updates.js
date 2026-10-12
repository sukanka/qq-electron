'use strict';

const { contextBridge } = require('electron');
const { observeRendererModules } = require('./renderer-modules.js');

function installHotUpdateBlocker(observeModules) {
  const installed = Symbol.for('qq-electron.hot-update-blocker');

  if (globalThis[installed]) return;

  Object.defineProperty(globalThis, installed, { value: true });

  async function disabledHotUpdateCheck() {
    return null;
  }

  function replaceMethod(target, name) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);

    if (!descriptor || typeof descriptor.value !== 'function') return false;

    try {
      Object.defineProperty(target, name, {
        ...descriptor,
        value: disabledHotUpdateCheck,
      });
      return true;
    } catch {
      return false;
    }
  }

  function patchCandidate(candidate) {
    if (
      candidate === null
      || (typeof candidate !== 'object' && typeof candidate !== 'function')
    ) {
      return;
    }

    const target = typeof candidate === 'function'
      ? candidate.prototype
      : candidate;

    if (!target || typeof target !== 'object') return;

    const init = Object.getOwnPropertyDescriptor(target, 'initAutoUpdate')?.value;
    const start = Object.getOwnPropertyDescriptor(target, 'startAutoUpdate')?.value;
    const fetch = Object.getOwnPropertyDescriptor(
      target,
      'fetchUpdateQQMCConfig',
    )?.value;

    if (typeof init === 'function' && typeof start === 'function') {
      replaceMethod(target, 'initAutoUpdate');
      replaceMethod(target, 'startAutoUpdate');
    }

    if (typeof fetch === 'function') {
      replaceMethod(target, 'fetchUpdateQQMCConfig');
    }
  }

  function patchExports(exports) {
    if (
      exports === null
      || (typeof exports !== 'object' && typeof exports !== 'function')
    ) {
      return;
    }

    patchCandidate(exports);
    for (const name of Reflect.ownKeys(exports)) {
      if (name === 'prototype') continue;
      try {
        patchCandidate(Reflect.get(exports, name));
      } catch {
        // Webpack export getters can throw while a circular module is loading.
      }
    }
  }

  observeModules({ onExports: patchExports });
}

if (process.contextIsolated) {
  if (typeof contextBridge.executeInMainWorld !== 'function') {
    throw new Error('Electron does not support synchronous main-world injection');
  }
  // executeInMainWorld serializes its function without the preload's closure.
  // Include both local implementations in the injected function's source.
  contextBridge.executeInMainWorld({
    func: new Function(`(${installHotUpdateBlocker})(${observeRendererModules});`),
  });
} else {
  installHotUpdateBlocker(observeRendererModules);
}
