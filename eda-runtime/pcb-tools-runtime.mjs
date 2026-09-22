// Serialized into the EasyEDA extension context. Keep this file free of Node imports.
export async function pcbToolsRuntime(eda, request) {
  const state = (object, key) => {
    if (object == null) return undefined;
    const getter = object[`getState_${key[0].toUpperCase()}${key.slice(1)}`];
    const value = typeof getter === 'function' ? getter.call(object) : object[key];
    if (value && typeof value.getSource === 'function') return value.getSource();
    return value;
  };
  const primitiveFields = ['primitiveType', 'primitiveId', 'designator', 'name', 'uniqueId', 'parentId', 'parentPrimitiveId', 'componentPrimitiveId', 'parentComponentPrimitiveId', 'padNumber', 'net', 'layer', 'x', 'y', 'rotation', 'startX', 'startY', 'endX', 'endY', 'lineWidth', 'diameter', 'holeDiameter', 'viaType', 'primitiveLock', 'pad', 'hole', 'metallization', 'pourName', 'pourPriority', 'preserveSilos', 'complexPolygon', 'pourPrimitiveId', 'pourFills', 'text', 'fontFamily', 'fontSize', 'alignMode', 'reverse', 'expansion', 'mirror', 'key', 'value', 'keyVisible', 'valueVisible'];
  const serialize = object => {
    if (object == null) return null;
    const output = {};
    for (const key of primitiveFields) {
      const value = state(object, key);
      if (value !== undefined) output[key] = value;
    }
    return output;
  };
  const primitiveId = object => state(object, 'primitiveId');
  const toList = value => {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object') return [];
    if (state(value, 'primitiveId') !== undefined) return [value];
    return Object.values(value);
  };
  const sortById = items => items.sort((left, right) => String(left?.primitiveId ?? '').localeCompare(String(right?.primitiveId ?? '')) || JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const guard = async () => {
    const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    if (document?.uuid !== request.target.documentUuid || document?.documentType !== 3) throw Error('PCB document/type mismatch');
    if (request.target.projectUuid) {
      const project = await eda.dmt_Project.getCurrentProjectInfo();
      if (project?.uuid !== request.target.projectUuid) throw Error('PCB project mismatch');
    }
    return document;
  };
  const association = async document => {
    const project = await eda.dmt_Project.getCurrentProjectInfo();
    const board = (project?.data ?? []).find(item => item?.pcb?.uuid === document.uuid);
    if (!board?.schematic?.uuid) throw Error('Associated schematic not found for active PCB');
    return {
      projectUuid: project.uuid,
      projectName: project.name,
      boardName: board.name,
      pcbUuid: board.pcb.uuid,
      pcbName: board.pcb.name,
      schematicUuid: board.schematic.uuid,
      schematicName: board.schematic.name,
      schematicPages: (board.schematic.page ?? []).map(page => ({ uuid: page.uuid, name: page.name, parentSchematicUuid: page.parentSchematicUuid })).sort((a, b) => a.uuid.localeCompare(b.uuid)),
    };
  };
  const stableStringify = value => JSON.stringify(value, function replacer(key, item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]]));
  });
  const fingerprint = value => {
    const text = stableStringify(value);
    let hash = 14695981039346656037n;
    const prime = 1099511628211n;
    const mask = 0xffffffffffffffffn;
    for (let index = 0; index < text.length; index += 1) hash = ((hash ^ BigInt(text.charCodeAt(index))) * prime) & mask;
    return hash.toString(16).padStart(16, '0');
  };
  const takeSyncSnapshot = async document => {
    const componentsRaw = await eda.pcb_PrimitiveComponent.getAll();
    const components = sortById(componentsRaw.map(serialize));
    const pads = [];
    for (const component of componentsRaw) {
      const id = primitiveId(component);
      const pins = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(id);
      if (!Array.isArray(pins)) throw Error(`Component pads unavailable: ${id}`);
      pads.push(...pins.map(p=>({...serialize(p),componentPrimitiveId:id}))); 
    }
    const standalonePads = await eda.pcb_PrimitivePad.getAll();
    const knownPadIds = new Set(pads.map(item => item.primitiveId));
    for (const pad of standalonePads) {
      const value = serialize(pad);
      if (!knownPadIds.has(value.primitiveId)) pads.push(value);
    }
    const readAll = async api => sortById((await api.getAll()).map(serialize));
    const snapshot = {
      association: await association(document),
      components,
      pads: sortById(pads),
      lines: await readAll(eda.pcb_PrimitiveLine),
      vias: await readAll(eda.pcb_PrimitiveVia),
      pours: await readAll(eda.pcb_PrimitivePour),
      strings: await readAll(eda.pcb_PrimitiveString),
      attributes: await readAll(eda.pcb_PrimitiveAttribute),
      netlist: await eda.pcb_Net.getNetlist(),
    };
    return { snapshot, runtimeHash: fingerprint(snapshot) };
  };
  const pourFillSummary = (poured, boundaryIds) => {
    const grouped = new Map(boundaryIds.map(id => [id, []]));
    for (const item of poured) {
      const boundaryId = state(item, 'pourPrimitiveId');
      if (grouped.has(boundaryId)) grouped.get(boundaryId).push(serialize(item));
    }
    return boundaryIds.map(boundaryId => {
      const items = grouped.get(boundaryId) ?? [];
      const fillPartCount = items.reduce((total, item) => total + (Array.isArray(item.pourFills) ? item.pourFills.length : 0), 0);
      return { boundaryId, pouredPrimitiveIds: items.map(item => item.primitiveId), pouredCount: items.length, fillPartCount, nonEmpty: items.length > 0 && fillPartCount > 0 };
    });
  };
  const fallbackPrimitiveQuery = async ({ point = null, region = null }) => {
    const modules = [
      ['component', 'pcb_PrimitiveComponent'],
      ['pad', 'pcb_PrimitivePad'],
      ['line', 'pcb_PrimitiveLine'],
      ['via', 'pcb_PrimitiveVia'],
      ['pour', 'pcb_PrimitivePour'],
      ['fill', 'pcb_PrimitiveFill'],
      ['arc', 'pcb_PrimitiveArc'],
      ['string', 'pcb_PrimitiveString'],
      ['attribute', 'pcb_PrimitiveAttribute'],
      ['region', 'pcb_PrimitiveRegion'],
    ];
    const candidates = [];
    const failures = [];
    for (const [sourceKind, moduleName] of modules) {
      const api = eda[moduleName];
      if (!api || typeof api.getAll !== 'function') continue;
      try {
        const raw = await api.getAll();
        for (const item of Array.isArray(raw) ? raw : raw ? [raw] : []) candidates.push({ sourceKind, raw: item, value: { ...serialize(item), sourceKind } });
      } catch (error) {
        failures.push({ sourceKind, error: String(error?.message ?? error) });
      }
    }
    const getBounds = async candidate => {
      const value = candidate.value;
      const xs = [value.x, value.startX, value.endX].filter(Number.isFinite);
      const ys = [value.y, value.startY, value.endY].filter(Number.isFinite);
      if (xs.length && ys.length && ['line', 'via', 'pad'].includes(candidate.sourceKind)) {
        const radius = candidate.sourceKind === 'line' ? (Number(value.lineWidth) || 0) / 2 : (Number(value.diameter) || 0) / 2;
        return { minX: Math.min(...xs) - radius, maxX: Math.max(...xs) + radius, minY: Math.min(...ys) - radius, maxY: Math.max(...ys) + radius, approximate: candidate.sourceKind === 'pad' && !Number.isFinite(value.diameter) };
      }
      if (value.primitiveId && typeof eda.pcb_Primitive?.getPrimitivesBBox === 'function') {
        try {
          const bounds = await eda.pcb_Primitive.getPrimitivesBBox([value.primitiveId]);
          if (bounds && [bounds.minX, bounds.maxX, bounds.minY, bounds.maxY].every(Number.isFinite)) return { ...bounds, approximate: false };
        } catch (error) {
          failures.push({ sourceKind: candidate.sourceKind, primitiveId: value.primitiveId, error: String(error?.message ?? error) });
        }
      }
      if (xs.length && ys.length) return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys), approximate: true };
      return null;
    };
    const results = [];
    const rectangle = region ? {
      minX: Math.min(region.left, region.right),
      maxX: Math.max(region.left, region.right),
      minY: Math.min(region.top, region.bottom),
      maxY: Math.max(region.top, region.bottom),
    } : null;
    for (const candidate of candidates) {
      const bounds = await getBounds(candidate);
      if (!bounds) continue;
      const included = point
        ? point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY
        : region.fullyContained
          ? bounds.minX >= rectangle.minX && bounds.maxX <= rectangle.maxX && bounds.minY >= rectangle.minY && bounds.maxY <= rectangle.maxY
          : bounds.maxX >= rectangle.minX && bounds.minX <= rectangle.maxX && bounds.maxY >= rectangle.minY && bounds.minY <= rectangle.maxY;
      if (included) results.push({ ...candidate.value, queryBounds: bounds });
    }
    results.sort((left, right) => String(left.primitiveId ?? '').localeCompare(String(right.primitiveId ?? '')) || left.sourceKind.localeCompare(right.sourceKind));
    return { results, failures };
  };

  const permissionDenied = error => /permission denied|access denied|unauthori[sz]ed|forbidden|权限拒绝|无权限/i.test(String(error?.message ?? error));
  const document = await guard();
  if (request.kind === 'capabilities') {
    const has = (module, method) => typeof eda[module]?.[method] === 'function';
    const pours = has('pcb_PrimitivePour', 'getAll') ? await eda.pcb_PrimitivePour.getAll() : [];
    const instanceRepour = pours.length > 0 && typeof pours[0]?.rebuildCopperRegion === 'function';
    return {
      document,
      clientVersion: await eda.sys_Environment?.getEditorCurrentVersion?.(),
      extensionContext: true,
      capabilityEvidence: 'method presence only; no operational success implied',
      methods: {
        rebuildCopperRegionsStatic: has('pcb_PrimitivePour', 'rebuildCopperRegions'),
        rebuildCopperRegionInstance: instanceRepour,
        independentTextCreate: has('pcb_PrimitiveString', 'create'),
        independentTextModify: has('pcb_PrimitiveString', 'modify'),
        attributeRead: has('pcb_PrimitiveAttribute', 'getAll'),
        attributeModify: has('pcb_PrimitiveAttribute', 'modify'),
        importSchematicChanges: has('pcb_Document', 'importChanges'),
        pickAtPoint: has('pcb_Document', 'getPrimitiveAtPoint'),
        queryRegion: has('pcb_Document', 'getPrimitivesInRegion'),
        constraintGroups: has('pcb_Drc', 'getAllNetClasses') && has('pcb_Drc', 'getAllDifferentialPairs'),
        realTimeDrc: has('pcb_Drc', 'getRealTimeDrcStatus') && has('pcb_Drc', 'startRealTimeDrc') && has('pcb_Drc', 'stopRealTimeDrc'),
        netlistComparison: has('sys_Tool', 'netlistComparison'),
        gerberFileObject: has('pcb_ManufactureData', 'getGerberFile'),
        pickAndPlaceFileObject: has('pcb_ManufactureData', 'getPickAndPlaceFile'),
        bomFileObject: has('pcb_ManufactureData', 'getBomFile'),
        testPointFileObject: has('pcb_ManufactureData', 'getTestPointFile'),
        netlistFileObject: has('pcb_ManufactureData', 'getNetlistFile'),
        ipcD356AFileObject: has('pcb_ManufactureData', 'getIpcD356AFile'),
        exactTabRenderedImage: has('dmt_EditorControl', 'getCurrentRenderedAreaImage'),
        zoomToMethodPresent: has('dmt_EditorControl', 'zoomTo'),
        zoomToRegion: has('dmt_EditorControl', 'zoomToRegion'),
        zoomToAllPrimitives: has('dmt_EditorControl', 'zoomToAllPrimitives'),
        zoomToBoardOutline: has('pcb_Document', 'zoomToBoardOutline'),
        layerVisibility: has('pcb_Layer', 'getAllLayers') && has('pcb_Layer', 'setLayerVisible') && has('pcb_Layer', 'setLayerInvisible'),
        autoRouting: has('pcb_Document', 'autoRouting'),
        autoLayout: has('pcb_Document', 'autoLayout'),
      },
      policy: {
        automaticPlacementAndRoutingExposed: false,
        arbitraryCodeExecutionExposed: false,
        sourceNetlistComparisonExposed: true,
        manufacturingBinaryTransportExposed: true,
        manufacturingExportKinds: ['gerber', 'pickAndPlace', 'bom', 'testPoints', 'netlist', 'ipcD356A'],
        currentViewportCaptureExposed: true,
        reversibleLayerIsolationCaptureExposed: true,
        stableSnapshotVectorInspectionExposed: true,
        viewportRoundTripCaptureExposed: false,
        apiGateVerificationExposed: true,
        orderPlacementExposed: false,
        routingClearanceDestructiveOperationsExposed: false,
        notes: [
          'Automatic placement/routing, route clearing, order placement and arbitrary JavaScript remain excluded even if the client implements them.',
          'Manufacturing exports use bounded File transfer, create-only local paths, signature/size checks and disk readback; no dialog, upload or order action is invoked.',
          'Client 3.2.186 exposes zoom methods but its parameter-free zoomTo viewport read fails. Current-view PNG capture never changes zoom; full-board/region inspection uses stable typed snapshots rendered to SVG.',
          'Optional PNG layer isolation is limited to enabled layers and refuses success unless the exact API-visible layer state is restored.',
        ],
      },
    };
  }
  if (request.kind === 'pick') {
    const scale = request.units === 'mm' ? 1 / 0.0254 : 1;
    if (request.mode === 'point') {
      const point = { x: request.point.x * scale, y: request.point.y * scale };
      try {
        const hit = await eda.pcb_Document.getPrimitiveAtPoint(point.x, point.y);
        const items = toList(hit).map(serialize);
        return { units: 'mil', mode: 'point', executionPath: 'native', total: items.length, items, fallbackFailures: [] };
      } catch (error) {
        if (permissionDenied(error)) throw error;
        const fallback = await fallbackPrimitiveQuery({ point });
        return { units: 'mil', mode: 'point', executionPath: 'typed-fallback', nativeError: String(error?.message ?? error), total: fallback.results.length, items: fallback.results, fallbackFailures: fallback.failures, limitations: ['Fallback point hits are based on primitive geometry/bounds and may include overlapping candidates.'] };
      }
    }
    const region = { ...request.region, left: request.region.left * scale, right: request.region.right * scale, top: request.region.top * scale, bottom: request.region.bottom * scale };
    const offset = request.offset ?? 0;
    const limit = request.limit ?? 100;
    try {
      const items = await eda.pcb_Document.getPrimitivesInRegion(region.left, region.right, region.top, region.bottom, region.fullyContained === true);
      const serialized = items.map(serialize);
      return { units: 'mil', mode: 'region', executionPath: 'native', total: serialized.length, offset, limit, items: serialized.slice(offset, offset + limit), hasMore: offset + limit < serialized.length, fallbackFailures: [] };
    } catch (error) {
      if (permissionDenied(error)) throw error;
      const fallback = await fallbackPrimitiveQuery({ region });
      return { units: 'mil', mode: 'region', executionPath: 'typed-fallback', nativeError: String(error?.message ?? error), total: fallback.results.length, offset, limit, items: fallback.results.slice(offset, offset + limit), hasMore: offset + limit < fallback.results.length, fallbackFailures: fallback.failures, limitations: ['Fallback region selection uses typed primitive APIs and native bounds where available.', 'Primitive kinds whose getAll/bounds calls fail are disclosed in fallbackFailures.'] };
    }
  }
  if (request.kind === 'rebuildPours') {
    const pours = await eda.pcb_PrimitivePour.getAll();
    const byId = new Map(pours.map(pour => [primitiveId(pour), pour]));
    const targetIds = request.pourIds?.length ? [...new Set(request.pourIds)] : [...byId.keys()];
    const missing = targetIds.filter(id => !byId.has(id));
    if (missing.length) throw Error(`Unknown pour boundary IDs: ${missing.join(', ')}`);
    const clientVersion=await eda.sys_Environment?.getEditorCurrentVersion?.()??null;
    if(clientVersion==='3.2.186'&&targetIds.length<byId.size&&request.allowCollateralRebuild!==true)throw Error('Client 3.2.186 may rebuild non-requested fills. Request all boundaries, or explicitly allowCollateralRebuild after reviewing the whole target PCB. No rebuild performed.');
    const beforePoured = (await eda.pcb_PrimitivePoured.getAll()).map(serialize);
    let executionPath;
    const operationResults = [];
    if (typeof eda.pcb_PrimitivePour.rebuildCopperRegions === 'function') {
      await guard();
      const result = await eda.pcb_PrimitivePour.rebuildCopperRegions(targetIds);
      if (result === false) throw Error('Static repour returned false; inspect current fills');
      executionPath = 'static-batch';
      operationResults.push({method:'static-batch',acknowledged:result === true});
    } else {
      for (const id of targetIds) {
        const pour = byId.get(id);
        if (typeof pour?.rebuildCopperRegion !== 'function') throw Error(`No public rebuild API available for pour ${id}`);
        await guard();
        const result = await pour.rebuildCopperRegion();
        if (result === false) throw Error(`Repour returned false for ${id}; inspect current fills`);
        operationResults.push({boundaryId:id,returnedFillId:primitiveId(result) ?? null,returnedNoFill:result == null});
      }
      executionPath = 'instance-fallback';
    }
    await guard();
    const afterPoured = await eda.pcb_PrimitivePoured.getAll();
    const after = pourFillSummary(afterPoured, targetIds);
    const beforeMap=new Map(beforePoured.map(x=>[x.primitiveId,x]));
    const afterMap=new Map(afterPoured.map(x=>{const item=serialize(x);return [item.primitiveId,item]}));
    const nonTargetFillChanges=[];
    for(const id of new Set([...beforeMap.keys(),...afterMap.keys()])){const a=beforeMap.get(id),b=afterMap.get(id);if(!targetIds.includes(a?.pourPrimitiveId??b?.pourPrimitiveId)&&stableStringify(a)!==stableStringify(b))nonTargetFillChanges.push({primitiveId:id,boundaryId:b?.pourPrimitiveId??a?.pourPrimitiveId,action:!a?'added':!b?'removed':'modified'});}

    return {
      executionPath,
      targetCount: targetIds.length,
      nonTargetFillChanges,
      scopeChangedOutsideRequest:nonTargetFillChanges.length>0,
      operationResults,
      unverifiedRebuildIds: executionPath === 'instance-fallback' ? operationResults.filter(item=>!item.returnedFillId || !after.some(fill=>fill.boundaryId===item.boundaryId && fill.pouredPrimitiveIds.includes(item.returnedFillId))).map(item=>item.boundaryId) : (operationResults.every(item=>item.acknowledged) ? [] : targetIds),
      before: pourFillSummary(beforePoured, targetIds),
      after,
      missingFillIds: after.filter(item => !item.nonEmpty).map(item => item.boundaryId),
      note: 'A non-empty Poured object confirms generated fill data, not electrical connectivity or thermal adequacy.',
    };
  }
  if (request.kind === 'realTimeDrc') {
    const before = await eda.pcb_Drc.getRealTimeDrcStatus();
    let result = true;
    if (!['status', 'start', 'stop'].includes(request.action)) throw Error('Unknown real-time DRC action');
    await guard();
    if (request.action === 'start') result = await eda.pcb_Drc.startRealTimeDrc();
    else if (request.action === 'stop') result = await eda.pcb_Drc.stopRealTimeDrc();
    // Always read state even when the native method returns false; expose evidence without declaring success.
    await guard();
    const after = await eda.pcb_Drc.getRealTimeDrcStatus();
    if (request.action !== 'status' && result !== true) throw Error('Real-time DRC returned false or failed; action='+request.action+', before='+JSON.stringify(before)+', result='+JSON.stringify(result)+', after='+JSON.stringify(after));
    if (typeof after !== 'boolean' || (request.action !== 'status' && after !== (request.action === 'start'))) throw Error('Real-time DRC state readback mismatch');
    return { action: request.action, before, result, after, verified: request.action !== 'status', note: 'False status may also mean the client could not read status; it does not certify a successful stop unless stop returned true.' };
  }
  if (request.kind === 'syncSnapshot') {
    const first = await takeSyncSnapshot(document);
    await guard();
    const current = await takeSyncSnapshot(document);
    await guard();
    if (stableStringify(first.snapshot) !== stableStringify(current.snapshot)) throw Error('PCB changed during synchronization preflight; wait for stable state');
    return { ...current, counts: Object.fromEntries(Object.entries(current.snapshot).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length])) };
  }
  if (request.kind === 'importChanges') {
    const before = await takeSyncSnapshot(document);
    if (before.runtimeHash !== request.expectedRuntimeHash) throw Error('PCB changed after synchronization preflight; prepare a new snapshot');
    if (before.snapshot.association.schematicUuid !== request.schematicUuid) throw Error('Associated schematic UUID mismatch');

    const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const readConfirmation = () => {
      const dom = globalThis?.document;
      if (!dom || typeof dom.getElementById !== 'function') return { available: false, modalPresent: false, buttons: [] };
      const modal = dom.getElementById('dlgShowImportChanges');
      if (!modal || typeof modal.querySelectorAll !== 'function') return { available: true, modalPresent: false, buttons: [] };
      const buttons = [...modal.querySelectorAll('button')].filter(button =>
        button?.getAttribute?.('data-test') === 'Apply Changes' ||
        button?.getAttribute?.('title') === '应用修改'
      );
      return { available: true, modalPresent: true, buttons };
    };
    const stableSnapshotAfterImport = async () => {
      let previous = await takeSyncSnapshot(document);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await delay(125);
        await guard();
        const current = await takeSyncSnapshot(document);
        if (current.runtimeHash === previous.runtimeHash) return current;
        previous = current;
      }
      throw Error('PCB state did not stabilize after schematic import');
    };

    await guard();
    const nativeAccepted = await eda.pcb_Document.importChanges(request.schematicUuid);
    if (!nativeAccepted) throw Error('EasyEDA importChanges returned false');
    await guard();

    const afterNative = await takeSyncSnapshot(document);
    let confirmationRequired = false;
    let confirmationApplied = false;
    const confirmationUiAvailable = typeof globalThis?.document?.getElementById === 'function';

    if (afterNative.runtimeHash === before.runtimeHash && confirmationUiAvailable) {
      let confirmation = readConfirmation();
      for (let attempt = 0; attempt < 40 && confirmation.buttons.length === 0; attempt += 1) {
        await delay(50);
        await guard();
        confirmation = readConfirmation();
      }
      if (confirmation.buttons.length > 1) throw Error('Ambiguous schematic import confirmation: found ' + confirmation.buttons.length + ' Apply Changes buttons');
      if (confirmation.buttons.length === 1) {
        const button = confirmation.buttons[0];
        if (button.disabled === true || button.getAttribute?.('aria-disabled') === 'true') throw Error('Schematic import Apply Changes button is disabled');
        confirmationRequired = true;
        button.click();
        confirmationApplied = true;

        let remaining = readConfirmation();
        for (let attempt = 0; attempt < 600 && remaining.buttons.length > 0; attempt += 1) {
          await delay(50);
          await guard();
          remaining = readConfirmation();
        }
        if (remaining.buttons.length > 0) throw Error('Schematic import confirmation did not finish within 30 seconds');
      }
    }

    await guard();
    const after = afterNative.runtimeHash === before.runtimeHash || confirmationApplied
      ? await stableSnapshotAfterImport()
      : afterNative;
    const changed = after.runtimeHash !== before.runtimeHash;
    return {
      nativeAccepted: true,
      confirmationUiAvailable,
      confirmationRequired,
      confirmationApplied,
      imported: changed,
      changed,
      before,
      after,
    };
  }
  throw Error(`Unsupported PCB tools request ${request.kind}`);
}

export const buildPcbToolsCode = request => `const result=await (${pcbToolsRuntime.toString()})(eda,${JSON.stringify(request)});const target=${JSON.stringify(request.target)};const d=await eda.dmt_SelectControl.getCurrentDocumentInfo();if(d?.uuid!==target.documentUuid||d?.documentType!==3)throw Error('PCB changed during tool execution');if(target.projectUuid&&(await eda.dmt_Project.getCurrentProjectInfo())?.uuid!==target.projectUuid)throw Error('Project changed during tool execution');return result;`;
