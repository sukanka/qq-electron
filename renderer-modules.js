'use strict';

// Keep this function self-contained so preload consumers can also inject it
// into an isolated renderer's main world.
function observeRendererModules({ globalObject = globalThis, onExports }) {
  if (typeof onExports !== 'function') {
    throw new TypeError('onExports must be a function');
  }

  const installed = Symbol.for('qq-electron.renderer-module-observers');
  const existing = globalObject[installed];
  if (existing) {
    const added = !existing.has(onExports);
    existing.add(onExports);
    return added;
  }

  const observers = new Set([onExports]);
  Object.defineProperty(globalObject, installed, { value: observers });

  const chunkGlobalName = 'webpackChunkqq_chat';
  const attachedQueues = new WeakSet();
  const wrappedFactories = new WeakMap();

  function wrapFactory(factory) {
    if (wrappedFactories.has(factory)) return wrappedFactories.get(factory);

    function wrappedFactory(...args) {
      const result = Reflect.apply(factory, this, args);
      for (const observer of observers) {
        try {
          observer(args[0]?.exports);
        } catch {
          // A compatibility hook must not prevent QQ modules from loading.
        }
      }
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

  let chunkQueue = attachQueue(globalObject[chunkGlobalName] || []);
  const globalDescriptor = Object.getOwnPropertyDescriptor(
    globalObject,
    chunkGlobalName,
  );

  if (!globalDescriptor || globalDescriptor.configurable) {
    Object.defineProperty(globalObject, chunkGlobalName, {
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

  return true;
}

module.exports = { observeRendererModules };
