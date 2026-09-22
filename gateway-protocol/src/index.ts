export const PROTOCOL_VERSIONS = [1, 2] as const;

export const GATEWAY_CAPABILITIES = {
	legacyExecute: true,
	typedRpc: true,
	changeEpoch: true,
	eventStream: true,
	utf8FileTransfer: true,
	binaryChunkTransfer: false,
	nativeBoardInfo: true,
	dsnExport: true,
	documentSourceHash: true,
} as const;

export const GATEWAY_LIMITS = {
	pcbInfoUtf8Bytes: 1024 * 1024,
	dsnUtf8Bytes: 12 * 1024 * 1024,
	documentSourceBytes: 32 * 1024 * 1024,
} as const;

export const ERROR_CODES = [
	'INVALID_REQUEST',
	'CLIENT_UNSUPPORTED',
	'TARGET_CHANGED',
	'EPOCH_MISMATCH',
	'GENERATION_MISMATCH',
	'CONCURRENT_CHANGE',
	'METHOD_FAILED',
	'PARTIAL_SUCCESS',
	'FILE_TOO_LARGE',
	'TRANSFER_HASH_MISMATCH',
	'WINDOW_DISCONNECTED',
	'REQUEST_TIMEOUT',
	'PERMISSION_DENIED',
	'INTERNAL_ERROR',
] as const;

export type GatewayErrorCode = typeof ERROR_CODES[number];

export interface GatewayTarget {
	windowId: string;
	projectUuid?: string;
	documentUuid?: string;
	tabId?: string;
}

export interface GatewayExpectedState {
	generationId?: string;
	changeEpoch?: number;
	sourceHash?: string;
}

export interface RpcRequest {
	type: 'rpc-request';
	id: string;
	operation: string;
	target: GatewayTarget;
	expected?: GatewayExpectedState;
	arguments: Record<string, unknown>;
	timestamp: number;
}

export interface RpcState {
	generationId: string;
	eventCoverage: 'partial' | 'unavailable';
	documentUuid: string | null;
	changeEpochBefore: number;
	changeEpochAfter: number;
	lastEventSequence: number;
}

export interface RpcResultMessage {
	replayed?: boolean;
	type: 'rpc-result';
	id: string;
	operation: string;
	result: unknown;
	state: RpcState;
	timestamp: number;
}

export interface RpcErrorPayload {
	code: GatewayErrorCode;
	message: string;
	retryable: boolean;
	details?: unknown;
}

export interface RpcErrorMessage {
	type: 'rpc-error';
	id: string;
	operation: string;
	error: RpcErrorPayload;
	timestamp: number;
}

export interface GatewayEventMessage {
	generationId: string;
	type: 'event';
	windowId: string;
	projectUuid: string | null;
	documentUuid: string | null;
	tabId: string | null;
	sequence: number;
	changeEpoch: number;
	eventType: string;
	requestId: string | null;
	items: Array<Record<string, unknown>>;
	timestamp: number;
}

export class GatewayProtocolError extends Error {
	readonly code: GatewayErrorCode;
	readonly retryable: boolean;
	readonly details?: unknown;

	constructor(code: GatewayErrorCode, message: string, retryable = false, details?: unknown) {
		super(message);
		this.name = 'GatewayProtocolError';
		this.code = code;
		this.retryable = retryable;
		this.details = details;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value))
		throw new GatewayProtocolError('INVALID_REQUEST', `${label} must be an object`);
	return value;
}

function assertKnownKeys(record: Record<string, unknown>, allowed: ReadonlyArray<string>, label: string): void {
	const unknown = Object.keys(record).filter(key => !allowed.includes(key));
	if (unknown.length)
		throw new GatewayProtocolError('INVALID_REQUEST', `${label} contains unsupported fields`, false, { fields: unknown });
}

function requiredString(record: Record<string, unknown>, key: string, label: string, maximum = 256): string {
	const value = record[key];
	if (typeof value !== 'string' || !value.trim() || value.length > maximum)
		throw new GatewayProtocolError('INVALID_REQUEST', `${label}.${key} must be a non-empty string up to ${maximum} characters`);
	return value;
}

function optionalString(record: Record<string, unknown>, key: string, label: string): string | undefined {
	const value = record[key];
	if (value === undefined)
		return undefined;
	if (typeof value !== 'string' || !value.trim() || value.length > 256)
		throw new GatewayProtocolError('INVALID_REQUEST', `${label}.${key} must be a non-empty string`);
	return value;
}

function requiredTimestamp(record: Record<string, unknown>): number {
	const value = record.timestamp;
	if (!Number.isSafeInteger(value) || Number(value) < 0)
		throw new GatewayProtocolError('INVALID_REQUEST', 'rpc-request.timestamp must be a non-negative integer');
	return Number(value);
}

export function parseRpcRequest(value: unknown): RpcRequest {
	const record = assertRecord(value, 'rpc-request');
	assertKnownKeys(record, ['type', 'id', 'operation', 'target', 'expected', 'arguments', 'timestamp'], 'rpc-request');
	if (record.type !== 'rpc-request')
		throw new GatewayProtocolError('INVALID_REQUEST', 'message type must be rpc-request');

	const targetRecord = assertRecord(record.target, 'rpc-request.target');
	assertKnownKeys(targetRecord, ['windowId', 'projectUuid', 'documentUuid', 'tabId'], 'rpc-request.target');
	const target: GatewayTarget = {
		windowId: requiredString(targetRecord, 'windowId', 'rpc-request.target'),
		projectUuid: optionalString(targetRecord, 'projectUuid', 'rpc-request.target'),
		documentUuid: optionalString(targetRecord, 'documentUuid', 'rpc-request.target'),
		tabId: optionalString(targetRecord, 'tabId', 'rpc-request.target'),
	};

	let expected: GatewayExpectedState | undefined;
	if (record.expected !== undefined) {
		const expectedRecord = assertRecord(record.expected, 'rpc-request.expected');
		assertKnownKeys(expectedRecord, ['generationId', 'changeEpoch', 'sourceHash'], 'rpc-request.expected');
		if (expectedRecord.changeEpoch !== undefined && (!Number.isSafeInteger(expectedRecord.changeEpoch) || Number(expectedRecord.changeEpoch) < 0))
			throw new GatewayProtocolError('INVALID_REQUEST', 'rpc-request.expected.changeEpoch must be a non-negative integer');
		expected = { generationId: optionalString(expectedRecord, 'generationId', 'rpc-request.expected'), sourceHash: optionalString(expectedRecord, 'sourceHash', 'rpc-request.expected'), ...(expectedRecord.changeEpoch === undefined ? {} : { changeEpoch: Number(expectedRecord.changeEpoch) }) };
		if (expected.sourceHash !== undefined && !/^[0-9a-f]{64}$/.test(expected.sourceHash))
			throw new GatewayProtocolError('INVALID_REQUEST', 'sourceHash must be a SHA-256 hex digest');
	}

	const argumentsRecord = assertRecord(record.arguments, 'rpc-request.arguments');
	return {
		type: 'rpc-request',
		id: requiredString(record, 'id', 'rpc-request'),
		operation: requiredString(record, 'operation', 'rpc-request', 128),
		target,
		expected,
		arguments: argumentsRecord,
		timestamp: requiredTimestamp(record),
	};
}

export function normalizeProtocolVersions(value: unknown): Array<1 | 2> {
	if (!Array.isArray(value))
		return [1];
	const normalized = [...new Set(value.filter(item => item === 1 || item === 2))] as Array<1 | 2>;
	return normalized.length ? normalized.sort() : [1];
}

export function negotiateProtocolVersion(remote: unknown): 1 | 2 {
	const versions = normalizeProtocolVersions(remote);
	return versions.includes(2) ? 2 : 1;
}

export function isPermissionError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /permission|denied|forbidden|权限|拒绝/i.test(message);
}

export function toRpcError(error: unknown, id = 'unknown', operation = 'unknown'): RpcErrorMessage {
	let payload: RpcErrorPayload;
	if (error instanceof GatewayProtocolError) {
		payload = {
			code: error.code,
			message: error.message.slice(0, 2000),
			retryable: error.retryable,
			...(error.details === undefined ? {} : { details: error.details }),
		};
	}
	else if (isPermissionError(error)) {
		payload = {
			code: 'PERMISSION_DENIED',
			message: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
			retryable: false,
		};
	}
	else {
		payload = {
			code: 'INTERNAL_ERROR',
			message: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
			retryable: false,
		};
	}
	return { type: 'rpc-error', id, operation, error: payload, timestamp: Date.now() };
}
