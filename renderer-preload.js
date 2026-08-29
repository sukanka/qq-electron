'use strict';

module.exports = function loadRendererPreload(loader) {
  const preloadPath = require.resolve(
    `./application.asar/${loader.slice(2)}.js`,
  );
  let preloadModule;

  // Tencent's plaintext preload normally exposes this bridge through an
  // isolated world. QQ windows use a shared world here so encrypted renderer
  // chunks can fall back to vm.Script.runInThisContext().
  if (!process.contextIsolated && typeof globalThis.electron?.load !== 'function') {
    const major = require('./major.node');
    const electronBridge = Object.freeze({
      load(file) {
        if (!preloadModule) {
          throw new Error('QQ renderer preload has not finished loading');
        }
        return major.load(file, preloadModule);
      },
    });

    Object.defineProperty(globalThis, 'electron', {
      configurable: false,
      enumerable: true,
      value: electronBridge,
      writable: false,
    });
  }

  require(preloadPath);
  preloadModule = require.cache[preloadPath];

  if (!preloadModule) {
    throw new Error(`Unable to find loaded QQ preload module: ${preloadPath}`);
  }

  require('./disable-updates.js');
};
