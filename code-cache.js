'use strict';

const path = require('node:path');
const vm = require('node:vm');

const patched = Symbol.for('linuxqq.system-electron.vm-script-patched');

// A shared Electron binary normally points here at its own resources directory.
// QQ's launcher expects the application-specific directory instead.
if (Object.prototype.hasOwnProperty.call(process, 'resourcesPath')) {
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    enumerable: true,
    value: path.resolve(__dirname, '..'),
    writable: false,
  });
}

if (!vm.Script[patched]) {
  const OriginalScript = vm.Script;
  const localCachedDataTag = new OriginalScript('').createCachedData().readUInt32LE(4);
  let qqCachedDataTag;

  class CompatibleScript extends OriginalScript {
    constructor(code, options) {
      let compatibleOptions = options;
      let translatedCachedDataTag;

      if (options && typeof options === 'object' && options.cachedData) {
        const cachedData = Buffer.from(options.cachedData);

        if (cachedData.length >= 8) {
          const cachedDataTag = cachedData.readUInt32LE(4);

          // major.node loads QQ bytecode immediately after this hook is
          // installed. Remember its first foreign V8 tag and translate only
          // matching buffers for the rest of this process.
          if (
            cachedDataTag !== localCachedDataTag
            && (qqCachedDataTag === undefined || cachedDataTag === qqCachedDataTag)
          ) {
            qqCachedDataTag ??= cachedDataTag;
            translatedCachedDataTag = cachedDataTag;
            cachedData.writeUInt32LE(localCachedDataTag, 4);
            compatibleOptions = { ...options, cachedData };
          }
        }
      }

      super(code, compatibleOptions);

      if (translatedCachedDataTag !== undefined && this.cachedDataRejected) {
        throw new Error(
          `Electron rejected QQ cached V8 bytecode tag 0x${translatedCachedDataTag.toString(16)}`,
        );
      }
    }
  }

  Object.defineProperty(CompatibleScript, patched, { value: true });
  vm.Script = CompatibleScript;
}
