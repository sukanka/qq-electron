'use strict';

require('./code-cache.js');

const argumentPrefix = '--linuxqq-system-preload=';

const loaderArgument = process.argv.findLast((argument) => (
  argument.startsWith(argumentPrefix)
));
const loader = loaderArgument?.slice(argumentPrefix.length);
const isKnownLoader = loader === 'internal_launcher'
  || /^p_preload[A-Za-z0-9_]*$/.test(loader || '');

if (!isKnownLoader) {
  throw new Error(`Unknown Linux QQ preload bridge: ${loader || '<missing>'}`);
}

if (loader === 'internal_launcher') {
  require('./app_launcher/launcher.js');
} else {
  require('./renderer-preload.js')(loader);
}
