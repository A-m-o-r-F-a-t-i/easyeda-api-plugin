// Explicit PCB text/attribute operations only. No placement search or automatic labeling.
export const TEXT_SCHEMA = 'easyeda-pcb-text-plan/v1';
export const TEXT_LAYERS = Object.freeze({ TOP_SILKSCREEN: 3, BOTTOM_SILKSCREEN: 4 });
export const TEXT_ALIGN = Object.freeze({ LEFT_TOP: 1, LEFT_MIDDLE: 2, LEFT_BOTTOM: 3, CENTER_TOP: 4, CENTER: 5, CENTER_BOTTOM: 6, RIGHT_TOP: 7, RIGHT_MIDDLE: 8, RIGHT_BOTTOM: 9 });
const TEXT_FIELDS = ['layer', 'x', 'y', 'text', 'fontFamily', 'fontSize', 'lineWidth', 'alignMode', 'rotation', 'reverse', 'expansion', 'mirror', 'primitiveLock'];
const ATTRIBUTE_FIELDS = ['parentPrimitiveId', 'layer', 'x', 'y', 'key', 'value', 'keyVisible', 'valueVisible', 'fontFamily', 'fontSize', 'lineWidth', 'alignMode', 'rotation', 'reverse', 'expansion', 'mirror', 'primitiveLock'];
const ATTRIBUTE_SETTABLE = ATTRIBUTE_FIELDS.filter(field => field !== 'parentPrimitiveId');

export const assertText = (condition, message) => { if (!condition) throw new Error(message); };
const object = (value, label) => { assertText(value && typeof value === 'object' && !Array.isArray(value), `${label}: object required`); return value; };
const keys = (value, allowed, label) => { object(value, label); for (const key of Object.keys(value)) assertText(allowed.includes(key), `${label}: unknown field ${key}`); };
const string = (value, label, empty = false) => { assertText(typeof value === 'string' && (empty || value.trim()), `${label}: string required`); return value; };
const number = (value, label) => { assertText(typeof value === 'number' && Number.isFinite(value), `${label}: finite number required`); return value; };
const boolean = (value, label) => { assertText(typeof value === 'boolean', `${label}: boolean required`); return value; };
const layer = value => {
  if (typeof value === 'number') { assertText([3, 4].includes(value), 'Text layer must be TOP_SILKSCREEN or BOTTOM_SILKSCREEN'); return value; }
  string(value, 'layer'); assertText(value in TEXT_LAYERS, `Unsupported text layer ${value}`); return TEXT_LAYERS[value];
};
const align = value => {
  if (typeof value === 'number') { assertText(Number.isInteger(value) && value >= 1 && value <= 9, 'alignMode must be 1..9'); return value; }
  string(value, 'alignMode'); assertText(value in TEXT_ALIGN, `Unsupported alignMode ${value}`); return TEXT_ALIGN[value];
};

function normalize(input, kind, scale, { expected = false, set = false } = {}) {
  const allowed = kind === 'string' ? TEXT_FIELDS : (set ? ATTRIBUTE_SETTABLE : ATTRIBUTE_FIELDS);
  keys(input, allowed, `${kind} ${expected ? 'expected' : set ? 'set' : 'state'}`);
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (['x', 'y', 'fontSize', 'lineWidth', 'expansion'].includes(key)) output[key] = number(value, key) * scale;
    else if (key === 'rotation') output[key] = number(value, key);
    else if (key === 'layer') output[key] = layer(value);
    else if (key === 'alignMode') output[key] = align(value);
    else if (['text', 'fontFamily', 'parentPrimitiveId', 'key'].includes(key)) output[key] = string(value, key, key === 'text');
    else if (key === 'value') output[key] = string(value, key, true);
    else if (['reverse', 'mirror', 'primitiveLock', 'keyVisible', 'valueVisible'].includes(key)) output[key] = boolean(value, key);
  }
  const required = kind === 'string' ? TEXT_FIELDS : ATTRIBUTE_FIELDS;
  if (expected || (!set && kind === 'string')) for (const key of required) assertText(key in output, `${kind}.${expected ? 'expected' : 'state'}.${key} required`);
  if ('fontSize' in output) assertText(output.fontSize > 0, 'fontSize must be positive');
  if ('lineWidth' in output) assertText(output.lineWidth > 0, 'lineWidth must be positive');
  if ('text' in output) assertText(output.text.length <= 1000, 'text exceeds 1000 characters');
  if ('fontFamily' in output) assertText(output.fontFamily.length <= 200, 'fontFamily too long');
  if ('rotation' in output && !expected) assertText(Math.abs(output.rotation) <= 3600, 'rotation out of supported range');
  return output;
}

export function validateTextPlan(raw) {
  keys(raw, ['schema', 'intent', 'target', 'units', 'options', 'operations'], 'plan');
  assertText(raw.schema === TEXT_SCHEMA, `Expected ${TEXT_SCHEMA}`);
  string(raw.intent, 'intent'); assertText(raw.intent.length <= 1000, 'intent too long');
  keys(raw.target, ['documentUuid', 'projectUuid', 'windowId'], 'target');
  string(raw.target.documentUuid, 'target.documentUuid');
  for (const key of ['projectUuid', 'windowId']) if (raw.target[key] !== undefined) string(raw.target[key], `target.${key}`);
  assertText(['mil', 'mm'].includes(raw.units), 'Explicit units mil or mm required');
  const scale = raw.units === 'mm' ? 1 / 0.0254 : 1;
  const rawOptions = raw.options ?? {};
  keys(rawOptions, ['batchSize', 'saveAfterBatch', 'toleranceMil'], 'options');
  if(rawOptions.saveAfterBatch !== undefined) boolean(rawOptions.saveAfterBatch,'saveAfterBatch');
  const options = { batchSize: rawOptions.batchSize ?? 24, saveAfterBatch: rawOptions.saveAfterBatch !== false, toleranceMil: rawOptions.toleranceMil ?? 0.02 };
  assertText(Number.isInteger(options.batchSize) && options.batchSize >= 1 && options.batchSize <= 100, 'batchSize must be 1..100');
  assertText(number(options.toleranceMil, 'toleranceMil') > 0 && options.toleranceMil <= 0.1, 'toleranceMil must be (0,0.1]');
  assertText(Array.isArray(raw.operations) && raw.operations.length >= 1 && raw.operations.length <= 5000, 'operations must contain 1..5000 items');
  const plan = { schema: raw.schema, intent: raw.intent, target: { ...raw.target }, units: 'mil', inputUnits: raw.units, options, operations: [], sourceOperationCount: raw.operations.length };
  const operationIds = new Set();
  for (const operation of raw.operations) {
    keys(operation, ['id', 'type', 'state', 'primitiveId', 'expected', 'set'], 'operation');
    string(operation.id, 'operation.id'); assertText(!operationIds.has(operation.id), 'Duplicate operation id'); operationIds.add(operation.id);
    string(operation.type, 'operation.type');
    if (operation.type === 'string.create') {
      plan.operations.push({ id: operation.id, type: operation.type, kind: 'string', state: normalize(operation.state, 'string', scale) });
    } else if (operation.type === 'string.modify' || operation.type === 'string.delete') {
      string(operation.primitiveId, 'primitiveId');
      const expected = normalize(operation.expected, 'string', scale, { expected: true });
      const set = operation.type.endsWith('.modify') ? normalize(operation.set, 'string', scale, { set: true }) : null;
      if (set) assertText(Object.keys(set).length > 0, 'Empty string modification');
      plan.operations.push({ id: operation.id, type: operation.type, kind: 'string', primitiveId: operation.primitiveId, expected, set });
    } else if (operation.type === 'attribute.modify') {
      string(operation.primitiveId, 'primitiveId');
      const expected = normalize(operation.expected, 'attribute', scale, { expected: true });
      const set = normalize(operation.set, 'attribute', scale, { set: true });
      assertText(Object.keys(set).length > 0, 'Empty attribute modification');
      assertText(!['key','value'].some(k => k in set && set[k] !== expected[k]), 'Text plan cannot change semantic attribute identity; use source ECO and independent strings');
      plan.operations.push({ id: operation.id, type: operation.type, kind: 'attribute', primitiveId: operation.primitiveId, expected, set });
    } else throw new Error(`Unsupported operation ${operation.type}`);
  }
  return plan;
}

export function textPlanSummary(plan) {
  return {
    schema: plan.schema,
    intent: plan.intent,
    target: plan.target,
    inputUnits: plan.inputUnits,
    executionUnits: 'mil',
    sourceOperationCount: plan.sourceOperationCount,
    operationCounts: plan.operations.reduce((counts, operation) => { counts[operation.type] = (counts[operation.type] ?? 0) + 1; return counts; }, {}),
    batchSize: plan.options.batchSize,
    checks: ['explicit units and target', 'silkscreen-only layers', 'finite text geometry', 'positive font/line dimensions', 'full expected old state for edits', 'bounded batch size'],
    notChecked: ['font glyph CAM rendering', 'pad/solder-mask/board-edge clearance', 'assembly occlusion and user readability', 'native DRC', 'electrical connectivity'],
  };
}
