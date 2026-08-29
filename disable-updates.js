'use strict';

const { contextBridge } = require('electron');

function installHotUpdateBlocker() {
  const chunkGlobalName = 'webpackChunkqq_chat';
  const installed = Symbol.for('qq-electron.hot-update-blocker');

  if (globalThis[installed]) return;

  Object.defineProperty(globalThis, installed, { value: true });

  const attachedQueues = new WeakSet();
  const wrappedFactories = new WeakMap();

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

  function wrapFactory(factory) {
    if (wrappedFactories.has(factory)) return wrappedFactories.get(factory);

    function wrappedFactory(...args) {
      const result = Reflect.apply(factory, this, args);
      patchExports(args[0]?.exports);
      return result;
    }

    wrappedFactories.set(factory, wrappedFactory);
    wrappedFactories.set(wrappedFactory, wrappedFactory);
    return wrappedFactory;
  }

  function patchChunk(chunk) {
    const factories = chunk?.[1];
    if (!factories || typeof factories !== 'object') return;

    for (const name of Reflect.ownKeys(factories)) {
      const descriptor = Object.getOwnPropertyDescriptor(factories, name);
      if (!descriptor || typeof descriptor.value !== 'function') continue;

      try {
        Object.defineProperty(factories, name, {
          ...descriptor,
          value: wrapFactory(descriptor.value),
        });
      } catch {
        // A non-configurable factory cannot be replaced safely.
      }
    }
  }

  function attachQueue(queue) {
    if (!Array.isArray(queue) || attachedQueues.has(queue)) return queue;

    for (const chunk of queue) patchChunk(chunk);

    function makePushHook(downstreamPush) {
      return function hookedPush(...chunks) {
        for (const chunk of chunks) patchChunk(chunk);
        return Reflect.apply(downstreamPush, this, chunks);
      };
    }

    if (typeof queue.push !== 'function') return queue;

    let hookedPush = makePushHook(queue.push);

    const pushDescriptor = Object.getOwnPropertyDescriptor(queue, 'push');

    try {
      Object.defineProperty(queue, 'push', {
        configurable: true,
        enumerable: pushDescriptor?.enumerable ?? false,
        get() {
          return hookedPush;
        },
        set(nextPush) {
          if (typeof nextPush === 'function' && nextPush !== hookedPush) {
            hookedPush = makePushHook(nextPush);
          }
        },
      });
      attachedQueues.add(queue);
    } catch {
      // Webpack queues are extensible arrays; leave an unusual queue untouched.
    }

    return queue;
  }

  let chunkQueue = attachQueue(globalThis[chunkGlobalName] || []);
  const globalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    chunkGlobalName,
  );

  if (!globalDescriptor || globalDescriptor.configurable) {
    Object.defineProperty(globalThis, chunkGlobalName, {
      configurable: true,
      enumerable: globalDescriptor?.enumerable ?? true,
      get() {
        return chunkQueue;
      },
      set(nextQueue) {
        chunkQueue = attachQueue(nextQueue);
      },
    });
  }
}

if (process.contextIsolated) {
  if (typeof contextBridge.executeInMainWorld !== 'function') {
    throw new Error('Electron does not support synchronous main-world injection');
  }
  contextBridge.executeInMainWorld({ func: installHotUpdateBlocker });
} else {
  installHotUpdateBlocker();
}
