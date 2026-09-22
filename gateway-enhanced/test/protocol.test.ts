import assert from 'node:assert/strict';
import {
	ERROR_CODES,
	GatewayProtocolError,
	negotiateProtocolVersion,
	normalizeProtocolVersions,
	parseRpcRequest,
	toRpcError,
} from '../src/protocol';

assert.deepEqual(normalizeProtocolVersions(undefined), [1]);
assert.deepEqual(normalizeProtocolVersions([2, 1, 2, 99]), [1, 2]);
assert.equal(negotiateProtocolVersion([1, 2]), 2);
assert.equal(negotiateProtocolVersion([1]), 1);

const valid = parseRpcRequest({
	type: 'rpc-request',
	id: 'request-1',
	operation: 'pcb.nativeBoardInfo',
	target: {
		windowId: 'window-1',
		projectUuid: 'project-1',
		documentUuid: 'document-1',
		tabId: 'tab-1',
	},
	expected: { changeEpoch: 3 },
	arguments: {},
	timestamp: 1,
});
assert.equal(valid.expected?.changeEpoch, 3);
assert.equal(valid.target.documentUuid, 'document-1');

assert.throws(() => parseRpcRequest({
	type: 'rpc-request',
	id: 'request-1',
	operation: 'target.inspect',
	target: { windowId: 'window-1' },
	arguments: {},
	timestamp: 1,
	unexpected: true,
}), (error: unknown) => error instanceof GatewayProtocolError && error.code === 'INVALID_REQUEST');

const rpcError = toRpcError(new GatewayProtocolError('EPOCH_MISMATCH', 'stale', false, { expected: 1, actual: 2 }), 'request-2', 'events.getState');
assert.equal(rpcError.error.code, 'EPOCH_MISMATCH');
assert.equal(rpcError.id, 'request-2');
assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length);

console.warn(JSON.stringify({ ok: true, errorCodeCount: ERROR_CODES.length }, null, 2));
