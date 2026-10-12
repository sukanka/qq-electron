'use strict';

// Run through portal-integration.sh, never against the user's session bus.
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { pathToFileURL } = require('node:url');
const { Worker } = require('node:worker_threads');

assert.equal(process.env.QQ_PORTAL_TEST_PRIVATE_BUS, '1');
const { openURI } = require(process.env.QQ_PORTAL_TEST_ADDON);
assert.equal(typeof openURI, 'function');
const scenario = process.env.QQ_PORTAL_TEST_SCENARIO;
const readRequests = () => fs.readFileSync(process.env.QQ_PORTAL_TEST_LOG, 'utf8')
  .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

function startWorker(uri) {
  return new Worker(`
    const { workerData } = require('node:worker_threads');
    const { openURI } = require(workerData.addon);
    openURI(workerData.uri).catch(() => {});
  `, { eval: true, workerData: { addon: process.env.QQ_PORTAL_TEST_ADDON, uri } });
}

if (['unavailable', 'missing-bus', 'autolaunch', 'mixed-address'].includes(scenario)) {
  test(`${scenario} rejects without starting a helper`, async () => {
    await assert.rejects(openURI('https://success.test/'), { code: 'ERR_PORTAL_UNAVAILABLE' });
  });
} else {
  assert.equal(scenario, 'available');

  test('OpenURI waits for the portal response and resolves with undefined', async () => {
    let settled = false;
    const promise = openURI('https://success.test/path?value=a%20b&other=1');
    assert.ok(promise instanceof Promise);
    promise.then(() => { settled = true; }, () => { settled = true; });
    await delay(20);
    assert.equal(settled, false, 'a method reply is not the completion response');
    assert.equal(await promise, undefined);
    const request = readRequests().find((entry) => entry.event === 'open');
    assert.equal(request.uri, 'https://success.test/path?value=a%20b&other=1');
    assert.equal(request.method, 'OpenURI');
  });

  test('a Response sent before the method reply is not lost', async () => {
    assert.equal(await openURI('https://early-response.test/'), undefined);
  });

  test('user cancellation has a distinct rejection code', async () => {
    await assert.rejects(openURI('https://cancel.test/'), { code: 'ERR_PORTAL_CANCELLED' });
  });

  test('portal Response failure rejects', async () => {
    await assert.rejects(openURI('https://failed.test/'), { code: 'ERR_PORTAL_FAILED' });
  });

  test('a D-Bus method error rejects', async () => {
    await assert.rejects(openURI('https://method-error.test/'), { code: 'ERR_PORTAL_FAILED' });
  });

  test('concurrent requests keep their response codes and unique handles', async () => {
    const hosts = ['success', 'cancel', 'failed', 'early-response', 'success', 'cancel'];
    const results = await Promise.allSettled(hosts.map((host, i) => openURI(`https://${host}.test/concurrent/${i}`)));
    for (const [i, result] of results.entries()) {
      if (hosts[i] === 'success' || hosts[i] === 'early-response') {
        assert.equal(result.status, 'fulfilled');
        assert.equal(result.value, undefined);
      } else {
        assert.equal(result.status, 'rejected');
        assert.equal(result.reason.code, hosts[i] === 'cancel' ? 'ERR_PORTAL_CANCELLED' : 'ERR_PORTAL_FAILED');
      }
    }
    const requests = readRequests().filter((entry) => entry.event === 'open');
    assert.equal(new Set(requests.map((entry) => entry.token)).size, requests.length);
  });

  test('file URLs use OpenFile and pass a descriptor for the intended file', async () => {
    const uri = pathToFileURL(process.env.QQ_PORTAL_TEST_FILE).href;
    assert.equal(await openURI(uri), undefined);
    const request = readRequests().find((entry) => entry.method === 'OpenFile');
    assert.ok(request, 'local files must not be sent to OpenURI');
    const stat = fs.statSync(process.env.QQ_PORTAL_TEST_FILE);
    assert.equal(request.file_inode, stat.ino);
    assert.equal(request.file_device, stat.dev);
  });

  test('a missing response times out and closes the portal request', async () => {
    await assert.rejects(openURI('https://timeout.test/'), { code: 'ERR_PORTAL_TIMEOUT' });
    for (let i = 0; i < 20; ++i) {
      if (readRequests().some((entry) => entry.event === 'close' && entry.uri === 'https://timeout.test/')) return;
      await delay(10);
    }
    assert.fail('timeout did not close the outstanding portal request');
  });

  test('late responses after a timeout do not affect later requests', async () => {
    await assert.rejects(openURI('https://late-response.test/'), { code: 'ERR_PORTAL_TIMEOUT' });
    assert.equal(await openURI('https://success.test/after-timeout'), undefined);
    await delay(350);
    assert.equal(await openURI('https://success.test/after-late-response'), undefined);
  });

  test('terminating a Worker cleans up an unfinished native request', async () => {
    const workerURI = 'https://timeout.test/worker-termination';
    const worker = startWorker(workerURI);
    try {
      let observed = false;
      for (let i = 0; i < 100; ++i) {
        observed = readRequests().some((entry) => entry.event === 'open' && entry.uri === workerURI);
        if (observed) break;
        await delay(5);
      }
      assert.equal(observed, true, 'the Worker must have a pending portal request');
      await worker.terminate();
      assert.equal(await openURI('https://success.test/after-worker'), undefined);
    } finally {
      await worker.terminate();
    }
  });

  test('stalled bus authentication times out and allows Worker termination', { timeout: 5000 }, async () => {
    const socketPath = path.join(path.dirname(process.env.QQ_PORTAL_TEST_FILE), 'stalled-bus');
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      // Accept the socket but deliberately never reply to D-Bus authentication.
    });
    server.listen(socketPath);
    await once(server, 'listening');
    const originalAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
    let worker;
    try {
      process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${socketPath}`;
      await assert.rejects(openURI('https://success.test/stalled-bus'), { code: 'ERR_PORTAL_TIMEOUT' });
      const connection = once(server, 'connection');
      worker = startWorker('https://success.test/worker-stalled-bus');
      await connection;
      await worker.terminate();
    } finally {
      process.env.DBUS_SESSION_BUS_ADDRESS = originalAddress;
      if (worker) await worker.terminate();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
    assert.equal(await openURI('https://success.test/after-stalled-bus'), undefined);
  });
}

test('the atfork regression guard was loaded and never observed a fork', () => {
  const guardLog = fs.readFileSync(process.env.QQ_PORTAL_TEST_FORK_GUARD_LOG, 'utf8');
  assert.match(guardLog, /^loaded\n/);
  assert.doesNotMatch(guardLog, /forked/);
});
