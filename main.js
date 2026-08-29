'use strict';

require('./code-cache.js');

const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const originalLoad = Module._load;
const electron = originalLoad.call(Module, 'electron', module, false);
const appRoot = __dirname;
const packageInfo = require('./package.json');
const qqDataRoot = path.join(electron.app.getPath('appData'), 'QQ');
const versionsRoot = path.join(qqDataRoot, 'versions');
const preloadDispatcher = path.join(appRoot, 'preload.js');
const preloadArgument = '--linuxqq-system-preload=';
const sessionPreloadPrefix = 'session-preload-';

function loaderForPreload(preload) {
  const name = path.basename(preload, '.js');

  if (name === 'launcher') return 'internal_launcher';
  return /^preload[A-Za-z0-9_]*$/.test(name) ? `p_${name}` : null;
}

function pinPackagedVersion() {
  const version = packageInfo.version;
  const buildId = packageInfo.buildVersion ?? version?.split('-').at(-1);

  if (typeof version !== 'string' || !version || buildId == null) {
    throw new Error('Invalid packaged QQ version metadata');
  }

  fs.mkdirSync(versionsRoot, { recursive: true, mode: 0o700 });

  for (const entry of fs.readdirSync(versionsRoot, { withFileTypes: true })) {
    if (!entry.name.endsWith('.zip')) continue;

    const archive = path.join(versionsRoot, entry.name);
    if (entry.isDirectory()) {
      throw new Error(`Refusing QQ update directory named as zip: ${archive}`);
    }
    fs.unlinkSync(archive);
  }

  const config = {
    baseVersion: version,
    curVersion: version,
    prevVersion: '',
    onErrorVersions: [],
    buildId: String(buildId),
    unzipRetryCount: 0,
  };
  const configPath = path.join(versionsRoot, 'config.json');
  const temporaryPath = `${configPath}.${process.pid}.tmp`;

  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, configPath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        console.warn(
          `[qq-electron] failed to remove ${temporaryPath}: ${cleanupError.message}`,
        );
      }
    }
    throw error;
  }
}

function isQQApplicationPath(candidate) {
  const resolved = path.resolve(candidate);
  return resolved === appRoot
    || resolved.startsWith(`${appRoot}${path.sep}`)
    || resolved.includes(`${path.sep}application.asar${path.sep}`)
    || (versionsRoot && resolved.startsWith(`${versionsRoot}${path.sep}`));
}

function rewriteWebPreferences(webPreferences) {
  if (!webPreferences || typeof webPreferences !== 'object') return;

  // Session preloads apply even to windows which do not specify their own
  // preload. Upstream Electron's sandbox preload does not expose QQ's private
  // native bridge, so every QQ-created webContents must use a Node preload.
  webPreferences.sandbox = false;

  if (typeof webPreferences.preload !== 'string') return;

  const originalPreload = path.resolve(webPreferences.preload);
  const loader = loaderForPreload(originalPreload);

  if (!isQQApplicationPath(originalPreload) || !loader) return;

  const additionalArguments = Array.isArray(webPreferences.additionalArguments)
    ? webPreferences.additionalArguments.filter((argument) => (
      !argument.startsWith(preloadArgument)
    ))
    : [];

  additionalArguments.push(`${preloadArgument}${loader}`);
  webPreferences.additionalArguments = additionalArguments;
  webPreferences.preload = preloadDispatcher;
}

function rewriteSessionPreload(preload) {
  if (typeof preload !== 'string' || !isQQApplicationPath(preload)) {
    return preload;
  }

  const loader = loaderForPreload(preload);
  if (!loader || !loader.startsWith('p_preload')) return preload;
  return path.join(appRoot, `${sessionPreloadPrefix}${loader}.js`);
}

function rewriteConstructorOptions(options) {
  const rewritten = options && typeof options === 'object' ? { ...options } : {};
  rewritten.webPreferences = rewritten.webPreferences
    ? { ...rewritten.webPreferences }
    : {};
  rewriteWebPreferences(rewritten.webPreferences);
  return rewritten;
}

const constructorNames = new Set(['BrowserWindow', 'BrowserView', 'WebContentsView']);
const constructorProxies = new WeakMap();
const exportsProxies = new WeakMap();
const webContentsProxies = new WeakMap();
const sessionModuleProxies = new WeakMap();
const wrappedSessions = new WeakSet();

electron.app.enableSandbox = () => {
  console.warn(
    '[linuxqq-system-electron] ignored app.enableSandbox(); '
    + 'QQ preload compatibility requires per-window sandbox:false',
  );
};

function wrapConstructor(Constructor) {
  if (typeof Constructor !== 'function') return Constructor;
  if (constructorProxies.has(Constructor)) return constructorProxies.get(Constructor);

  let proxy;
  proxy = new Proxy(Constructor, {
    construct(target, argumentsList, newTarget) {
      const rewrittenArguments = [...argumentsList];
      rewrittenArguments[0] = rewriteConstructorOptions(rewrittenArguments[0]);
      return Reflect.construct(
        target,
        rewrittenArguments,
        newTarget === proxy ? target : newTarget,
      );
    },
  });
  constructorProxies.set(Constructor, proxy);
  return proxy;
}

function wrapWebContentsModule(webContents) {
  if (!webContents || typeof webContents !== 'object') return webContents;
  if (webContentsProxies.has(webContents)) return webContentsProxies.get(webContents);

  const proxy = new Proxy(webContents, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== 'create' || typeof value !== 'function') return value;

      return (options = {}) => {
        const rewrittenOptions = { ...options };
        rewriteWebPreferences(rewrittenOptions);
        return value.call(target, rewrittenOptions);
      };
    },
  });
  webContentsProxies.set(webContents, proxy);
  return proxy;
}

function wrapSession(session) {
  if (!session || typeof session !== 'object' || wrappedSessions.has(session)) {
    return session;
  }

  const originalPaths = new Map();
  const rememberPath = (originalPath, rewrittenPath) => {
    if (originalPath !== rewrittenPath) originalPaths.set(rewrittenPath, originalPath);
    return rewrittenPath;
  };
  const rewritePath = (preload) => rememberPath(
    preload,
    rewriteSessionPreload(preload),
  );
  const restorePath = (preload) => originalPaths.get(preload) || preload;
  const properties = {};

  if (typeof session.setPreloads === 'function') {
    const originalSetPreloads = session.setPreloads;
    properties.setPreloads = {
      configurable: true,
      enumerable: false,
      writable: true,
      value: (preloads) => originalSetPreloads.call(
        session,
        Array.isArray(preloads) ? preloads.map(rewritePath) : preloads,
      ),
    };
  }

  if (typeof session.getPreloads === 'function') {
    const originalGetPreloads = session.getPreloads;
    properties.getPreloads = {
      configurable: true,
      enumerable: false,
      writable: true,
      value: () => {
        const preloads = originalGetPreloads.call(session);
        return Array.isArray(preloads) ? preloads.map(restorePath) : preloads;
      },
    };
  }

  if (typeof session.registerPreloadScript === 'function') {
    const originalRegisterPreloadScript = session.registerPreloadScript;
    properties.registerPreloadScript = {
      configurable: true,
      enumerable: false,
      writable: true,
      value: (script) => {
        if (!script || typeof script !== 'object') {
          return originalRegisterPreloadScript.call(session, script);
        }
        return originalRegisterPreloadScript.call(session, {
          ...script,
          filePath: rewritePath(script.filePath),
        });
      },
    };
  }

  if (typeof session.getPreloadScripts === 'function') {
    const originalGetPreloadScripts = session.getPreloadScripts;
    properties.getPreloadScripts = {
      configurable: true,
      enumerable: false,
      writable: true,
      value: () => {
        const scripts = originalGetPreloadScripts.call(session);
        if (!Array.isArray(scripts)) return scripts;
        return scripts.map((script) => (
          script && typeof script === 'object'
            ? { ...script, filePath: restorePath(script.filePath) }
            : script
        ));
      },
    };
  }

  try {
    Object.defineProperties(session, properties);
  } catch (error) {
    throw new Error('Unable to install the Linux QQ session preload bridge', {
      cause: error,
    });
  }

  wrappedSessions.add(session);
  return session;
}

function wrapSessionModule(sessionModule) {
  if (!sessionModule || typeof sessionModule !== 'object') return sessionModule;
  if (sessionModuleProxies.has(sessionModule)) {
    return sessionModuleProxies.get(sessionModule);
  }

  const proxy = new Proxy(sessionModule, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'defaultSession') return wrapSession(value);
      if (property !== 'fromPartition' || typeof value !== 'function') return value;
      return (...args) => wrapSession(value.apply(target, args));
    },
  });
  sessionModuleProxies.set(sessionModule, proxy);
  return proxy;
}

function wrapElectronExports(exports) {
  if (!exports || (typeof exports !== 'object' && typeof exports !== 'function')) {
    return exports;
  }
  if (exportsProxies.has(exports)) return exportsProxies.get(exports);

  const proxy = new Proxy(exports, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'session') return wrapSessionModule(value);
      if (property === 'webContents') return wrapWebContentsModule(value);
      return constructorNames.has(property) ? wrapConstructor(value) : value;
    },
  });
  exportsProxies.set(exports, proxy);
  return proxy;
}

Module._load = function systemElectronLoad(request, parent, isMain) {
  const exports = originalLoad.call(this, request, parent, isMain);
  return request === 'electron' || request === 'electron/main'
    ? wrapElectronExports(exports)
    : exports;
};

electron.app.on('session-created', (session) => {
  wrapSession(session);
});

electron.app.on('web-contents-created', (_event, contents) => {
  const originalSetWindowOpenHandler = contents.setWindowOpenHandler.bind(contents);
  contents.setWindowOpenHandler = (handler) => originalSetWindowOpenHandler((details) => {
    const response = handler(details);

    if (!response || typeof response.overrideBrowserWindowOptions !== 'object') {
      return response;
    }

    return {
      ...response,
      overrideBrowserWindowOptions: rewriteConstructorOptions(
        response.overrideBrowserWindowOptions,
      ),
    };
  });

  contents.on('will-attach-webview', (_attachEvent, webPreferences) => {
    rewriteWebPreferences(webPreferences);
  });
});

pinPackagedVersion();
require('./app_launcher/index.js');
