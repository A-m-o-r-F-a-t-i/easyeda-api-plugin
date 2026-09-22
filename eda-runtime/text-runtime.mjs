// Serialized into the EasyEDA extension context. Keep this file free of Node imports.
export async function textBatchRuntime(eda, job) {
  const tolerance = job.toleranceMil ?? 0.02;
  const target = job.target;
  const state = (object, key) => {
    if (object == null) return undefined;
    const getter = object[`getState_${key[0].toUpperCase()}${key.slice(1)}`];
    const value = typeof getter === 'function' ? getter.call(object) : object[key];
    return value === undefined && key === 'primitiveLock' ? false : value;
  };
  const guard = async () => {
    const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    if (document?.uuid !== target.documentUuid || document?.documentType !== 3) throw Error('PCB document/type mismatch');
    if (target.projectUuid) {
      const project = await eda.dmt_Project.getCurrentProjectInfo();
      if (project?.uuid !== target.projectUuid) throw Error('PCB project mismatch');
    }
  };
  const fields = {
    string: ['layer', 'x', 'y', 'text', 'fontFamily', 'fontSize', 'lineWidth', 'alignMode', 'rotation', 'reverse', 'expansion', 'mirror', 'primitiveLock'],
    attribute: ['parentPrimitiveId', 'layer', 'x', 'y', 'key', 'value', 'keyVisible', 'valueVisible', 'fontFamily', 'fontSize', 'lineWidth', 'alignMode', 'rotation', 'reverse', 'expansion', 'mirror', 'primitiveLock'],
  };
  const apiFor = kind => kind === 'string' ? eda.pcb_PrimitiveString : eda.pcb_PrimitiveAttribute;
  const primitiveId = object => state(object, 'primitiveId');
  const plain = (object, kind) => Object.fromEntries(['primitiveId', ...fields[kind]].map(key => [key, state(object, key)]));
  const matches = (object, expected) => object != null && Object.entries(expected).every(([key, value]) => {
    const actual = state(object, key);
    return typeof value === 'number' ? typeof actual === 'number' && Math.abs(actual - value) <= tolerance : actual === value;
  });
  const findExact = async (api, desired) => {
    const all = await api.getAll();
    if (!Array.isArray(all)) throw Error('Text enumeration unavailable; cannot determine whether object already exists');
    return all.filter(item => matches(item, desired));
  };
  const results = [];
  for (const operation of job.operations) {
    if (job.checkpoint) await job.checkpoint(results);
    try {
      await guard();
      const api = apiFor(operation.kind);
      if (!api) throw Error(`Unsupported text API kind ${operation.kind}`);
      if (operation.type === 'string.create') {
        const existing = await findExact(api, operation.state);
        if (existing.length) {
          results.push({ id: operation.id, status: 'already_exists', primitiveIds: existing.map(primitiveId), verified: true });
          continue;
        }
        const text = operation.state;
        await guard();
        const returned = await api.create(text.layer, text.x, text.y, text.text, text.fontFamily, text.fontSize, text.lineWidth, text.alignMode, text.rotation, text.reverse, text.expansion, text.mirror, text.primitiveLock);
        await guard();
        const returnedId = primitiveId(returned);
        const current = returnedId ? await api.get(returnedId) : null;
        const verified = current && matches(current, text) ? [current] : await findExact(api, text);
        if (!verified.length) throw Error('String creation not verified by independent readback');
        results.push({ id: operation.id, status: 'created', primitiveIds: verified.map(primitiveId), after: plain(verified[0], 'string'), verified: true });
        continue;
      }
      let current = await api.get(operation.primitiveId);
      if (operation.type === 'string.delete') {
        if (!current) {
          results.push({ id: operation.id, status: 'already_absent', primitiveId: operation.primitiveId, verified: true });
          continue;
        }
        if (!matches(current, operation.expected)) throw Error('Old-value assertion failed before string delete');
        if (state(current, 'primitiveLock')) throw Error('Locked string requires an explicit unlock before delete');
        const before = plain(current, 'string');
        await guard();
        current = await api.get(operation.primitiveId);
        if (!matches(current, operation.expected) || state(current,'primitiveLock')) throw Error('Old-value assertion failed after string-delete preflight');
        const deleted = await api.delete(operation.primitiveId);
        if (!deleted) throw Error('String delete returned false');
        await guard();
        if (await api.get(operation.primitiveId)) throw Error('String delete readback still contains target');
        results.push({ id: operation.id, status: 'deleted', primitiveId: operation.primitiveId, before, verified: true });
        continue;
      }
      if (!current) throw Error('Text primitive ID is stale; inspect current state before replanning');
      const desired = { ...operation.expected, ...operation.set };
      let already = matches(current, desired);
      if (!already && !matches(current, operation.expected)) throw Error('Old-value assertion failed before text modify');
      if (!already && state(current, 'primitiveLock') && operation.set.primitiveLock !== false) throw Error('Locked text primitive requires an explicit unlock');
      const before = plain(current, operation.kind);
      let returned = current;
      await guard();
      current = await api.get(operation.primitiveId);
      already = matches(current, desired);
      if (!already && (!matches(current,operation.expected) || (state(current,'primitiveLock') && operation.set.primitiveLock !== false))) throw Error('Old-value assertion failed after text-modify preflight');
      if(operation.kind==='attribute' && ['key','value'].some(k=>k in operation.set && operation.set[k]!==operation.expected[k])) throw Error('Text plan cannot change semantic attribute identity; use source ECO');
      if (!already) returned = await api.modify(operation.primitiveId, operation.set);
      await guard();
      const actualId = primitiveId(returned) || operation.primitiveId;
      current = await api.get(actualId);
      if (!matches(current, desired)) throw Error('Text modification failed independent readback');
      results.push({ id: operation.id, status: already ? 'already_modified' : 'modified', primitiveId: actualId, before, after: plain(current, operation.kind), verified: true });
    } catch (error) {
      return { ok: false, results, completedCount: results.length, error: { operationId: operation.id, message: String(error?.message ?? error) } };
    }
  }
  if (job.checkpoint) await job.checkpoint(results);
  return { ok: true, results, completedCount: results.length };
}

export const buildTextBatchCode = job => `return await (${textBatchRuntime.toString()})(eda,${JSON.stringify(job)});`;
