import type { RpcRequest, RpcResultMessage } from './protocol';
import { sha256 } from '@noble/hashes/sha2.js';
import { batchRuntime, constraintRuntime, pcbToolsRuntime, readRuntime, textBatchRuntime, validatePlan, validateTextPlan } from '../../eda-runtime/index.mjs';
import { normalizeDocumentSource } from '../../eda-runtime/source-fingerprint.mjs';
import * as contract from '../../gateway-protocol/contract.json';
import * as extensionConfig from '../extension.json';
import { ExecutionLedger } from './execution-ledger';
import { getDocumentState, getEventCoverage, getEventsSince, getGenerationId, readCurrentIdentity } from './gateway-state';
import { GATEWAY_LIMITS, GatewayProtocolError, parseRpcRequest, PROTOCOL_VERSIONS } from './protocol';

const WINDOW_ONLY = new Set(['system.capabilities', 'target.inspect']);
const WRITE_OPERATIONS = new Set(['pcb.applyGeometryBatch', 'pcb.applyTextBatch', 'pcb.save']);
function isWriteRequest(request: RpcRequest): boolean {
	const native = request.arguments.request as Record<string, unknown> | undefined;
	return WRITE_OPERATIONS.has(request.operation) || (request.operation === 'pcb.nativeTools' && ['rebuildPours', 'importChanges', 'realTimeDrc'].includes(String(native?.kind))) || (request.operation === 'pcb.constraints' && native?.kind === 'manage');
}
const OPERATIONS = new Set(Object.keys(contract.operations));
let ledgerGeneration = '';
let writeLedger = new ExecutionLedger<RpcResultMessage>();

function methodPresence(): Record<string, boolean> {
	return {
		getPcbInfoFile: typeof eda.pcb_ManufactureData?.getPcbInfoFile === 'function',
		getDsnFile: typeof eda.pcb_ManufactureData?.getDsnFile === 'function',
		getDocumentSource: typeof eda.sys_FileManager?.getDocumentSource === 'function',
		primitiveEvents: typeof eda.pcb_Event?.addPrimitiveEventListener === 'function',
		netEvents: typeof eda.pcb_Event?.addNetEventListener === 'function',
	};
}

export function getRuntimeCapabilities(): Record<string, unknown> {
	const methods = methodPresence();
	return {
		legacyExecute: true,
		typedRpc: true,
		changeEpoch: true,
		eventStream: getEventCoverage() !== 'unavailable',
		eventCoverage: getEventCoverage(),
		utf8FileTransfer: true,
		binaryChunkTransfer: false,
		nativeBoardInfo: methods.getPcbInfoFile,
		dsnExport: methods.getDsnFile,
		documentSourceHash: methods.getDocumentSource,
		guardedPlan: methods.getDocumentSource,
		operations: contract.operations,
		limits: GATEWAY_LIMITS,
		capabilityEvidence: 'method-presence; invocation results are reported separately',
	};
}

function argumentsKeys(request: RpcRequest, allowed: string[]): void {
	const unexpected = Object.keys(request.arguments).filter(key => !allowed.includes(key));
	if (unexpected.length)
		throw new GatewayProtocolError('INVALID_REQUEST', 'Unsupported operation arguments', false, { fields: unexpected });
}

async function assertTarget(request: RpcRequest, checkExpected = true): Promise<Awaited<ReturnType<typeof readCurrentIdentity>>> {
	const actual = await readCurrentIdentity();
	if (!actual.windowId || actual.windowId !== request.target.windowId)
		throw new GatewayProtocolError('TARGET_CHANGED', 'Gateway window changed');
	if (!OPERATIONS.has(request.operation))
		throw new GatewayProtocolError('CLIENT_UNSUPPORTED', 'Unknown typed operation');
	for (const key of ['projectUuid', 'documentUuid', 'tabId'] as const) {
		const expected = request.target[key];
		if (!WINDOW_ONLY.has(request.operation) && !expected)
			throw new GatewayProtocolError('INVALID_REQUEST', `target.${key} is required`);
		if (expected !== undefined && expected !== actual[key])
			throw new GatewayProtocolError('TARGET_CHANGED', `target.${key} changed`);
	}
	if (!WINDOW_ONLY.has(request.operation) && actual.documentType !== 3)
		throw new GatewayProtocolError('TARGET_CHANGED', 'Target is not a PCB document');
	if (checkExpected) {
		const state = getDocumentState(actual.documentUuid);
		if (request.expected?.generationId !== undefined && request.expected.generationId !== state.generationId)
			throw new GatewayProtocolError('GENERATION_MISMATCH', 'Gateway connection generation changed');
		if (request.expected?.changeEpoch !== undefined && request.expected.changeEpoch !== state.changeEpoch)
			throw new GatewayProtocolError('EPOCH_MISMATCH', 'Document epoch changed');
	}
	return actual;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	// EasyEDA exposes randomUUID but does not expose crypto.subtle in its extension sandbox.
	return [...sha256(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}

interface SourceFingerprint {
	byteLength: number;
	sha256: string;
	rawSha256: string;
	fingerprintKind: string;
	omittedFields: string[];
	stabilityReads?: number;
}

async function sourceFingerprint(): Promise<SourceFingerprint> {
	if (!methodPresence().getDocumentSource)
		throw new GatewayProtocolError('CLIENT_UNSUPPORTED', 'Document source hashing is unavailable');
	const source = await eda.sys_FileManager.getDocumentSource();
	if (typeof source !== 'string')
		throw new GatewayProtocolError('METHOD_FAILED', 'Document source API did not return a string');
	const bytes = new TextEncoder().encode(source);
	if (bytes.byteLength > GATEWAY_LIMITS.documentSourceBytes)
		throw new GatewayProtocolError('FILE_TOO_LARGE', 'Document source exceeds limit');
	const normalized = normalizeDocumentSource(source);
	return { byteLength: bytes.byteLength, sha256: await sha256Hex(new TextEncoder().encode(normalized.canonicalText)), rawSha256: await sha256Hex(bytes), fingerprintKind: normalized.fingerprintKind, omittedFields: normalized.omittedFields };
}

async function stableSourceFingerprint(attempts = 8, delayMs = 25): Promise<SourceFingerprint> {
	let previous = await sourceFingerprint();
	const observed = [previous.sha256];
	for (let read = 2; read <= attempts; read += 1) {
		await new Promise(resolve => setTimeout(resolve, delayMs));
		const current = await sourceFingerprint();
		observed.push(current.sha256);
		if (current.sha256 === previous.sha256)
			return { ...current, stabilityReads: read };
		previous = current;
	}
	throw new GatewayProtocolError('CONCURRENT_CHANGE', 'PCB source did not stabilize after the native operation', false, { observedSourceHashes: observed, attempts, delayMs, requiresReadbackBeforeRetry: true });
}

async function utf8Envelope(file: File | undefined, maximum: number, fallbackName: string): Promise<Record<string, unknown>> {
	if (!file || typeof file.arrayBuffer !== 'function' || !Number.isSafeInteger(file.size) || file.size < 0)
		throw new GatewayProtocolError('METHOD_FAILED', 'Export did not return a readable File');
	if (file.size > maximum)
		throw new GatewayProtocolError('FILE_TOO_LARGE', 'Export exceeds byte limit', false, { size: file.size, maximum });
	const bytes = new Uint8Array(await file.arrayBuffer());
	if (bytes.length !== file.size)
		throw new GatewayProtocolError('TRANSFER_HASH_MISMATCH', 'File length changed during read');
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
	}
	catch { throw new GatewayProtocolError('METHOD_FAILED', 'Export is not valid UTF-8'); }
	return { fileName: file.name || fallbackName, mimeType: file.type || 'text/plain', encoding: 'utf8', byteLength: bytes.length, sha256: await sha256Hex(bytes), text };
}

function stable(value: unknown): unknown {
	if (Array.isArray(value))
		return value.map(stable);
	if (typeof value !== 'object' || value === null)
		return value;
	return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)]));
}

async function applyPlanBatch(request: RpcRequest): Promise<unknown> {
	argumentsKeys(request, ['plan', 'operationOffset', 'maxOperations', 'executionId']);
	if (!request.expected?.generationId || request.expected.changeEpoch === undefined || !request.expected.sourceHash)
		throw new GatewayProtocolError('INVALID_REQUEST', 'Writes require generationId, changeEpoch and sourceHash');
	const normalized = request.operation === 'pcb.applyGeometryBatch' ? validatePlan(request.arguments.plan) : validateTextPlan(request.arguments.plan);
	for (const field of ['windowId', 'projectUuid', 'documentUuid'] as const) {
		if (normalized.target[field] !== request.target[field])
			throw new GatewayProtocolError('TARGET_CHANGED', 'Plan and RPC target differ');
	}
	const offset = request.arguments.operationOffset ?? 0;
	const maximum = request.arguments.maxOperations ?? 1;
	if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) >= normalized.operations.length)
		throw new GatewayProtocolError('INVALID_REQUEST', 'Invalid operation offset');
	if (!Number.isSafeInteger(maximum) || Number(maximum) < 1 || Number(maximum) > contract.limits.batchOperations)
		throw new GatewayProtocolError('INVALID_REQUEST', 'Invalid batch size');
	const current = await sourceFingerprint();
	if (current.sha256 !== request.expected.sourceHash)
		throw new GatewayProtocolError('EPOCH_MISMATCH', 'Document source differs from prepared state');
	await assertTarget(request);
	const selected = normalized.operations.slice(Number(offset), Number(offset) + Number(maximum));
	const cursor = getDocumentState(request.target.documentUuid ?? null).lastEventSequence;
	const owned = new Set(selected.flatMap(op => [op.primitiveId]).filter((id): id is string => typeof id === 'string'));
	const plannedNets = new Set(selected.flatMap(op => [op.net]).filter((net): net is string => typeof net === 'string'));
	const checkpoint = async (results: Array<Record<string, unknown>>): Promise<void> => {
		for (const result of results) {
			if (typeof result.primitiveId === 'string')
				owned.add(result.primitiveId);
			if (Array.isArray(result.primitiveIds)) {
				for (const id of result.primitiveIds) {
					if (typeof id === 'string')
						owned.add(id);
				}
			}
		}
		const history = getEventsSince(cursor);
		const events = history.events as Array<{ eventType: string; items: Array<Record<string, unknown>> }>;
		const foreign = events.filter(event => !event.items.length || event.items.some((item) => {
			if (typeof item.primitiveId === 'string' && owned.has(item.primitiveId))
				return false;
			if (typeof item.parentComponentPrimitiveId === 'string' && owned.has(item.parentComponentPrimitiveId))
				return false;
			if (event.eventType.startsWith('net.') && typeof item.net === 'string' && plannedNets.has(item.net))
				return false;
			return true;
		}));
		if (history.eventsTruncated || foreign.length)
			throw new GatewayProtocolError('CONCURRENT_CHANGE', 'Observed edits are outside this batch; its remaining operations were not executed', false, { confirmedResults: results, foreignEvents: foreign.slice(0, 20), eventsTruncated: history.eventsTruncated, requiresReadbackBeforeRetry: true });
	};
	const job = { target: normalized.target, toleranceMil: normalized.options.toleranceMil, operations: selected, checkpoint };
	let result;
	try {
		result = request.operation === 'pcb.applyGeometryBatch' ? await batchRuntime(eda, job) : await textBatchRuntime(eda, job);
	}
	catch (error) {
		if (error instanceof GatewayProtocolError)
			throw error;
		throw new GatewayProtocolError('PARTIAL_SUCCESS', 'Native batch interrupted; read actual state before replanning', false, { outcome: 'unknown', error: error instanceof Error ? error.message : String(error) });
	}
	if (!result.ok)
		throw new GatewayProtocolError('PARTIAL_SUCCESS', 'Native batch stopped; completed operations must not be replayed', false, result);
	return { ...result, sourceAfter: await stableSourceFingerprint(), guardCoverage: 'target, generation, epoch, source-before and independent per-object readback; no native editor transaction' };
}

async function runOperation(request: RpcRequest): Promise<unknown> {
	if (['pcb.applyGeometryBatch', 'pcb.applyTextBatch'].includes(request.operation))
		return applyPlanBatch(request);
	if (request.operation === 'pcb.nativeTools' || request.operation === 'pcb.constraints') {
		argumentsKeys(request, ['request', 'executionId']);
		const native = request.arguments.request;
		if (typeof native !== 'object' || native === null || Array.isArray(native))
			throw new GatewayProtocolError('INVALID_REQUEST', 'Native request must be an object');
		const payload = native as Record<string, unknown>;
		const kinds = request.operation === 'pcb.nativeTools' ? ['capabilities', 'pick', 'rebuildPours', 'realTimeDrc', 'syncSnapshot', 'importChanges'] : ['read', 'manage'];
		if (!kinds.includes(String(payload.kind)))
			throw new GatewayProtocolError('INVALID_REQUEST', 'Unsupported native request kind');
		const result = request.operation === 'pcb.nativeTools' ? await pcbToolsRuntime(eda, { ...payload, target: request.target }) : await constraintRuntime(eda, { ...payload, target: request.target });
		return isWriteRequest(request) ? { ...result, sourceAfter: await stableSourceFingerprint() } : result;
	}
	if (request.operation === 'pcb.save') {
		argumentsKeys(request, ['executionId']);
		const saved = await eda.pcb_Document.save();
		if (!saved)
			throw new GatewayProtocolError('METHOD_FAILED', 'Native PCB save returned false');
		return { saved: true, sourceAfter: await stableSourceFingerprint() };
	}
	if (request.operation === 'pcb.drc') {
		argumentsKeys(request, []);
		const result = await eda.pcb_Drc.check(true, false, true);
		if (!Array.isArray(result))
			throw new GatewayProtocolError('METHOD_FAILED', 'Native verbose DRC did not return an array');
		return result;
	}

	if (request.operation === 'pcb.read') {
		argumentsKeys(request, ['request']);
		const value = request.arguments.request;
		if (typeof value !== 'object' || value === null || Array.isArray(value))
			throw new GatewayProtocolError('INVALID_REQUEST', 'request must be an object');
		const read = value as Record<string, unknown>;
		const allowedKinds = ['status', 'snapshot', 'auditSnapshot', 'components', 'pads', 'lines', 'vias', 'pours', 'poured', 'fills', 'arcs', 'strings', 'attributes', 'regions', 'bounds', 'pins', 'layers', 'rules', 'nets', 'netlist'];
		if (typeof read.kind !== 'string' || !allowedKinds.includes(read.kind))
			throw new GatewayProtocolError('INVALID_REQUEST', 'Unsupported read kind');
		return readRuntime(eda, { ...read, target: request.target });
	}
	if (request.operation === 'events.getSince') {
		argumentsKeys(request, ['afterSequence']);
		return getEventsSince(Number(request.arguments.afterSequence ?? 0));
	}
	argumentsKeys(request, []);
	switch (request.operation) {
		case 'system.capabilities':
			return { gatewayVersion: extensionConfig.version, clientVersion: eda.sys_Environment.getEditorCurrentVersion(), protocolVersions: [...PROTOCOL_VERSIONS], generationId: getGenerationId(), capabilities: getRuntimeCapabilities(), methods: methodPresence() };
		case 'target.inspect': {
			const identity = await readCurrentIdentity();
			return { ...identity, ...getDocumentState(identity.documentUuid) };
		}
		case 'events.getState': {
			const identity = await readCurrentIdentity();
			return { documentUuid: identity.documentUuid, ...getDocumentState(identity.documentUuid) };
		}
		case 'pcb.nativeBoardInfo':
			if (!methodPresence().getPcbInfoFile)
				throw new GatewayProtocolError('CLIENT_UNSUPPORTED', 'PCB Info export is unavailable');
			return utf8Envelope(await eda.pcb_ManufactureData.getPcbInfoFile('PCB_Info'), GATEWAY_LIMITS.pcbInfoUtf8Bytes, 'PCB_Info.txt');
		case 'pcb.exportDsn':
			if (!methodPresence().getDsnFile)
				throw new GatewayProtocolError('CLIENT_UNSUPPORTED', 'DSN export is unavailable');
			return utf8Envelope(await eda.pcb_ManufactureData.getDsnFile('Routing_Scene'), GATEWAY_LIMITS.dsnUtf8Bytes, 'Routing_Scene.dsn');
		case 'document.sourceHash':
			return stableSourceFingerprint();
		case 'document.createCheckpoint':
			return { ...(await stableSourceFingerprint()), target: request.target, ...getDocumentState(request.target.documentUuid ?? null), contentStored: false, recoverableBackup: false };
		default:
			throw new GatewayProtocolError('CLIENT_UNSUPPORTED', 'Unsupported typed operation');
	}
}

async function executeOnce(request: RpcRequest): Promise<RpcResultMessage> {
	const beforeIdentity = await assertTarget(request);
	const beforeState = getDocumentState(beforeIdentity.documentUuid);
	const isWrite = isWriteRequest(request);
	const hashProtected = !WINDOW_ONLY.has(request.operation) && !isWrite;
	const beforeHash = hashProtected || isWrite || request.expected?.sourceHash ? await sourceFingerprint() : null;
	if (request.expected?.sourceHash && beforeHash?.sha256 !== request.expected.sourceHash)
		throw new GatewayProtocolError('EPOCH_MISMATCH', 'Source hash differs from prepared state');
	if (isWrite && (!request.expected?.generationId || request.expected.changeEpoch === undefined || !request.expected.sourceHash))
		throw new GatewayProtocolError('INVALID_REQUEST', 'Native writes require generation, epoch and source guards');
	await assertTarget(request);
	let result: unknown;
	try {
		result = await runOperation(request);
	}
	catch (error) {
		if (isWrite && !(error instanceof GatewayProtocolError))
			throw new GatewayProtocolError('PARTIAL_SUCCESS', 'Native operation failed; inspect actual state before any retry', false, { outcome: 'unknown', message: error instanceof Error ? error.message : String(error) });
		throw error;
	}
	const afterIdentity = await assertTarget(request, false);
	if (JSON.stringify(beforeIdentity) !== JSON.stringify(afterIdentity))
		throw new GatewayProtocolError('CONCURRENT_CHANGE', 'Target changed while operation ran');
	const afterState = getDocumentState(afterIdentity.documentUuid);
	if (afterState.generationId !== beforeState.generationId)
		throw new GatewayProtocolError('GENERATION_MISMATCH', 'Gateway reconnected while operation ran');
	if (!isWrite && afterState.changeEpoch !== beforeState.changeEpoch)
		throw new GatewayProtocolError('CONCURRENT_CHANGE', 'PCB changed while operation ran');
	if (!isWrite && beforeHash && beforeHash.sha256 !== (await sourceFingerprint()).sha256)
		throw new GatewayProtocolError('CONCURRENT_CHANGE', 'PCB source changed during read');
	return { type: 'rpc-result', id: request.id, operation: request.operation, result, state: { generationId: afterState.generationId, eventCoverage: afterState.eventCoverage, documentUuid: afterIdentity.documentUuid, changeEpochBefore: beforeState.changeEpoch, changeEpochAfter: afterState.changeEpoch, lastEventSequence: afterState.lastEventSequence }, timestamp: Date.now() };
}

export async function executeTypedRequest(raw: unknown): Promise<RpcResultMessage> {
	const request = parseRpcRequest(raw);
	if (!isWriteRequest(request))
		return executeOnce(request);
	await assertTarget(request, false);
	const generation = getGenerationId();
	if (request.expected?.generationId !== generation)
		throw new GatewayProtocolError('GENERATION_MISMATCH', 'Writes require the current generation');
	if (ledgerGeneration !== generation) {
		ledgerGeneration = generation;
		writeLedger = new ExecutionLedger<RpcResultMessage>();
	}
	const executionId = request.arguments.executionId;
	if (typeof executionId !== 'string' || !executionId.trim() || executionId.length > 256)
		throw new GatewayProtocolError('INVALID_REQUEST', 'executionId is required');
	const fingerprint = await sha256Hex(new TextEncoder().encode(JSON.stringify(stable({ operation: request.operation, target: request.target, expected: request.expected, arguments: request.arguments }))));
	const key = `${request.target.documentUuid}:${executionId}`;
	const replayed = writeLedger.has(key);
	const result = await writeLedger.run(key, fingerprint, () => executeOnce(request));
	// Response correlation uses the new transport request ID even on an exact replay.
	return { ...result, id: request.id, replayed };
}
