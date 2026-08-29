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

require('./major.node').load(loader, module);
