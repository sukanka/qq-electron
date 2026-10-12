'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const { observeRendererModules } = require('../renderer-modules.js');

function makeChunk(value) {
  return [[1], {
    example(module) { module.exports = value; },
  }];
}

function executeChunk(chunk) {
  const module = { exports: {} };
  chunk[1].example(module);
  return module.exports;
}

test('observes preloaded chunks and chunks added after queue replacement', () => {
  const preloaded = makeChunk({ preloaded: true });
  const globalObject = { webpackChunkqq_chat: [preloaded] };
  const seen = [];
  observeRendererModules({ globalObject, onExports: (value) => seen.push(value) });
  executeChunk(preloaded);

  const replacement = makeChunk({ replacement: true });
  globalObject.webpackChunkqq_chat = [replacement];
  executeChunk(replacement);

  const added = makeChunk({ added: true });
  assert.equal(globalObject.webpackChunkqq_chat.push(added), 2);
  executeChunk(added);
  assert.deepEqual(seen, [
    { preloaded: true }, { replacement: true }, { added: true },
  ]);
});

test('shares one hook across observers and deduplicates the same callback', () => {
  const globalObject = {};
  const first = [];
  const second = [];
  const onExports = (value) => first.push(value);
  assert.equal(observeRendererModules({ globalObject, onExports }), true);
  const queue = globalObject.webpackChunkqq_chat;
  const push = queue.push;
  const chunk = makeChunk('export');
  queue.push(chunk);
  const wrapped = chunk[1].example;

  assert.equal(observeRendererModules({ globalObject, onExports }), false);
  observeRendererModules({ globalObject, onExports: (value) => second.push(value) });
  assert.equal(queue.push, push);
  queue.push(chunk);
  assert.equal(chunk[1].example, wrapped);
  executeChunk(chunk);
  assert.deepEqual(first, ['export']);
  assert.deepEqual(second, ['export']);
});

test('patches before a webpack push override executes factories and calls the original push', () => {
  const globalObject = {};
  const seen = [];
  observeRendererModules({ globalObject, onExports: (value) => seen.push(value) });
  const queue = globalObject.webpackChunkqq_chat;
  const parentPush = queue.push.bind(queue);
  queue.push = function webpackPush(chunk) {
    assert.equal(this, queue);
    executeChunk(chunk);
    return parentPush(chunk);
  };

  const chunk = makeChunk('runtime');
  assert.equal(queue.push(chunk), 1);
  assert.deepEqual(seen, ['runtime']);
  assert.equal(queue[0], chunk);
});

test('preserves factory receiver, arguments and return value while observing final exports', () => {
  const globalObject = {};
  const seen = [];
  observeRendererModules({ globalObject, onExports: (value) => seen.push(value) });
  const receiver = {};
  const module = { exports: {} };
  const initialExports = module.exports;
  const requireModule = () => {};
  const chunk = [[1], {
    example(actualModule, exports, require) {
      assert.equal(this, receiver);
      assert.equal(actualModule, module);
      assert.equal(exports, initialExports);
      assert.equal(require, requireModule);
      module.exports = 'replacement exports';
      return 123;
    },
  }];
  globalObject.webpackChunkqq_chat.push(chunk);
  assert.equal(chunk[1].example.call(receiver, module, initialExports, requireModule), 123);
  assert.deepEqual(seen, ['replacement exports']);
});

test('observer failure does not abort QQ or other observers; factory failures still propagate', () => {
  const globalObject = {};
  const seen = [];
  observeRendererModules({ globalObject, onExports() { throw new Error('hook'); } });
  observeRendererModules({ globalObject, onExports: (value) => seen.push(value) });
  const valid = makeChunk('loaded');
  globalObject.webpackChunkqq_chat.push(valid);
  assert.equal(executeChunk(valid), 'loaded');
  assert.deepEqual(seen, ['loaded']);

  const error = new Error('QQ module failed');
  const invalid = [[2], { example() { throw error; } }];
  globalObject.webpackChunkqq_chat.push(invalid);
  assert.throws(() => executeChunk(invalid), (actual) => actual === error);
  assert.deepEqual(seen, ['loaded']);
});

for (const contextIsolated of [false, true]) {
  test(`hot update blocker retains behavior with contextIsolated=${contextIsolated}`, async () => {
    const mainWorld = vm.createContext({});
    const source = readFileSync(require.resolve('../disable-updates.js'), 'utf8');
    const options = {
      process: { contextIsolated },
      require(name) {
        if (name === './renderer-modules.js') {
          return {
            observeRendererModules: vm.runInContext(`(${observeRendererModules})`, mainWorld),
          };
        }
        assert.equal(name, 'electron');
        return {
          contextBridge: {
            executeInMainWorld({ func }) {
              vm.runInContext(`(${func})()`, mainWorld);
            },
          },
        };
      },
    };
    const preloadWorld = contextIsolated ? vm.createContext(options) : mainWorld;
    if (!contextIsolated) Object.assign(mainWorld, options);
    // Run in a CommonJS-style scope so repeated preload execution is supported.
    vm.runInContext(`(function () { ${source}\n })()`, preloadWorld);
    const push = mainWorld.webpackChunkqq_chat.push;
    vm.runInContext(`(function () { ${source}\n })()`, preloadWorld);
    assert.equal(mainWorld.webpackChunkqq_chat.push, push);

    class Updater {
      initAutoUpdate() { assert.fail('update init ran'); }
      startAutoUpdate() { assert.fail('update start ran'); }
      unrelated() { return 'retained'; }
    }
    const config = { fetchUpdateQQMCConfig() { assert.fail('update fetch ran'); } };
    const exports = { Updater, config };
    Object.defineProperty(exports, 'circular', { get() { throw new Error('not ready'); } });
    const chunk = makeChunk(exports);
    mainWorld.webpackChunkqq_chat.push(chunk);
    executeChunk(chunk);
    const updater = new Updater();
    assert.equal(await updater.initAutoUpdate(), null);
    assert.equal(await updater.startAutoUpdate(), null);
    assert.equal(await config.fetchUpdateQQMCConfig(), null);
    assert.equal(updater.unrelated(), 'retained');
  });
}
