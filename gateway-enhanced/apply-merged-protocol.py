from pathlib import Path
import json, shutil
root = Path(__file__).resolve().parent
packages = root.parent

def replace_once(path, old, new):
    text = path.read_text(encoding='utf-8')
    if text.count(old) != 1:
        raise RuntimeError(f'Expected exactly one match in {path.name}: {old[:80]!r}')
    path.write_text(text.replace(old, new, 1), encoding='utf-8')

p = root/'src/protocol.ts'
replace_once(p, "\t'EPOCH_MISMATCH',", "\t'EPOCH_MISMATCH',\n\t'GENERATION_MISMATCH',")
replace_once(p, 'export interface GatewayExpectedState {\n\tchangeEpoch?: number;\n}', 'export interface GatewayExpectedState {\n\tgenerationId?: string;\n\tchangeEpoch?: number;\n\tsourceHash?: string;\n}')
replace_once(p, 'export interface RpcState {\n', "export interface RpcState {\n\tgenerationId: string;\n\teventCoverage: 'partial' | 'unavailable';\n")
replace_once(p, "export interface GatewayEventMessage {\n", "export interface GatewayEventMessage {\n\tgenerationId: string;\n")
replace_once(p, "assertKnownKeys(expectedRecord, ['changeEpoch'], 'rpc-request.expected');", "assertKnownKeys(expectedRecord, ['generationId', 'changeEpoch', 'sourceHash'], 'rpc-request.expected');")
replace_once(p, "expected = expectedRecord.changeEpoch === undefined ? {} : { changeEpoch: Number(expectedRecord.changeEpoch) };", "expected = { generationId: optionalString(expectedRecord, 'generationId', 'rpc-request.expected'), sourceHash: optionalString(expectedRecord, 'sourceHash', 'rpc-request.expected'), ...(expectedRecord.changeEpoch === undefined ? {} : { changeEpoch: Number(expectedRecord.changeEpoch) }) };\n\t\tif (expected.sourceHash !== undefined && !/^[0-9a-f]{64}$/.test(expected.sourceHash))\n\t\t\tthrow new GatewayProtocolError('INVALID_REQUEST', 'sourceHash must be a SHA-256 hex digest');")

shared = packages/'eda-runtime'
shared.mkdir(exist_ok=False)
for name in ['runtime.mjs', 'text-runtime.mjs', 'plan.mjs', 'text-plan.mjs', 'audit.mjs']:
    shutil.copy2(packages/'easyeda-pcb-mcp/src'/name, shared/name)
# Common runtime has no Node imports and is bundled into the extension.
(shared/'index.mjs').write_text("export { readRuntime, batchRuntime } from './runtime.mjs';\nexport { textBatchRuntime } from './text-runtime.mjs';\nexport { validatePlan } from './plan.mjs';\nexport { validateTextPlan } from './text-plan.mjs';\n",encoding='utf-8')
(shared/'index.d.mts').write_text('''export interface NormalizedPlan {
  target: { windowId?: string; projectUuid?: string; documentUuid: string };
  operations: Array<Record<string, unknown>>;
  options: { toleranceMil: number; batchSize: number; saveAfterBatch: boolean };
}
export function readRuntime(eda: unknown, request: Record<string, unknown>): Promise<unknown>;
export function batchRuntime(eda: unknown, job: Record<string, unknown>): Promise<{ok: boolean; results: Array<Record<string, unknown>>; error?: unknown}>;
export function textBatchRuntime(eda: unknown, job: Record<string, unknown>): Promise<{ok: boolean; results: Array<Record<string, unknown>>; error?: unknown}>;
export function validatePlan(plan: unknown): NormalizedPlan;
export function validateTextPlan(plan: unknown): NormalizedPlan;
''',encoding='utf-8')
(shared/'package.json').write_text(json.dumps({'name':'easyeda-shared-runtime','version':'2.0.0','private':True,'type':'module','exports':{'types':'./index.d.mts','default':'./index.mjs'}},indent=2)+'\n',encoding='utf-8')

p=root/'src/index.ts'
replace_once(p, "import * as extensionConfig from '../extension.json';", "import * as extensionConfig from '../extension.json';\nimport { getGenerationId } from './gateway-state';\nimport { serializeEditorOperation } from './execution-ledger';")
replace_once(p, '\t\t\tconst result = await executeLegacyCode(msg.code);', '\t\t\tconst code = msg.code;\n\t\t\tconst result = await serializeEditorOperation(() => executeLegacyCode(code));')
replace_once(p, 'sendBridgeMessage(await executeTypedRequest(msg));', 'sendBridgeMessage(await serializeEditorOperation(() => executeTypedRequest(msg)));')
replace_once(p, '\t\t\t\t\t\t\t\tgatewayVersion: extensionConfig.version,', '\t\t\t\t\t\t\t\tgatewayVersion: extensionConfig.version,\n\t\t\t\t\t\t\t\tgenerationId: getGenerationId(),')

contract = {
 'protocolVersion':2, 'contractVersion':'2.0.0',
 'targetFields':['windowId','projectUuid','documentUuid','tabId'],
 'expectedFields':['generationId','changeEpoch','sourceHash'],
 'operations':{name:{'version':1,'access':'read'} for name in ['system.capabilities','target.inspect','events.getState','events.getSince','pcb.read','pcb.nativeBoardInfo','pcb.exportDsn','document.sourceHash','document.createCheckpoint']},
 'limits':{'pcbInfoUtf8Bytes':1048576,'dsnUtf8Bytes':12582912,'documentSourceBytes':33554432,'batchOperations':24,'journalEvents':512},
 'errorCodes':['INVALID_REQUEST','CLIENT_UNSUPPORTED','TARGET_CHANGED','GENERATION_MISMATCH','EPOCH_MISMATCH','CONCURRENT_CHANGE','METHOD_FAILED','PARTIAL_SUCCESS','FILE_TOO_LARGE','TRANSFER_HASH_MISMATCH','WINDOW_DISCONNECTED','REQUEST_TIMEOUT','PERMISSION_DENIED','INTERNAL_ERROR']
}
for name in ['pcb.applyGeometryBatch','pcb.applyTextBatch']: contract['operations'][name]={'version':1,'access':'write'}
(packages/'gateway-protocol/contract.json').write_text(json.dumps(contract,indent=2)+'\n',encoding='utf-8')
# Origin=null is opaque and must not grant arbitrary browser pages localhost access.
replace_once(packages/'bridge-server/bridge-server.mjs', "if (!value || value === 'null') return true;", "if (!value) return true;\n  if (value === 'null') return false;")
replace_once(packages/'bridge-server/bridge-server.mjs', "'events.getSince', 'pcb.nativeBoardInfo'", "'events.getSince', 'pcb.read', 'pcb.nativeBoardInfo'")
print('Shared contract, independent runtime, generation fields and editor serialization prepared.')
