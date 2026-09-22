import contract from './contract.json' with { type: 'json' };
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

export const VERSION = '2.0.0';
const MAX_BODY = contract.limits.requestBodyBytes;
const MAX_RESPONSE = contract.limits.webSocketResponseBytes;
const KNOWN_OPERATIONS = new Set(Object.keys(contract.operations));
const ORIGINS = new Set(['https://pro.lceda.cn', 'https://pro.easyeda.com']);

export class BridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value, allowed, label) {
  if (!record(value)) throw new BridgeError('INVALID_REQUEST', `${label} must be an object`);
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) throw new BridgeError('INVALID_REQUEST', `${label} contains unknown fields`, { fields: extra });
}
function string(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new BridgeError('INVALID_REQUEST', `${label} must be a nonempty bounded string`);
  return value;
}
function allowedOrigin(value) {
  if (!value) return true;
  if (value === 'null') return false;
  try { const url = new URL(value); return ORIGINS.has(url.origin) || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname); }
  catch { return false; }
}
async function readJson(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY) throw new BridgeError('FILE_TOO_LARGE', 'Request body exceeds byte limit');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new BridgeError('INVALID_REQUEST', 'Expected a UTF-8 JSON body'); }
}

/** Bounded event journal. Cursor loss is explicit, never reported as an empty history. */
export class EventJournal {
  constructor(limit = 512) { this.limit = limit; this.items = []; this.last = 0; this.droppedThrough = 0; }
  append(event) {
    if (!record(event) || !Number.isSafeInteger(event.sequence) || event.sequence <= this.last) return false;
    this.last = event.sequence;
    this.items.push(event);
    while (this.items.length > this.limit) this.droppedThrough = this.items.shift().sequence;
    return true;
  }
  since(sequence = 0, documentUuid) {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > this.last) throw new BridgeError('INVALID_REQUEST', 'Invalid event cursor');
    return { items: this.items.filter(e => e.sequence > sequence && (!documentUuid || e.documentUuid === documentUuid)), lastSequence: this.last, eventsTruncated: sequence < this.droppedThrough, oldestAvailableSequence: this.items[0]?.sequence ?? null };
  }
}

export function createBridge({ requestTimeoutMs = 65000, journalLimit = 512 } = {}) {
  const bridgeGenerationId = randomUUID();
  const clients = new Map();
  const pending = new Map();
  let activeWindowId = null;
  let stopping = false;
  const sendJson = (res, status, value) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  function rejectPending(windowId, ws, error) {
    for (const [id, request] of pending) {
      if (request.windowId !== windowId || request.ws !== ws) continue;
      clearTimeout(request.timer); pending.delete(id); request.reject(error);
    }
  }
  function forward(windowId, message) {
    const client = clients.get(windowId);
    if (!client || client.ws.readyState !== 1) throw new BridgeError('WINDOW_DISCONNECTED', 'Explicit EDA window is not connected', { windowId });
    if (message.type === 'rpc-request' && !client.protocolVersions.includes(2)) throw new BridgeError('CLIENT_UNSUPPORTED', 'This Gateway supports Protocol v1 only');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new BridgeError('REQUEST_TIMEOUT', 'EDA request timed out; read actual state before any retry', { requestId: id, outcome: 'unknown', windowId }));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer, windowId, ws: client.ws, operation: message.operation, type: message.type });
      try { client.ws.send(JSON.stringify({ ...message, id, timestamp: Date.now() })); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  async function dispatch(payload, typed) {
    if (!typed) {
      keys(payload, ['code', 'windowId'], 'execute');
      if (typeof payload.code !== 'string' || !payload.code.trim()) throw new BridgeError('INVALID_REQUEST', 'code must be a nonempty string');
      const windowId = payload.windowId ?? (clients.size === 1 ? activeWindowId : null);
      if (!windowId) throw new BridgeError('INVALID_REQUEST', 'windowId is required when multiple windows are connected');
      const response = await forward(windowId, { type: 'execute', code: payload.code, windowId });
      return { success: true, result: response.result, windowId, bridgeGenerationId };
    }
    keys(payload, ['requestId', 'operation', 'target', 'expected', 'arguments'], 'rpc');
    string(payload.operation, 'operation');
    keys(payload.target, ['windowId', 'projectUuid', 'documentUuid', 'tabId'], 'target');
    string(payload.target.windowId, 'target.windowId');
    const windowOnly = ['system.capabilities', 'target.inspect'].includes(payload.operation);
    for (const field of ['projectUuid', 'documentUuid', 'tabId']) {
      if (!windowOnly || payload.target[field] !== undefined) string(payload.target[field], `target.${field}`);
    }
    if (payload.expected !== undefined) {
      keys(payload.expected, ['generationId', 'changeEpoch', 'sourceHash', 'bridgeGenerationId'], 'expected');
      if (payload.expected.bridgeGenerationId !== undefined && payload.expected.bridgeGenerationId !== bridgeGenerationId) throw new BridgeError('GENERATION_MISMATCH', 'Bridge restarted; discard the old plan');
      for (const key of ['generationId', 'sourceHash']) if (payload.expected[key] !== undefined) string(payload.expected[key], `expected.${key}`);
      if (payload.expected.changeEpoch !== undefined && (!Number.isSafeInteger(payload.expected.changeEpoch) || payload.expected.changeEpoch < 0)) throw new BridgeError('INVALID_REQUEST', 'changeEpoch must be a nonnegative integer');
    }
    if (!record(payload.arguments ?? {})) throw new BridgeError('INVALID_REQUEST', 'arguments must be an object');
    if (!KNOWN_OPERATIONS.has(payload.operation)) throw new BridgeError('CLIENT_UNSUPPORTED', 'Unknown typed operation');
    const expected = { ...(payload.expected ?? {}) }; delete expected.bridgeGenerationId;
    const response = await forward(payload.target.windowId, { type: 'rpc-request', operation: payload.operation, target: payload.target, expected, arguments: payload.arguments ?? {} });
    return { success: true, result: response.result, replayed: Boolean(response.replayed), state: { ...response.state, bridgeGenerationId }, operation: response.operation, windowId: payload.target.windowId, bridgeGenerationId };
  }
  const server = createServer(async (req, res) => {
    try {
      if (!allowedOrigin(req.headers.origin)) throw new BridgeError('PERMISSION_DENIED', 'Origin is not allowed');
      if (req.headers.origin && req.headers.origin !== 'null') res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { service: 'easyeda-bridge', status: 'ok', bridgeVersion: VERSION, protocolVersions: [1, 2], bridgeGenerationId, edaConnected: clients.size > 0, edaWindowCount: clients.size, activeWindowId, pendingRequests: pending.size, activeStreams: 0 }); return;
      }
      if (req.method === 'GET' && ['/eda-windows', '/capabilities'].includes(url.pathname)) {
        const windows = [...clients].map(([windowId, c]) => ({ windowId, connected: c.ws.readyState === 1, active: windowId === activeWindowId, protocolVersions: c.protocolVersions, gatewayVersion: c.gatewayVersion, generationId: c.generationId, capabilities: c.capabilities }));
        sendJson(res, 200, { windows, count: windows.length, activeWindowId, bridgeGenerationId }); return;
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        const id = string(url.searchParams.get('windowId'), 'windowId');
        const client = clients.get(id);
        if (!client) throw new BridgeError('WINDOW_DISCONNECTED', 'Explicit EDA window is disconnected');
        const generation = url.searchParams.get('generationId');
        if (generation && generation !== client.generationId) throw new BridgeError('GENERATION_MISMATCH', 'Event generation changed');
        sendJson(res, 200, { ...client.journal.since(Number(url.searchParams.get('afterSequence') ?? 0), url.searchParams.get('documentUuid')), windowId: id, generationId: client.generationId, bridgeGenerationId }); return;
      }
      if (req.method === 'POST' && url.pathname === '/eda-windows/select') {
        const payload = await readJson(req); keys(payload, ['windowId'], 'selection');
        if (!clients.has(payload.windowId)) throw new BridgeError('WINDOW_DISCONNECTED', 'Window not connected');
        activeWindowId = payload.windowId; sendJson(res, 200, { success: true, activeWindowId }); return;
      }
      if (req.method === 'POST' && ['/execute', '/rpc'].includes(url.pathname)) {
        sendJson(res, 200, await dispatch(await readJson(req), url.pathname === '/rpc')); return;
      }
      sendJson(res, 404, { success: false, error: { code: 'CLIENT_UNSUPPORTED', message: 'Endpoint is not supported' } });
    } catch (error) {
      const code = error.code ?? 'INTERNAL_ERROR';
      const status = code === 'PERMISSION_DENIED' ? 403 : code === 'INVALID_REQUEST' ? 400 : code === 'WINDOW_DISCONNECTED' ? 503 : code === 'REQUEST_TIMEOUT' ? 504 : 409;
      sendJson(res, status, { success: false, error: { code, message: error.message, details: error.details ?? {}, retryable: false }, bridgeGenerationId });
    }
  });
  const wss = new WebSocketServer({ server, maxPayload: MAX_RESPONSE, verifyClient: info => allowedOrigin(info.origin) });
  wss.on('connection', (ws, req) => {
    const eda = req.url === '/eda';
    if (!eda && !['/agent', '/'].includes(req.url)) { ws.close(1008, 'Unknown endpoint'); return; }
    ws.send(JSON.stringify({ type: 'handshake', service: 'easyeda-bridge', clientType: eda ? 'eda' : 'agent', bridgeVersion: VERSION, protocolVersions: [1, 2], bridgeGenerationId, timestamp: Date.now() }));
    let registeredId = null;
    ws.on('error', () => { /* Close callback and request timeout carry bounded failures. */ });
    ws.on('message', async raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (!record(message)) throw new BridgeError('INVALID_REQUEST', 'Message must be an object');
        if (message.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', id: message.id, timestamp: Date.now() })); return; }
        if (eda && message.type === 'register') {
          const windowId = string(message.windowId, 'windowId');
          if (registeredId && registeredId !== windowId) throw new BridgeError('INVALID_REQUEST', 'Socket cannot change registered window');
          const old = clients.get(windowId);
          if (old && old.ws !== ws) {
            rejectPending(windowId, old.ws, new BridgeError('GENERATION_MISMATCH', 'Window connection was replaced; outcome unknown', { outcome: 'unknown' }));
            old.ws.close(1012, 'Replaced connection');
          }
          registeredId = windowId;
          clients.set(windowId, { ws, protocolVersions: Array.isArray(message.protocolVersions) ? message.protocolVersions.filter(v => v === 1 || v === 2) : [1], gatewayVersion: message.gatewayVersion ?? null, generationId: message.generationId ?? randomUUID(), capabilities: message.capabilities ?? {}, journal: new EventJournal(journalLimit) });
          if (!activeWindowId) activeWindowId = windowId;
          return;
        }
        if (eda && message.type === 'event') {
          const client = clients.get(registeredId);
          if (client?.ws !== ws || message.windowId !== registeredId) return;
          if (message.generationId && message.generationId !== client.generationId) { client.generationId = message.generationId; client.journal = new EventJournal(journalLimit); }
          client.journal.append(message); return;
        }
        if (eda && ['result', 'error', 'rpc-result', 'rpc-error'].includes(message.type)) {
          const request = pending.get(message.id);
          if (!request || request.ws !== ws || request.windowId !== registeredId) return;
          if (request.type === 'rpc-request' && message.operation !== request.operation) return;
          if (request.type === 'rpc-request' && !message.type.startsWith('rpc-')) return;
          if (request.type === 'execute' && message.type.startsWith('rpc-')) return;
          clearTimeout(request.timer); pending.delete(message.id);
          if (message.type.endsWith('error')) request.reject(new BridgeError(message.error?.code ?? 'METHOD_FAILED', message.error?.message ?? String(message.error ?? 'EDA error'), message.error?.details));
          else request.resolve(message);
          return;
        }
        if (!eda && message.type === 'execute') {
          try { const result = await dispatch({ code: message.code, windowId: message.windowId }, false); ws.send(JSON.stringify({ type: 'result', id: message.id, result: result.result })); }
          catch (error) { ws.send(JSON.stringify({ type: 'error', id: message.id, error: error.message })); }
        }
      } catch (error) {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'protocol-error', error: { code: error.code ?? 'INVALID_REQUEST', message: error.message } }));
      }
    });
    ws.on('close', () => {
      if (!registeredId) return;
      rejectPending(registeredId, ws, new BridgeError('WINDOW_DISCONNECTED', 'EDA disconnected; outcome unknown', { outcome: 'unknown' }));
      if (clients.get(registeredId)?.ws === ws) clients.delete(registeredId);
      if (activeWindowId === registeredId && !clients.has(registeredId)) activeWindowId = clients.keys().next().value ?? null;
    });
  });
  return {
    server, clients, bridgeGenerationId,
    async listen(port = 49620) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); }); return server.address(); },
    async close() {
      if (stopping) return; stopping = true;
      for (const [windowId, client] of clients) rejectPending(windowId, client.ws, new BridgeError('WINDOW_DISCONNECTED', 'Bridge stopped; read state before retry', { outcome: 'unknown' }));
      for (const ws of wss.clients) ws.terminate();
      await new Promise(resolve => wss.close(resolve));
      if (server.listening) await new Promise(resolve => server.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.EASYEDA_BRIDGE_PORT ?? 49620);
  if (!Number.isInteger(port) || port < 49620 || port > 49629) throw new Error('EASYEDA_BRIDGE_PORT must be 49620..49629');
  const bridge = createBridge();
  const address = await bridge.listen(port);
  console.log(JSON.stringify({ service: 'easyeda-bridge', bridgeVersion: VERSION, address, bridgeGenerationId: bridge.bridgeGenerationId }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { bridge.close().then(() => process.exit(0)); });
}
