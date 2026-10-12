'use strict';

const installedShells = new WeakSet();

function installPortalShell(shell, loadPortal = () => require('./portal-open-uri.node')) {
  if (installedShells.has(shell)) return false;

  let portal;
  // QQ's native atfork callback can crash before Electron execs xdg-open.
  // Send the request over D-Bus in this process, including in Node preloads.
  // Linux ignores openExternal's macOS/Windows-specific options.
  shell.openExternal = async function openExternal(url) {
    if (typeof url !== 'string' || !/^[a-z][a-z0-9+.-]*:/i.test(url) || url.includes('\0')) {
      throw new TypeError('openExternal requires an absolute URI without NUL bytes');
    }

    portal ??= loadPortal();
    await portal.openURI(url);
  };

  installedShells.add(shell);
  return true;
}

module.exports = { installPortalShell };
