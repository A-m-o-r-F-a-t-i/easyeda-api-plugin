import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyeda-gateway-test-'));
const bundle = path.join(directory, 'runtime.mjs');
await build({ entryPoints: [fileURLToPath(new URL('./runtime-entry.ts', import.meta.url))], outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const api = await import(pathToFileURL(bundle));
after(() => fs.rm(directory, { recursive: true, force: true }));
const target = { windowId: 'w1', projectUuid: 'p1', documentUuid: 'd1', tabId: 't1' };
let mock;
function resetMock() {
	const listeners = new Map();
	const lines = new Map();
	const state = { target: { ...target }, documentType: 3, sourceExtra: 0, createCount: 0, saveCount: 0, failAfterCreate: false, nativeText: 'PCB fixture', listeners, lines };
	state.emit = (kind = 'created', items = []) => {
		const listener = [...listeners].find(([key]) => key.includes('primitive'));
		listener?.[1](kind, items);
	};
	state.source = () => JSON.stringify({ lines: [...lines.values()], sourceExtra: state.sourceExtra });
	globalThis.eda = {
		dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: state.target.projectUuid }) },
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: state.target.documentUuid, tabId: state.target.tabId, documentType: state.documentType }) },
		sys_Environment: { getEditorCurrentVersion: () => '3.2.186' },
		sys_FileManager: { getDocumentSource: async () => state.source() },
		pcb_ManufactureData: { getPcbInfoFile: async () => new File([state.nativeText], 'info.txt', { type: 'text/plain' }), getDsnFile: async () => new File(['(PCB fixture)'], 'fixture.dsn') },
		pcb_Event: {
			isEventListenerAlreadyExist: id => listeners.has(id),
			removeEventListener: id => listeners.delete(id),
			addPrimitiveEventListener: (id, type, fn) => listeners.set(id, fn),
			addNetEventListener: (id, type, fn) => listeners.set(id, fn),
		},
		pcb_PrimitiveLine: {
			getAll: async (net, layer) => [...lines.values()].filter(line => (net === undefined || line.net === net) && (layer === undefined || line.layer === layer)),
			get: async id => lines.get(id),
			create: async (net, layer, startX, startY, endX, endY, lineWidth, primitiveLock) => {
				const id = `line-${++state.createCount}`;
				const line = { primitiveId: id, net, layer, startX, startY, endX, endY, lineWidth, primitiveLock };
				lines.set(id, line);
				state.emit('created', [line]);
				if (state.failAfterCreate)
					throw new Error('Simulated connection loss after native mutation');
				return line;
			},
			modify: async (id, values) => {
				Object.assign(lines.get(id), values);
				state.emit('modified', [lines.get(id)]);
				return lines.get(id);
			},
			delete: async (id) => {
				const previous = lines.get(id);
				lines.delete(id);
				state.emit('deleted', [previous]);
				return true;
			},
		},
		pcb_PrimitiveComponent: { getAll: async () => [] },
		pcb_PrimitiveVia: { getAll: async () => [] },
		pcb_PrimitivePad: { getAll: async () => [] },
		pcb_Document: { save: async () => {
			state.saveCount++;
			return true;
		} },
		pcb_Drc: { check: async () => [] },
	};
	api.unregisterPcbEventListeners();
	api.setConnectionWindow('w1');
	api.registerPcbEventListeners();
	return state;
}
beforeEach(() => {
	mock = resetMock();
});
const hash = () => createHash('sha256').update(mock.source()).digest('hex');
const expected = () => ({ generationId: api.getGenerationId(), changeEpoch: api.getDocumentState('d1').changeEpoch, sourceHash: hash() });
const request = (operation, arguments_ = {}, extra = {}) => ({ type: 'rpc-request', timestamp: Date.now(), id: 'request-1', operation, target: { ...target }, arguments: arguments_, ...extra });
const plan = () => ({ schema: 'easyeda-pcb-plan/v2', intent: 'isolated unit test', target: { windowId: 'w1', projectUuid: 'p1', documentUuid: 'd1' }, units: 'mil', phase: 'route', constraints: { minTrackWidth: 4, minViaHole: 8, minAnnularRing: 3, allowedLayers: ['TOP', 'BOTTOM'] }, operations: [{ id: 'line-1', type: 'line.create', net: 'N1', layer: 'TOP', start: [10, 10], end: [50, 10], width: 8 }] });
const writeRequest = (extra = {}) => request('pcb.applyGeometryBatch', { plan: plan(), executionId: 'execution-1', operationOffset: 0, maxOperations: 1 }, { expected: expected(), ...extra });
test('capability report separates method existence from runtime verification', async () => {
	const response = await api.executeTypedRequest(request('system.capabilities'));
	assert.equal(response.result.capabilities.eventCoverage, 'partial');
	assert.equal(response.result.capabilities.binaryChunkTransfer, false);
	assert.match(response.result.capabilities.capabilityEvidence, /method-presence/);
});
test('native text envelope preserves bytes, BOM and SHA-256', async () => {
	mock.nativeText = '\uFEFF元件: 107';
	const response = await api.executeTypedRequest(request('pcb.nativeBoardInfo'));
	assert.equal(response.result.text, mock.nativeText);
	assert.equal(response.result.byteLength, Buffer.byteLength(mock.nativeText));
	assert.equal(response.result.sha256, createHash('sha256').update(mock.nativeText).digest('hex'));
});
test('full target is enforced, including tab and document type', async () => {
	for (const field of ['projectUuid', 'documentUuid', 'tabId', 'windowId']) {
		await assert.rejects(api.executeTypedRequest(request('events.getState', {}, { target: { ...target, [field]: 'wrong' } })), error => error.code === 'TARGET_CHANGED');
	}
	mock.documentType = 1;
	await assert.rejects(api.executeTypedRequest(request('events.getState')), error => error.code === 'TARGET_CHANGED');
});
test('generation mismatch rejects plans even when numeric epoch is unchanged', async () => {
	const write = writeRequest();
	api.setConnectionWindow('w1');
	assert.equal(api.getDocumentState('d1').changeEpoch, 0);
	await assert.rejects(api.executeTypedRequest(write), error => error.code === 'GENERATION_MISMATCH');
	assert.equal(mock.createCount, 0);
});
test('a missed event is still detected by the source-hash guard', async () => {
	const write = writeRequest();
	mock.sourceExtra++;
	await assert.rejects(api.executeTypedRequest(write), error => error.code === 'EPOCH_MISMATCH');
	assert.equal(mock.createCount, 0);
});
test('primitive events synchronously invalidate every document in the same window', () => {
	mock.emit('modified', [{ primitiveId: 'external-line', net: 'OTHER' }]);
	assert.equal(api.getDocumentState('d1').changeEpoch, 1);
	assert.equal(api.getDocumentState('d2').changeEpoch, 1);
	assert.equal(api.getEventsSince(0).events[0].documentUuid, null);
});
test('Gateway event journal is bounded and reports lost history', () => {
	for (let i = 0; i < 520; i++)
		mock.emit('modified', [{ primitiveId: `p${i}` }]);
	const events = api.getEventsSince(0);
	assert.equal(events.events.length, 512);
	assert.equal(events.eventsTruncated, true);
	assert.equal(events.oldestAvailableSequence, 9);
});
test('valid geometry write keeps independent readback and advances source state', async () => {
	const write = writeRequest();
	const response = await api.executeTypedRequest(write);
	assert.equal(response.result.ok, true);
	assert.equal(response.result.results[0].verified, true);
	assert.equal(mock.createCount, 1);
	assert.equal(response.result.sourceAfter.sha256, hash());
	assert.notEqual(response.result.sourceAfter.sha256, write.expected.sourceHash);
});
test('same executionId and content return the prior result without a second mutation', async () => {
	const write = writeRequest();
	await api.executeTypedRequest(write);
	const repeated = await api.executeTypedRequest({ ...write, id: 'request-2' });
	assert.equal(mock.createCount, 1);
	assert.equal(repeated.id, 'request-2');
	assert.equal(repeated.replayed, true);
});
test('executionId cannot be reused for different plan contents', async () => {
	const write = writeRequest();
	await api.executeTypedRequest(write);
	const altered = structuredClone(write);
	altered.arguments.plan.intent = 'different';
	await assert.rejects(api.executeTypedRequest(altered), error => error.code === 'INVALID_REQUEST');
	assert.equal(mock.createCount, 1);
});
test('failure after native mutation is retained and never blindly replayed', async () => {
	mock.failAfterCreate = true;
	const write = writeRequest();
	for (let attempt = 0; attempt < 2; attempt++)
		await assert.rejects(api.executeTypedRequest({ ...write, id: `request-${attempt}` }), error => error.code === 'PARTIAL_SUCCESS');
	assert.equal(mock.createCount, 1);
	assert.equal(mock.lines.size, 1);
});
test('writes require explicit guards and a bounded execution identity', async () => {
	const write = writeRequest();
	delete write.expected.sourceHash;
	await assert.rejects(api.executeTypedRequest(write), error => error.code === 'INVALID_REQUEST');
	const missingId = writeRequest();
	delete missingId.arguments.executionId;
	await assert.rejects(api.executeTypedRequest(missingId), error => error.code === 'INVALID_REQUEST');
	assert.equal(mock.createCount, 0);
});
test('save is guarded and idempotently correlated within its generation', async () => {
	const save = request('pcb.save', { executionId: 'save-1' }, { expected: expected() });
	const response = await api.executeTypedRequest(save);
	assert.equal(response.result.saved, true);
	await api.executeTypedRequest({ ...save, id: 'save-request-2' });
	assert.equal(mock.saveCount, 1);
});
test('save returns a source guard only after asynchronous native serialization settles', async () => {
	let postSaveReads = 0;
	const initial = mock.source();
	globalThis.eda.sys_FileManager.getDocumentSource = async () => {
		if (!mock.saveCount)
			return initial;
		postSaveReads += 1;
		return postSaveReads === 1 ? JSON.stringify({ phase: 'transient' }) : JSON.stringify({ phase: 'final' });
	};
	const save = request('pcb.save', { executionId: 'save-settles' }, { expected: expected() });
	const response = await api.executeTypedRequest(save);
	const finalSource = JSON.stringify({ phase: 'final' });
	assert.equal(response.result.sourceAfter.sha256, createHash('sha256').update(finalSource).digest('hex'));
	assert.equal(response.result.sourceAfter.stabilityReads, 3);
	assert.equal(postSaveReads, 3);
});
test('read operations reject a source change during their execution', async () => {
	globalThis.eda.pcb_ManufactureData.getPcbInfoFile = async () => {
		mock.sourceExtra++;
		return new File(['info'], 'info.txt');
	};
	await assert.rejects(api.executeTypedRequest(request('pcb.nativeBoardInfo')), error => error.code === 'CONCURRENT_CHANGE');
});
test('the editor queue is serial, including rejection paths', async () => {
	const order = [];
	const first = api.serializeEditorOperation(async () => {
		order.push('first:start');
		await new Promise(resolve => setTimeout(resolve, 5));
		order.push('first:end');
		throw new Error('expected');
	});
	const second = api.serializeEditorOperation(async () => {
		order.push('second');
		return true;
	});
	await assert.rejects(first, /expected/);
	assert.equal(await second, true);
	assert.deepEqual(order, ['first:start', 'first:end', 'second']);
});
test('a full execution ledger refuses new writes instead of evicting uncertain history', async () => {
	const ledger = new api.ExecutionLedger(1);
	await ledger.run('one', 'hash', async () => 1);
	assert.throws(() => ledger.run('two', 'hash', async () => 2), error => error.code === 'CLIENT_UNSUPPORTED');
	assert.equal(await ledger.run('one', 'hash', async () => 3), 1);
});

test('observed foreign edits stop the remaining native batch operations', async () => {
	const create = globalThis.eda.pcb_PrimitiveLine.create;
	globalThis.eda.pcb_PrimitiveLine.create = async (...args) => {
		const created = await create(...args);
		mock.emit('modified', [{ primitiveId: 'user-owned-line', net: 'OTHER_NET' }]);
		return created;
	};
	const write = writeRequest();
	write.arguments.plan.operations.push({ id: 'second-line', type: 'line.create', net: 'N1', layer: 'TOP', start: [100, 10], end: [150, 10], width: 8 });
	write.arguments.maxOperations = 2;
	await assert.rejects(api.executeTypedRequest(write), error => error.code === 'CONCURRENT_CHANGE');
	assert.equal(mock.createCount, 1);
});

test('live-client regression: hash operations work without crypto.subtle', async () => {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
	const original = globalThis.crypto;
	Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { randomUUID: () => original.randomUUID() } });
	try {
		mock.nativeText = `\uFEFF${'测试'.repeat(1024)}`;
		const response = await api.executeTypedRequest(request('pcb.nativeBoardInfo'));
		assert.equal(response.result.sha256, createHash('sha256').update(mock.nativeText).digest('hex'));
		const saved = await api.executeTypedRequest(request('document.sourceHash'));
		assert.equal(saved.result.sha256, hash());
	}
	finally {
		Object.defineProperty(globalThis, 'crypto', descriptor);
	}
});
