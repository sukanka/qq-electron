'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { app, shell } = require('electron');
const { installPortalShell } = require('../portal-shell.js');

assert.equal(process.env.QQ_PORTAL_TEST_PRIVATE_BUS, '1');
app.setPath('userData', process.env.QQ_PORTAL_TEST_PROFILE);

app.whenReady().then(async () => {
  const original = shell.openExternal;
  assert.equal(installPortalShell(shell, () => require(process.env.QQ_PORTAL_TEST_ADDON)), true);
  assert.notEqual(shell.openExternal, original);

  const promise = shell.openExternal('https://success.test/electron-main');
  assert.ok(promise instanceof Promise);
  assert.equal(await promise, undefined);
  await assert.rejects(shell.openExternal('https://cancel.test/electron-main'), {
    code: 'ERR_PORTAL_CANCELLED',
  });

  const requests = fs.readFileSync(process.env.QQ_PORTAL_TEST_LOG, 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line))
    .filter((entry) => entry.event === 'open');
  assert.deepEqual(requests.map((entry) => entry.uri), [
    'https://success.test/electron-main',
    'https://cancel.test/electron-main',
  ]);
  console.log('Electron main process: real shell override, portal success and cancellation passed');
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
