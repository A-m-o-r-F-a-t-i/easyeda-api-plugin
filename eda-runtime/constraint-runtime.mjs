// Serialized into the EasyEDA extension context. Keep this file free of Node imports.
export async function constraintRuntime(eda, request) {
  const guard = async () => {
    const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    if (document?.uuid !== request.target.documentUuid || document?.documentType !== 3) throw Error('PCB document/type mismatch');
    if (request.target.projectUuid) {
      const project = await eda.dmt_Project.getCurrentProjectInfo();
      if (project?.uuid !== request.target.projectUuid) throw Error('PCB project mismatch');
    }
  };
  let beforeWriteCheck=null;
  const mutate = async (method, ...args) => { await guard(); if(beforeWriteCheck&&!method.startsWith('get'))await beforeWriteCheck();return await eda.pcb_Drc[method](...args); };
  const list = value => {if(Array.isArray(value))return value;if(value && typeof value === 'object')return Object.values(value);throw Error('Constraint group enumeration unavailable');};
  const strings = (value, label) => {
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.trim())) throw Error(`${label}: non-empty string array required`);
    return [...new Set(value)].sort();
  };
  const pairs = (value, label) => {
    if (!Array.isArray(value) || !value.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(item => typeof item === 'string' && item.trim()))) throw Error(`${label}: array of string pairs required`);
    return [...new Map(value.map(pair => [...pair].sort()).map(pair => [`${pair[0]}\u0000${pair[1]}`, pair])).values()].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  };
  const color = value => {
    if (value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('color: object or explicit null required');
    const output = { r: value.r, g: value.g, b: value.b, alpha: value.alpha };
    if (![output.r, output.g, output.b].every(item => Number.isInteger(item) && item >= 0 && item <= 255)) throw Error('color RGB values must be integers 0..255');
    if (typeof output.alpha !== 'number' || !Number.isFinite(output.alpha) || output.alpha < 0 || output.alpha > 1) throw Error('color alpha must be 0..1');
    return output;
  };
  const canonical = (groupType, item, nameOverride) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw Error(`${groupType}: object required`);
    const name = nameOverride ?? item.name;
    if (typeof name !== 'string' || !name.trim()) throw Error(`${groupType}.name: string required`);
    if (groupType === 'netClass' || groupType === 'equalLengthGroup') return { name, nets: strings(item.nets ?? [], 'nets'), color: color(item.color) };
    if (groupType === 'differentialPair') {
      if (typeof item.positiveNet !== 'string' || !item.positiveNet.trim() || typeof item.negativeNet !== 'string' || !item.negativeNet.trim()) throw Error('Differential pair requires positiveNet and negativeNet');
      if (item.positiveNet === item.negativeNet) throw Error('Differential pair requires distinct positive and negative nets');
      return { name, positiveNet: item.positiveNet, negativeNet: item.negativeNet };
    }
    if (groupType === 'padPairGroup') return { name, padPairs: pairs(item.padPairs ?? [], 'padPairs') };
    throw Error(`Unsupported constraint group ${groupType}`);
  };
  const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const groupApi = {
    netClass: { get: 'getAllNetClasses', create: 'createNetClass', delete: 'deleteNetClass', rename: 'modifyNetClassName', add: 'addNetToNetClass', remove: 'removeNetFromNetClass' },
    differentialPair: { get: 'getAllDifferentialPairs', create: 'createDifferentialPair', delete: 'deleteDifferentialPair', rename: 'modifyDifferentialPairName', setPositiveNet: 'modifyDifferentialPairPositiveNet', setNegativeNet: 'modifyDifferentialPairNegativeNet' },
    equalLengthGroup: { get: 'getAllEqualLengthNetGroups', create: 'createEqualLengthNetGroup', delete: 'deleteEqualLengthNetGroup', rename: 'modifyEqualLengthNetGroupName', add: 'addNetToEqualLengthNetGroup', remove: 'removeNetFromEqualLengthNetGroup' },
    padPairGroup: { get: 'getAllPadPairGroups', create: 'createPadPairGroup', delete: 'deletePadPairGroup', rename: 'modifyPadPairGroupName', add: 'addPadPairToPadPairGroup', remove: 'removePadPairFromPadPairGroup' },
  };
  const readGroup = async groupType => {
    const method = groupApi[groupType]?.get;
    if (!method || typeof eda.pcb_Drc?.[method] !== 'function') throw Error(`Constraint group API unavailable: ${groupType}`);
    return list(await mutate(method, )).map(item => canonical(groupType, item)).sort((left, right) => left.name.localeCompare(right.name));
  };
  const safe = async method => {
    if (typeof eda.pcb_Drc?.[method] !== 'function') return { available: false, value: null };
    try { return { available: true, value: await mutate(method, ) }; }
    catch (error) { return { available: true, error: String(error?.message ?? error), value: null }; }
  };

  await guard();
  if (request.kind === 'read') {
    return {
      currentRuleConfiguration: await safe('getCurrentRuleConfiguration'),
      allRuleConfigurations: await safe('getAllRuleConfigurations'),
      netRules: await safe('getNetRules'),
      netByNetRules: await safe('getNetByNetRules'),
      regionRules: await safe('getRegionRules'),
      netClasses: await readGroup('netClass'),
      differentialPairs: await readGroup('differentialPair'),
      equalLengthGroups: await readGroup('equalLengthGroup'),
      padPairGroups: await readGroup('padPairGroup'),
      realTimeDrc: await safe('getRealTimeDrcStatus'),
      note: 'Readback does not validate impedance, timing, manufacturability, or signal integrity.',
    };
  }
  if (request.kind !== 'manage') throw Error(`Unsupported constraints request ${request.kind}`);
  const clientVersion = await eda.sys_Environment?.getEditorCurrentVersion?.() ?? null;
  const byteAlpha = clientVersion === '3.2.186';
  const nativeColor = c => c === null ? null : byteAlpha ? {...c, alpha: Math.round(c.alpha * 255)} : c;
  const validatePadAddresses = async addresses => {
    const state=(o,k)=>{const f=o?.['getState_'+k[0].toUpperCase()+k.slice(1)];return typeof f==='function'?f.call(o):o?.[k];};
    const components=await eda.pcb_PrimitiveComponent.getAll();
    const standalone=await eda.pcb_PrimitivePad.getAll();
    for(const address of new Set(addresses.flat())) {
      const split=address.lastIndexOf(':');
      if(split<0){if(!standalone.some(p=>state(p,'primitiveId')===address))throw Error('Unknown standalone pad address; component pads require Designator:PadNumber');continue;}
      const designator=address.slice(0,split),number=address.slice(split+1);
      const matches=components.filter(c=>state(c,'designator')===designator);
      if(matches.length!==1||!number)throw Error('Component pad address is missing or ambiguous: '+address);
      const pins=await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(state(matches[0],'primitiveId'));
      if(!Array.isArray(pins)||pins.filter(p=>String(state(p,'padNumber'))===number).length!==1)throw Error('Unknown or ambiguous component pad: '+address);
    }
  };
  const operation = request.operation;
  const methods = groupApi[operation.groupType];
  if (!methods) throw Error(`Unsupported constraint group ${operation.groupType}`);
  const beforeGroups = await readGroup(operation.groupType);
  const current = beforeGroups.find(item => item.name === operation.name) ?? null;
  beforeWriteCheck=async()=>{const latest=await readGroup(operation.groupType);if(!equal(latest.find(item=>item.name===operation.name)??null,current))throw Error('Constraint old-value assertion failed after asynchronous preflight');if(operation.action==='rename'&&operation.newName!==operation.name&&latest.some(item=>item.name===operation.newName))throw Error('Constraint rename destination changed during preflight');};
  if(operation.groupType==='padPairGroup'&&['create','addMembers','removeMembers'].includes(operation.action)){
    const supplied=pairs(operation.action==='create'?operation.definition?.padPairs:operation.members,'padPairs');
    for(let i=0;i<supplied.length;i++){const [a,b]=supplied[i];if(a===b)throw Error('Pad pair requires two distinct endpoint addresses');}
  }
  let desired = null;
  let result = true;
  let status;
  if(operation.groupType==='padPairGroup' && operation.action==='create') await validatePadAddresses(pairs(operation.action==='create'?operation.definition?.padPairs:operation.members,'padPairs'));
  if (operation.action === 'create') {
    if (operation.expected !== null) throw Error('Create requires expected: null');
    desired = canonical(operation.groupType, { ...operation.definition, name: operation.name });
    if(byteAlpha && desired.color) desired.color={...desired.color,alpha:Math.round(desired.color.alpha*255)/255};
    if (current) {
      const expectedCurrent = (operation.groupType === 'netClass' || operation.groupType === 'equalLengthGroup') && desired.color === null
        ? { ...desired, color: current.color }
        : desired;
      if (!equal(current, expectedCurrent)) throw Error('Constraint group name already exists with different properties');
      return { status: 'already_exists', before: current, after: current, verified: true };
    }
    if (typeof eda.pcb_Drc[methods.create] !== 'function') throw Error('Create API unavailable');
    if (operation.groupType === 'netClass' || operation.groupType === 'equalLengthGroup') result = await mutate(methods.create, desired.name, desired.nets, nativeColor(desired.color));
    else if (operation.groupType === 'differentialPair') result = await mutate(methods.create, desired.name, desired.positiveNet, desired.negativeNet);
    else result = await mutate(methods.create, desired.name, desired.padPairs);
    status = 'created';
  } else {
    const expected = canonical(operation.groupType, operation.expected, operation.name);
    if (!current) throw Error('Constraint group no longer exists; inspect current state before retry');
    if (!equal(current, expected)) throw Error('Old-value assertion failed before constraint group modification');
    if (operation.action === 'delete') {
      result = await mutate(methods.delete, operation.name);
      status = 'deleted';
    } else if (operation.action === 'rename') {
      if (typeof operation.newName !== 'string' || !operation.newName.trim()) throw Error('newName required');
      if (beforeGroups.some(item => item.name === operation.newName)) throw Error('newName already exists');
      desired = { ...current, name: operation.newName };
      result = await mutate(methods.rename, operation.name, operation.newName);
      status = 'renamed';
    } else if (operation.action === 'addMembers' || operation.action === 'removeMembers') {
      if (!['netClass', 'equalLengthGroup', 'padPairGroup'].includes(operation.groupType)) throw Error('Member modification is unsupported for this group');
      const method = operation.action === 'addMembers' ? methods.add : methods.remove;
      if (operation.groupType === 'padPairGroup') {
        const members = pairs(operation.members, 'members');
        const existing = new Map(current.padPairs.map(pair => [`${pair[0]}\u0000${pair[1]}`, pair]));
        if (operation.action === 'addMembers') for (const pair of members) existing.set(`${pair[0]}\u0000${pair[1]}`, pair);
        else for (const pair of members) existing.delete(`${pair[0]}\u0000${pair[1]}`);
        desired = { ...current, padPairs: [...existing.values()].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))) };
        if (equal(current, desired)) return { status: 'already_modified', before: current, after: current, verified: true };
        const originalKeys=new Set(current.padPairs.map(pair=>JSON.stringify(pair)));
        let delta=members.filter(pair=>operation.action==='addMembers'?!originalKeys.has(JSON.stringify(pair)):originalKeys.has(JSON.stringify(pair)));
        if(operation.action==='addMembers')await validatePadAddresses(delta);
        else {
          const rawGroups=list(await mutate(methods.get));
          const raw=rawGroups.find(g=>g.name===operation.name);
          if(!raw)throw Error('Pad pair group disappeared during removal preflight');
          delta=delta.map(pair=>{
            const stored=raw.padPairs?.find(p=>JSON.stringify([...p].sort())===JSON.stringify(pair));
            if(!stored)throw Error('Pad pair member changed during removal preflight');
            return stored;
          });
        }
        result = await mutate(method, operation.name, delta);
      } else {
        const members = strings(operation.members, 'members');
        const existing = new Set(current.nets);
        if (operation.action === 'addMembers') members.forEach(member => existing.add(member));
        else members.forEach(member => existing.delete(member));
        desired = { ...current, nets: [...existing].sort() };
        if (equal(current, desired)) return { status: 'already_modified', before: current, after: current, verified: true };
        if (byteAlpha) {
          const clientDefaultColor={r:0,g:0,b:0,alpha:1};
          if(!equal(current.color,clientDefaultColor)&&operation.allowColorReset!==true) throw Error('Client 3.2.186 resets group color during member edits; preserve-color operation refused before write. Use explicit allowColorReset only when the color reset is acceptable.');
          desired.color=clientDefaultColor;
        }
        result = await mutate(method, operation.name, members);
      }
      status = operation.action === 'addMembers' ? 'members_added' : 'members_removed';
    } else if (operation.action === 'setPositiveNet' || operation.action === 'setNegativeNet') {
      if (operation.groupType !== 'differentialPair') throw Error('Net-side modification requires a differential pair');
      if (typeof operation.net !== 'string' || !operation.net.trim()) throw Error('net required');
      const field = operation.action === 'setPositiveNet' ? 'positiveNet' : 'negativeNet';
      desired = canonical(operation.groupType, { ...current, [field]: operation.net });
      if (equal(current, desired)) return { status: 'already_modified', before: current, after: current, verified: true };
      result = await mutate(methods[operation.action], operation.name, operation.net);
      status = field === 'positiveNet' ? 'positive_net_modified' : 'negative_net_modified';
    } else throw Error(`Unsupported constraint action ${operation.action}`);
  }
  if (!result) throw Error('EasyEDA constraint group API returned false');
  await guard();
  const afterGroups = await readGroup(operation.groupType);
  if (operation.action === 'delete') {
    if (afterGroups.some(item => item.name === operation.name)) throw Error('Constraint group delete readback still contains target');
    return { status, before: current, after: null, verified: true };
  }
  const lookupName = operation.action === 'rename' ? operation.newName : operation.name;
  const after = afterGroups.find(item => item.name === lookupName) ?? null;
  if (!after) throw Error('Constraint group modification failed independent readback');
  const expectedAfter = operation.action === 'create'
    && (operation.groupType === 'netClass' || operation.groupType === 'equalLengthGroup')
    && desired.color === null
    ? { ...desired, color: after.color }
    : desired;
  if (!equal(after, expectedAfter)) throw Error('Constraint group modification failed independent readback');
  return { status, before: current, after, verified: true };
}

export const buildConstraintCode = request => `return await (${constraintRuntime.toString()})(eda,${JSON.stringify(request)});`;
