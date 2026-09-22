import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createBridge, EventJournal } from '../bridge-server.mjs';

async function fixture(t, { timeout = 300, versions = [1, 2] } = {}) {
  const bridge = createBridge({ requestTimeoutMs: timeout });
  const address = await bridge.listen(0);
  const url = `http://127.0.0.1:${address.port}`;
  t.after(() => bridge.close());
  const sockets = [];
  async function connect(windowId, protocolVersions = versions, generationId = `generation-${windowId}`) {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/eda`);
    const messages = [];
    ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'register', windowId, protocolVersions, generationId, capabilities: { typedRpc: protocolVersions.includes(2) } }));
    for (let i = 0; i < 100; i++) {
      if (bridge.clients.get(windowId)?.generationId === generationId) break;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.equal(bridge.clients.get(windowId)?.generationId, generationId);
    sockets.push(ws);
    return { ws, messages };
  }
  const post = async (endpoint, payload, headers = {}) => {
    const response = await fetch(url + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
  };
  return { bridge, url, connect, post, sockets };
}
const target = { windowId: 'w1', projectUuid: 'p1', documentUuid: 'd1', tabId: 't1' };
const rpc = (operation = 'events.getState', extra = {}) => ({ operation, target, arguments: {}, ...extra });
function reply(ws, request, result = { value: 42 }) {
  ws.send(JSON.stringify({ type: request.type === 'execute' ? 'result' : 'rpc-result', id: request.id, operation: request.operation, result, state: { generationId: 'generation-w1', changeEpochBefore: 1, changeEpochAfter: 1 } }));
}

test('Bridge identity and generation are independent across restarts', async t => {
  const a = await fixture(t), b = await fixture(t);
  const health = await (await fetch(a.url + '/health')).json();
  assert.equal(health.service, 'easyeda-bridge');
  assert.deepEqual(health.protocolVersions, [1, 2]);
  assert.equal(health.edaConnected, false);
  assert.notEqual(a.bridge.bridgeGenerationId, b.bridge.bridgeGenerationId);
});

test('legacy Gateway can execute through Bridge v2, but typed RPC is rejected', async t => {
  const f = await fixture(t, { versions: [1] });
  const { ws } = await f.connect('w1');
  ws.on('message', raw => { const msg = JSON.parse(raw); if (msg.type === 'execute') reply(ws, msg); });
  const result = await f.post('/execute', { windowId: 'w1', code: 'return 42;' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.result, { value: 42 });
  const typed = await f.post('/rpc', rpc());
  assert.equal(typed.body.error.code, 'CLIENT_UNSUPPORTED');
});

test('typed requests preserve exact target and versioned state', async t => {
  const f = await fixture(t);
  const { ws } = await f.connect('w1');
  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.type !== 'rpc-request') return;
    assert.deepEqual(msg.target, target);
    assert.equal(msg.expected.changeEpoch, 1);
    reply(ws, msg);
  });
  const result = await f.post('/rpc', rpc('events.getState', { expected: { generationId: 'generation-w1', changeEpoch: 1, bridgeGenerationId: f.bridge.bridgeGenerationId } }));
  assert.equal(result.status, 200);
  assert.equal(result.body.state.bridgeGenerationId, f.bridge.bridgeGenerationId);
  assert.equal(result.body.windowId, 'w1');
});

test('missing full target, unknown args and stale Bridge generation fail before forwarding', async t => {
  const f = await fixture(t);
  const { messages } = await f.connect('w1');
  assert.equal((await f.post('/rpc', rpc('pcb.nativeBoardInfo', { target: { windowId: 'w1' } }))).body.error.code, 'INVALID_REQUEST');
  assert.equal((await f.post('/rpc', { ...rpc(), unexpected: true })).body.error.code, 'INVALID_REQUEST');
  assert.equal((await f.post('/rpc', rpc('events.getState', { expected: { bridgeGenerationId: 'stale' } }))).body.error.code, 'GENERATION_MISMATCH');
  assert.equal(messages.filter(x => x.type === 'rpc-request').length, 0);
});

test('a response from a different window cannot satisfy a pending request', async t => {
  const f = await fixture(t, { timeout: 1000 });
  const a = await f.connect('w1'), b = await f.connect('w2');
  let spoofSent = false;
  a.ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.type !== 'rpc-request') return;
    spoofSent = true;
    reply(b.ws, msg, { forged: true });
    setTimeout(() => reply(a.ws, msg, { genuine: true }), 10);
  });
  const result = await f.post('/rpc', rpc());
  assert.equal(spoofSent, true);
  assert.deepEqual(result.body.result, { genuine: true });
});

test('wrong operation and wire type cannot complete a typed request', async t => {
  const f = await fixture(t, { timeout: 1000 });
  const { ws } = await f.connect('w1');
  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.type !== 'rpc-request') return;
    ws.send(JSON.stringify({ type: 'result', id: msg.id, result: 'wrong' }));
    ws.send(JSON.stringify({ type: 'rpc-result', id: msg.id, operation: 'different', result: 'wrong' }));
    setTimeout(() => reply(ws, msg, 'correct'), 10);
  });
  assert.equal((await f.post('/rpc', rpc())).body.result, 'correct');
});

test('disconnect rejects the request as unknown and does not replay it', async t => {
  const f = await fixture(t);
  const { ws, messages } = await f.connect('w1');
  ws.on('message', raw => { if (JSON.parse(raw).type === 'execute') ws.close(); });
  const result = await f.post('/execute', { windowId: 'w1', code: 'return 42;' });
  assert.equal(result.body.error.code, 'WINDOW_DISCONNECTED');
  assert.equal(result.body.error.details.outcome, 'unknown');
  assert.equal(messages.filter(x => x.type === 'execute').length, 1);
});

test('timeout reports unknown and pending request is removed', async t => {
  const f = await fixture(t, { timeout: 30 });
  const { messages } = await f.connect('w1');
  const result = await f.post('/execute', { windowId: 'w1', code: 'return 42;' });
  assert.equal(result.body.error.code, 'REQUEST_TIMEOUT');
  assert.equal(result.body.error.details.outcome, 'unknown');
  assert.equal(messages.filter(x => x.type === 'execute').length, 1);
  assert.equal((await (await fetch(f.url + '/health')).json()).pendingRequests, 0);
});

test('closing a replaced connection does not evict the new registered window', async t => {
  const f = await fixture(t);
  const old = await f.connect('w1', [1, 2], 'old');
  const fresh = await f.connect('w1', [1, 2], 'new');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(old.ws.readyState, WebSocket.CLOSED);
  assert.equal(f.bridge.clients.get('w1').generationId, 'new');
  fresh.ws.on('message', raw => { const msg = JSON.parse(raw); if (msg.type === 'execute') reply(fresh.ws, msg); });
  assert.equal((await f.post('/execute', { windowId: 'w1', code: 'return 42;' })).status, 200);
});

test('ambiguous legacy active-window fallback is not allowed with two windows', async t => {
  const f = await fixture(t);
  await f.connect('w1'); await f.connect('w2');
  assert.equal((await f.post('/execute', { code: 'return 42;' })).body.error.code, 'INVALID_REQUEST');
});

test('untrusted and opaque browser origins cannot submit code', async t => {
  const f = await fixture(t);
  for (const origin of ['https://example.com', 'null']) {
    const result = await f.post('/execute', { code: 'return 42;' }, { Origin: origin });
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, 'PERMISSION_DENIED');
  }
});

test('bounded event journal discloses cursor loss and rejects future cursors', () => {
  const journal = new EventJournal(2);
  for (let sequence = 1; sequence <= 4; sequence++) journal.append({ sequence, documentUuid: 'd1' });
  assert.equal(journal.since(0).eventsTruncated, true);
  assert.deepEqual(journal.since(0).items.map(x => x.sequence), [3, 4]);
  assert.equal(journal.since(2).eventsTruncated, false);
  assert.throws(() => journal.since(5), /cursor/);
  assert.equal(journal.append({ sequence: 3 }), false);
});
