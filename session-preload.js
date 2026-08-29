'use strict';

require('./code-cache.js');

const path = require('node:path');

const prefix = 'session-preload-';

const file = path.basename(__filename, '.js');
const loader = file.startsWith(prefix) ? file.slice(prefix.length) : '';

if (!/^p_preload[A-Za-z0-9_]*$/.test(loader)) {
  throw new Error(`Unknown Linux QQ session preload bridge: ${loader || '<missing>'}`);
}

require('./major.node').load(loader, module);
