import assert from 'node:assert/strict';
import fs from 'node:fs';

const schema = JSON.parse(fs.readFileSync(new URL('./gateway-protocol-v2.schema.json', import.meta.url), 'utf8'));
const registry = JSON.parse(fs.readFileSync(new URL('./operations-v2.json', import.meta.url), 'utf8'));
const spec = fs.readFileSync(new URL('./gateway-protocol-v2.md', import.meta.url), 'utf8');

assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
assert.equal(registry.protocolVersion, 2);
assert.match(registry.schema, /\/v2\.0$/);

const requiredOperations = [
  'system.capabilities',
  'target.inspect',
  'events.getState',
  'pcb.nativeBoardInfo',
  'pcb.exportDsn',
  'document.sourceHash',
];
for (const operation of requiredOperations) {
  assert.ok(registry.operations[operation], `missing operation ${operation}`);
  assert.match(spec, new RegExp(operation.replaceAll('.', '\\.')));
}

const errorCodes = registry.errorCodes;
assert.equal(new Set(errorCodes).size, errorCodes.length, 'duplicate error code');
for (const code of ['TARGET_CHANGED', 'EPOCH_MISMATCH', 'CONCURRENT_CHANGE', 'TRANSFER_HASH_MISMATCH']) {
  assert.ok(errorCodes.includes(code), `missing error code ${code}`);
  assert.match(spec, new RegExp(`\\b${code}\\b`));
}

const schemaCodes = schema.$defs.errorObject.properties.code.enum;
assert.deepEqual([...schemaCodes].sort(), [...errorCodes].sort());
assert.ok(schema.oneOf.some(entry => entry.$ref === '#/$defs/rpcRequest'));
assert.ok(schema.oneOf.some(entry => entry.$ref === '#/$defs/event'));

assert.ok(registry.limits.httpRequestBytes > 0);
assert.ok(registry.limits.rpcResponseBytes >= registry.limits.httpRequestBytes);
assert.ok(registry.operations['pcb.nativeBoardInfo'].maximumUtf8Bytes <= registry.limits.rpcResponseBytes);
assert.ok(registry.operations['pcb.exportDsn'].maximumUtf8Bytes <= registry.limits.rpcResponseBytes);

console.log(JSON.stringify({
  ok: true,
  protocolVersion: registry.protocolVersion,
  operationCount: Object.keys(registry.operations).length,
  errorCodeCount: registry.errorCodes.length,
}, null, 2));
