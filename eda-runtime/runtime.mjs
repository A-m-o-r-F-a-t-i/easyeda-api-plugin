// These functions are serialized into the EasyEDA extension's async (eda) context.
// Keep them free of Node imports and external variables.
export async function readRuntime(eda, request) {
 const nativeValue=value=>{if(value&&typeof value.getSource==='function')return nativeValue(value.getSource());if(Array.isArray(value))return value.map(nativeValue);return value;};
 const state=(o,k)=>{if(o==null)return undefined;const g=o['getState_'+k[0].toUpperCase()+k.slice(1)];return nativeValue(typeof g==='function'?g.call(o):o[k]);};
 const serialize=o=>{if(o==null)return null;const keys=['primitiveType','primitiveId','designator','name','uniqueId','parentId','parentPrimitiveId','componentPrimitiveId','parentComponentPrimitiveId','padNumber','padType','net','layer','x','y','rotation','startX','startY','endX','endY','arcAngle','interactiveMode','fillMode','lineWidth','diameter','holeDiameter','viaType','primitiveLock','pad','hole','holeOffsetX','holeOffsetY','holeRotation','metallization','pourName','pourPriority','preserveSilos','polygon','complexPolygon','coordinateSet','dimensionType','precision','textFollow','unit','horizonMirror','width','height','topLeftX','topLeftY','fileName','pourPrimitiveId','pourFills','text','fontSize','fontFamily','alignMode','reverse','expansion','mirror','key','value','keyVisible','valueVisible'];const r={};for(const k of keys){let v=state(o,k);if(v&&typeof v.getSource==='function')v=v.getSource();if(v!==undefined)r[k]=v;}return r;};
 const clientVersion=await eda.sys_Environment?.getEditorCurrentVersion?.()??null;
 const normalizeNativeHole=hole=>{
  if(clientVersion==='4.1.60'&&Array.isArray(hole)&&hole[0]==='ROUND'&&hole.length===3&&hole.slice(1).every(x=>typeof x==='number'&&Number.isFinite(x)&&x>0)&&Math.abs(hole[1]-hole[2])<=1e-6)return {hole:['ROUND',hole[1]],nativeHoleRaw:[...hole]};
  return {hole,nativeHoleRaw:null};
 };

  const canonicalPadMap = async () => {
    if (typeof eda.pcb_PrimitivePad?.getAll !== 'function') return new Map();
    const all = await eda.pcb_PrimitivePad.getAll();
    if (!Array.isArray(all)) throw Error('Canonical pad enumeration unavailable');
    const map = new Map();
    for (const pad of all) {
      const id = state(pad, 'primitiveId');
      if (typeof id !== 'string' || !id || map.has(id)) throw Error('Missing or duplicate canonical pad identity');
      map.set(id, pad);
    }
    return map;
  };
  const finalizePhysicalPad = pad => {
    const normalized=normalizeNativeHole(pad.hole);
    if(normalized.nativeHoleRaw){pad.nativeHoleRaw=normalized.nativeHoleRaw;pad.hole=normalized.hole;}
    const h=pad.hole;
    if(h!==undefined){
      const valid=h===null || Array.isArray(h) && ((h[0]==='ROUND'&&h.length===2)||(h[0]==='SLOT'&&h.length===3)) && h.slice(1).every(x=>typeof x==='number'&&Number.isFinite(x)&&x>0) && (h[0]!=='SLOT'||h[2]>=h[1]);
      if(!valid)throw Error('Unsupported canonical hole shape: '+pad.primitiveId);
      pad.physicalDrill={present:pad.layer===12&&h!==null,units:'mil',hole:pad.layer===12?h:null};
    }else pad.physicalDrill={present:pad.layer===12?null:false,units:null,hole:null};
    return pad;
  };
  const reconcilePinHole = (pad, canonical) => {
    const native = canonical.get(pad.primitiveId);
    if (native && state(native,'hole') !== undefined) {
      const keys=pad.hole!=null||state(native,'hole')!=null?['padNumber','net','layer','x','y']:['padNumber','net','layer'];
      for (const key of keys) {
        const value = state(native, key);
        if (value !== undefined && pad[key] !== undefined && (typeof value === 'number' ? Math.abs(value-pad[key])>1e-6 : String(value)!==String(pad[key]))) throw Error('Canonical pad identity/pose drift: '+pad.primitiveId+' '+key);
      }
      const raw = pad.hole;
      for (const key of ['hole','holeOffsetX','holeOffsetY','holeRotation','metallization']) {
        const value=state(native,key); if(value!==undefined)pad[key]=value;
      }
      if (JSON.stringify(raw)!==JSON.stringify(pad.hole)) pad.componentPinHoleRaw=raw;
      if (pad.hole != null) pad.holeReadback={source:'pcb_PrimitivePad.getAll',units:'mil',verified:true};
    } else if (pad.hole != null) {
      pad.componentPinHoleRaw=pad.hole;
      delete pad.hole;
      pad.holeReadback={source:'component-pin-api',units:null,verified:false};
    }
    return finalizePhysicalPad(pad);
  };
 const doc=await eda.dmt_SelectControl.getCurrentDocumentInfo();
 if(request.target){if(doc?.uuid!==request.target.documentUuid||doc?.documentType!==3)throw Error('PCB document/type mismatch');if(request.target.projectUuid){const p=await eda.dmt_Project.getCurrentProjectInfo();if(p?.uuid!==request.target.projectUuid)throw Error('PCB project mismatch');}}
 if(request.kind==='status')return {document:doc??null,project:await eda.dmt_Project.getCurrentProjectInfo(),canvasOrigin:doc?.documentType===3?await eda.pcb_Document.getCanvasOrigin():null,apiUnits:'mil'};
 if(doc?.documentType!==3)throw Error('Active document is not a PCB');
 const modules={components:'pcb_PrimitiveComponent',pads:'pcb_PrimitivePad',lines:'pcb_PrimitiveLine',polylines:'pcb_PrimitivePolyline',vias:'pcb_PrimitiveVia',pours:'pcb_PrimitivePour',poured:'pcb_PrimitivePoured',fills:'pcb_PrimitiveFill',arcs:'pcb_PrimitiveArc',strings:'pcb_PrimitiveString',attributes:'pcb_PrimitiveAttribute',regions:'pcb_PrimitiveRegion',dimensions:'pcb_PrimitiveDimension',images:'pcb_PrimitiveImage',objects:'pcb_PrimitiveObject'};
 if(request.kind==='bounds'){
  if(!request.ids?.length)throw Error('bounds requires explicit primitive ids');
  const fn=eda.pcb_Primitive?.getPrimitivesBBox;if(typeof fn!=='function')throw Error('Native primitive BBox API unavailable');
  const items=[];for(const primitiveId of request.ids){const bounds=await fn.call(eda.pcb_Primitive,[primitiveId]);items.push({primitiveId,bounds:bounds??null,verified:bounds!=null});}
  return {units:'mil',meaning:'native primitive graphics bounds, not mechanical body or courtyard',items};
 }
 if(request.kind==='auditSnapshot'){
  const take=async()=>{
   const optional=async(api,label)=>{if(typeof api?.getAll!=='function')return {available:false,items:[]};const raw=await api.getAll();if(!Array.isArray(raw))throw Error(label+' enumeration unavailable');return {available:true,items:raw.map(serialize)};};
   const arcRead=await optional(eda.pcb_PrimitiveArc,'Arc'),fillRead=await optional(eda.pcb_PrimitiveFill,'Fill');
   const data={units:'mil',lines:(await eda.pcb_PrimitiveLine.getAll()).map(serialize),arcs:arcRead.items,fills:fillRead.items,vias:(await eda.pcb_PrimitiveVia.getAll()).map(serialize),pads:[],components:[],missingOptional:[...(!arcRead.available?['arcs']:[]),...(!fillRead.available?['fills']:[])]};
   const components=await eda.pcb_PrimitiveComponent.getAll();
   data.components=components.map(serialize);
   const canonical=await canonicalPadMap();
   const pads=new Map();
   for(const c of components){const componentId=state(c,'primitiveId');const pins=await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(componentId);if(!Array.isArray(pins))throw Error('Component pads unavailable: '+componentId);for(const p of pins){const value=reconcilePinHole(serialize(p),canonical);pads.set(componentId+':'+state(p,'primitiveId'),value);}}
   for(const p of await eda.pcb_PrimitivePad.getAll()){const value=finalizePhysicalPad(serialize(p));const id=state(p,'primitiveId');if(![...pads.values()].some(x=>x.primitiveId===id))pads.set('standalone:'+id,value);}
   data.pads=[...pads.values()];
   for(const key of ['lines','arcs','fills','vias','pads','components'])data[key].sort((a,b)=>String(a.primitiveId).localeCompare(String(b.primitiveId)));
   return data;
  };
  const first=await take(),second=await take();
  if(JSON.stringify(first)!==JSON.stringify(second))throw Error('PCB changed during read-only audit; re-read after edits settle');
  const after=await eda.dmt_SelectControl.getCurrentDocumentInfo();if(after?.uuid!==doc?.uuid||after?.documentType!==3)throw Error('PCB switched during audit');
  if(request.target?.projectUuid){const p=await eda.dmt_Project.getCurrentProjectInfo();if(p?.uuid!==request.target.projectUuid)throw Error('PCB project changed during audit');}
  second.coverage={source:'two matching complete API reads',atomic:false,componentCount:second.components.length,componentPads:'getAllPinsByPrimitiveId plus standalone pads',excluded:[...second.missingOptional,'poured','strings','regions']};
  delete second.missingOptional;delete second.components;return second;
 }
 if(request.kind==='pins'){if(!request.ids?.length)throw Error('pins requires explicit component IDs');const canonical=await canonicalPadMap();const out=[];for(const id of request.ids){const pins=await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(id);if(!Array.isArray(pins))throw Error('Component pads unavailable: '+id);out.push({componentId:id,pads:pins.map(p=>reconcilePinHole(serialize(p),canonical))});}return out;}
 if(request.kind==='layers')return await eda.pcb_Layer.getAllLayers();
 if(request.kind==='rules')return {configuration:await eda.pcb_Drc.getCurrentRuleConfiguration(),netRules:await eda.pcb_Drc.getNetRules(),netByNetRules:await eda.pcb_Drc.getNetByNetRules(),differentialPairs:await eda.pcb_Drc.getAllDifferentialPairs()};
 if(request.kind==='netMetrics'){
  if(typeof request.net!=='string'||!request.net)throw Error('netMetrics requires an exact nonempty net');
  const lengthMil=await eda.pcb_Net.getNetLength(request.net);if(typeof lengthMil!=='number'||!Number.isFinite(lengthMil)||lengthMil<0)throw Error('Native network length unavailable: '+request.net);
  const raw=await eda.pcb_Net.getAllPrimitivesByNet(request.net);if(!Array.isArray(raw))throw Error('Native per-net primitive enumeration unavailable: '+request.net);
  const primitives=raw.map(serialize),ids=new Set();for(const item of primitives){if(typeof item.primitiveId!=='string'||!item.primitiveId||ids.has(item.primitiveId))throw Error('Missing or duplicate per-net primitive identity');ids.add(item.primitiveId);if(item.net!==undefined&&item.net!==request.net)throw Error('Per-net primitive enumeration returned another network');}
  return {net:request.net,units:'mil',lengthMil,primitiveCount:primitives.length,primitives};
 }
 if(request.kind==='nets')return await eda.pcb_Net.getAllNets();
 if(request.kind==='netlist')return await eda.pcb_Net.getNetlist();

 const readPouredGeometry = async item => {
  const raw=item.pourFills;
  const base={clientVersion,rawField:'pourFills',canonicalField:'pourFillsMil',units:'mil',verified:false,coordinateScaleToMil:null};
  const output={...item,fillGeometry:base};
  if(clientVersion!=='4.1.60'){output.fillGeometry.reason='Poured coordinate units are not verified for this client';return output;}
  const scale=10; // 4.1.60 Poured XY uses 0.254 mm units, independently matched against native Gerber coordinates.
  const finite=x=>typeof x==='number'&&Number.isFinite(x);
  const polygon = value => {
   if(!Array.isArray(value)||!value.length)throw Error('Empty or missing poured path');
   if(value.every(Array.isArray))return value.map(polygon);
   if(value.length<2||!finite(value[0])||!finite(value[1]))throw Error('Unsupported poured contour start');
   const out=[value[0]*scale,value[1]*scale];let i=2;
   while(i<value.length){
    if(value[i]==='L'){if(i===value.length-1)throw Error('Trailing line command');out.push('L');i++;continue;}
    if(value[i]==='ARC'){
     const [angle,x,y]=value.slice(i+1,i+4);
     if(![angle,x,y].every(finite)||Math.abs(angle)>=360||angle===0)throw Error('Invalid poured arc');
     out.push('ARC',angle,x*scale,y*scale);i+=4;continue;
    }
    if(!finite(value[i])||!finite(value[i+1]))throw Error('Unsupported poured command or nonfinite coordinate');
    out.push(value[i]*scale,value[i+1]*scale);i+=2;
   }
   if(out.length<6)throw Error('Degenerate poured contour');
   return out;
  };
  try{
   if(!Array.isArray(raw))throw Error('Invalid poured fill list');
   output.pourFillsMil=raw.map(fill=>{
    if(fill?.fill!==true||!finite(fill.lineWidth)||fill.lineWidth<0)throw Error('Unsupported non-solid fill or missing line width');
    const source=typeof fill.path?.getSource==='function'?fill.path.getSource():fill.path?.complexPolygon;
    return {...fill,path:{complexPolygon:polygon(source)},lineWidth:fill.lineWidth*scale};
   });
   output.fillGeometry={...base,verified:true,coordinateScaleToMil:scale,rawUnits:'0.254 mm',commands:['L','ARC'],angleUnits:'degree',evidence:'client-4.1.60-native-Gerber-coordinate-crosscheck'};
  }catch(error){delete output.pourFillsMil;output.fillGeometry={...base,reason:String(error.message)};}
  return output;
 };
 const readKind=async kind=>{const api=eda[modules[kind]];if(!api)throw Error('Unsupported primitive kind '+kind);const raw=request.ids?await api.get(request.ids):await api.getAll();if(!Array.isArray(raw))throw Error('Invalid or unavailable '+kind+' array');const items=raw.map(serialize);if(kind==='pads')return items.map(finalizePhysicalPad);return kind==='poured'?await Promise.all(items.map(readPouredGeometry)):items;};
 if(request.kind==='snapshot'){const data={document:doc,units:'mil'};for(const k of request.include??['components','pads','lines','vias','pours'])data[k]=await readKind(k);data.layers=await eda.pcb_Layer.getAllLayers();return data;}
 let items=await readKind(request.kind);
 if(request.net!==undefined)items=items.filter(x=>x.net===request.net);
 if(request.layer!==undefined)items=items.filter(x=>x.layer===request.layer);
 if(request.parentPrimitiveId!==undefined)items=items.filter(x=>x.parentPrimitiveId===request.parentPrimitiveId||x.parentComponentPrimitiveId===request.parentPrimitiveId||x.componentPrimitiveId===request.parentPrimitiveId);
 if(request.region){const b=request.region;items=items.filter(x=>{const xs=[x.x,x.startX,x.endX].filter(Number.isFinite),ys=[x.y,x.startY,x.endY].filter(Number.isFinite);return xs.length&&ys.length&&Math.max(...xs)>=b.minX&&Math.min(...xs)<=b.maxX&&Math.max(...ys)>=b.minY&&Math.min(...ys)<=b.maxY;});}
 const offset=request.offset??0,limit=request.limit??100;return {total:items.length,offset,limit,items:items.slice(offset,offset+limit),hasMore:offset+limit<items.length};
}

export async function batchRuntime(eda, job) {
 const tol=job.toleranceMil??0.02,target=job.target;
 const nativeValue=value=>{if(value&&typeof value.getSource==='function')return nativeValue(value.getSource());if(Array.isArray(value))return value.map(nativeValue);return value;};
 const state=(o,k)=>{if(o==null)return undefined;const g=o['getState_'+k[0].toUpperCase()+k.slice(1)];const v=nativeValue(typeof g==='function'?g.call(o):o[k]);return v===undefined&&k==='primitiveLock'?false:v;};
 const id=o=>state(o,'primitiveId');
 const equal=(actual,expected)=>{if(typeof expected==='number')return typeof actual==='number'&&Math.abs(actual-expected)<=tol;if(Array.isArray(expected))return Array.isArray(actual)&&actual.length===expected.length&&expected.every((v,i)=>equal(actual[i],v));if(expected&&typeof expected==='object')return actual&&typeof actual==='object'&&Object.entries(expected).every(([k,v])=>equal(actual[k],v));return actual===expected;};
 const clientVersion=await eda.sys_Environment?.getEditorCurrentVersion?.()??null;
 const standalonePadGridMil=clientVersion==='4.1.60'?0.1:null;
 const isBareNpth=s=>{
  const h=s?.hole,p=s?.pad,emptyNet=s?.net===''||s?.net==null;
  if(s?.layer!==12||s?.metallization!==false||!emptyNet||!Array.isArray(h)||!Array.isArray(p))return false;
  if(h[0]==='ROUND'&&h.length===2&&p[0]==='ELLIPSE'&&p.length===3)return equal(p[1],h[1])&&equal(p[2],h[1]);
  if(h[0]==='SLOT'&&h.length===3&&p[0]==='OVAL'&&p.length===3)return equal(p[1],h[1])&&equal(p[2],h[2]);
  return false;
 };
 const isStandalonePth=s=>s?.layer===12&&s?.metallization===true&&typeof s?.net==='string'&&s.net.length>0&&Array.isArray(s?.hole)&&Array.isArray(s?.pad);
 const isStandaloneSmd=s=>[1,2].includes(s?.layer)&&s?.metallization===true&&s?.hole===null&&Array.isArray(s?.pad);
 const equalStandalonePadShape=(actual,expected)=>{
  if(!standalonePadGridMil||!Array.isArray(actual)||!Array.isArray(expected)||actual.length!==expected.length||actual[0]!==expected[0])return false;
  if(actual[0]==='POLYGON')return false;
  for(let i=1;i<expected.length;i++){
   if(actual[0]==='NGON'&&i===2){if(actual[i]!==expected[i])return false;continue;}
   if(!equalStandalonePadGridValue(actual[i],expected[i]))return false;
  }
  return true;
 };
 const equalStandalonePadGridValue=(actual,expected)=>{
  if(!standalonePadGridMil||typeof actual!=='number'||!Number.isFinite(actual)||typeof expected!=='number'||!Number.isFinite(expected))return false;
  const gridScale=1/standalonePadGridMil;
  const stored=Math.round(expected*gridScale)/gridScale;
  return Math.abs(actual-stored)<=tol;
 };
 const equalStandaloneRoundHole=(actual,expected)=>{
  if(!standalonePadGridMil||!Array.isArray(actual)||!Array.isArray(expected))return false;
  if(expected[0]==='ROUND'&&expected.length===2&&actual[0]==='ROUND'&&actual.length===3)return equal(actual[1],expected[1])&&equal(actual[2],expected[1]);
  return false;
 };
 const normalizeBareNpthPadNumber=value=>String(value).replace(/[^A-Za-z0-9]/g,'').toUpperCase();
 const matches=(o,s,{standalonePadState=false}={})=>o!=null&&Object.entries(s).every(([k,v])=>{
  const actual=state(o,k);
  const normalizedPad=isBareNpth(s)||(standalonePadState&&(isStandalonePth(s)||isStandaloneSmd(s)));
  if(k==='net'&&v===''&&(actual==null||actual===''))return true;
  if(k==='pad'&&normalizedPad&&equalStandalonePadShape(actual,v))return true;
  if(k==='hole'&&normalizedPad&&equalStandaloneRoundHole(actual,v))return true;
  if((k==='x'||k==='y')&&normalizedPad&&equalStandalonePadGridValue(actual,v))return true;
  if(standalonePadState&&standalonePadGridMil&&isStandaloneSmd(s)&&k==='hole'&&v===null&&(actual===undefined||actual===null))return true;
  if(standalonePadState&&standalonePadGridMil&&isStandaloneSmd(s)&&['holeOffsetX','holeOffsetY','holeRotation','padType'].includes(k)&&v===0&&(actual===undefined||actual===null||actual===0||(k==='holeRotation'&&typeof actual==='number'&&!Number.isFinite(actual))))return true;
  if(k==='padNumber'&&standalonePadGridMil&&isBareNpth(s)&&typeof actual==='string'&&typeof v==='string')return normalizeBareNpthPadNumber(actual)===normalizeBareNpthPadNumber(v);
  return equal(actual,v);
 });
 const guard=async()=>{const d=await eda.dmt_SelectControl.getCurrentDocumentInfo();if(d?.uuid!==target.documentUuid||d?.documentType!==3)throw Error('PCB document/type mismatch');if(target.projectUuid){const p=await eda.dmt_Project.getCurrentProjectInfo();if(p?.uuid!==target.projectUuid)throw Error('PCB project mismatch');}};
 const apiFor=k=>eda[{line:'pcb_PrimitiveLine',arc:'pcb_PrimitiveArc',polyline:'pcb_PrimitivePolyline',pad:'pcb_PrimitivePad',via:'pcb_PrimitiveVia',component:'pcb_PrimitiveComponent',pour:'pcb_PrimitivePour',fill:'pcb_PrimitiveFill'}[k]];
 const readOne=async(api,kind,primitiveId)=>{if(!['pad','pour'].includes(kind))return await api.get(primitiveId);const all=await api.getAll();if(!Array.isArray(all))throw Error((kind==='pad'?'Pad':'Pour')+' enumeration unavailable');const found=all.filter(x=>id(x)===primitiveId);if(found.length>1)throw Error('Duplicate '+kind+' identity');return found[0];};
 const fields={line:['net','layer','startX','startY','endX','endY','lineWidth','primitiveLock'],arc:['net','layer','startX','startY','endX','endY','arcAngle','lineWidth','interactiveMode','primitiveLock'],polyline:['net','layer','lineWidth','primitiveLock'],pad:['layer','padNumber','x','y','rotation','pad','net','hole','holeOffsetX','holeOffsetY','holeRotation','metallization','padType','primitiveLock'],via:['net','x','y','holeDiameter','diameter','viaType','primitiveLock'],component:['x','y','rotation','layer','primitiveLock','designator'],pour:['net','layer','pourName','pourPriority','preserveSilos','lineWidth','primitiveLock'],fill:['net','layer','fillMode','lineWidth','primitiveLock'],stackup:['copperLayerCount']};
 const plain=(o,kind)=>Object.fromEntries(['primitiveId',...fields[kind]].map(k=>[k,state(o,k)]));
 const sameLine=(s,lines)=>{
  const dx=s.endX-s.startX,dy=s.endY-s.startY,l2=dx*dx+dy*dy,len=Math.sqrt(l2),intervals=[];
  for(const l of lines){if(state(l,'net')!==s.net||state(l,'layer')!==s.layer||Math.abs(state(l,'lineWidth')-s.lineWidth)>tol||state(l,'primitiveLock')!==s.primitiveLock)continue;
   const ax=state(l,'startX')-s.startX,ay=state(l,'startY')-s.startY,bx=state(l,'endX')-s.startX,by=state(l,'endY')-s.startY;
   if(Math.abs(ax*dy-ay*dx)>tol*len||Math.abs(bx*dy-by*dx)>tol*len)continue;
   const a=(ax*dx+ay*dy)/l2,b=(bx*dx+by*dy)/l2;if(Math.max(a,b)<-tol/len||Math.min(a,b)>1+tol/len)continue;
   intervals.push({a:Math.min(a,b),b:Math.max(a,b),id:id(l)});
  }
  intervals.sort((a,b)=>a.a-b.a);let end=0;const ids=[];for(const i of intervals){if(i.a>end+tol/len)break;if(i.b>=end){end=i.b;ids.push(i.id);}if(end>=1-tol/len)return ids;}return null;
 };
 const lineRead=async s=>sameLine(s,await eda.pcb_PrimitiveLine.getAll(s.net,s.layer));
 const sourceOf=o=>{let native=state(o,'polygon')??state(o,'complexPolygon');if(native&&typeof native.getSource==='function')native=native.getSource();return native;};
 const equalSource=(o,src)=>{
  let native=sourceOf(o);
  const unwrap=source=>Array.isArray(source)&&source.length===1&&Array.isArray(source[0])?source[0]:source;
  const circle=source=>{
   source=unwrap(source);
   if(!Array.isArray(source)||source.length!==4||source[0]!=='CIRCLE'||!source.slice(1).every(x=>typeof x==='number'&&Number.isFinite(x))||source[3]<=0)return null;
   return source.slice(1);
  };
  const nativeCircle=circle(native),expectedCircle=circle(src);
  if(nativeCircle||expectedCircle)return !!nativeCircle&&!!expectedCircle&&expectedCircle.every((value,index)=>Math.abs(nativeCircle[index]-value)<=tol);
  const ring=source=>{
   source=unwrap(source);
   if(!Array.isArray(source))return null;
   const numbers=[];for(const token of source){if(token==='L')continue;if(typeof token!=='number'||!Number.isFinite(token))return null;numbers.push(token);}
   if(numbers.length<6||numbers.length%2)return null;
   const points=[];for(let i=0;i<numbers.length;i+=2)points.push([numbers[i],numbers[i+1]]);
   const near=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1])<=tol;
   if(points.length>3&&near(points[0],points.at(-1)))points.pop();
   return points;
  };
  const a=ring(native),b=ring(src);if(!a||!b||a.length!==b.length)return false;
  return a.some((_,start)=>[1,-1].some(direction=>b.every((p,i)=>{const q=a[(start+direction*i+a.length)%a.length];return Math.hypot(p[0]-q[0],p[1]-q[1])<=tol;})));
 };
 const priorityInfo=async(op,ids)=>{if(op.kind!=='pour'||op.priorityPolicy!=='native')return {};const values=[];for(const primitiveId of ids){const actual=await readOne(apiFor('pour'),'pour',primitiveId);const priority=state(actual,'pourPriority');if(!Number.isFinite(priority))throw Error('Native pour priority unavailable');values.push({primitiveId,pourPriority:priority});}return {priorityPolicy:'native',actualPriorities:values,requiresPriorityReview:true};};
 const verifyCreate=async op=>{
  const api=apiFor(op.kind);if(op.kind==='line')return await lineRead(op.state);
  let all;
  if(['polyline','pad'].includes(op.kind))all=await api.getAll();
  else if(op.kind==='fill')all=await api.getAll(op.state.layer,op.state.net);
  else if(['arc','pour'].includes(op.kind))all=await api.getAll(op.state.net,op.state.layer);
  else all=await api.getAll(op.state.net);
  if(!Array.isArray(all))throw Error('Creation verification enumeration unavailable: '+op.kind);
  const found=all.filter(x=>matches(x,op.state,{standalonePadState:op.kind==='pad'})&&(!['pour','polyline','fill'].includes(op.kind)||equalSource(x,op.polygon)));
  if(['pad','arc','fill'].includes(op.kind)&&found.length>1)throw Error('Duplicate exact geometry/properties: '+op.kind);
  return found.length?found.map(id):null;
 };
 const copperLayerCount=async()=>{
  const layers=await eda.pcb_Layer.getAllLayers();
  if(!Array.isArray(layers))throw Error('Copper layer enumeration unavailable');
  const ids=layers.map(item=>state(item,'id')).filter(id=>id===1||id===2||Number.isInteger(id)&&id>=15&&id<=44);
  if(new Set(ids).size!==ids.length)throw Error('Duplicate copper layer identity');
  if(ids.length<2||ids.length>32||ids.length%2!==0)throw Error('Native copper layer count is unavailable or inconsistent');
  return ids.length;
 };
 const results=[];
 for(const op of job.operations){
    if (job.checkpoint) await job.checkpoint(results);
  try {
   await guard();
   if(op.kind==='stackup'){
    const before=await copperLayerCount(),desired=op.set.copperLayerCount;
    if(before!==op.expected.copperLayerCount)throw Error('Old copper layer count assertion failed');
    if(before===desired){results.push({id:op.id,status:'already_modified',primitiveId:'PCB_STACKUP',before:{copperLayerCount:before},after:{copperLayerCount:before},verified:true,requiresRepour:false});continue;}
    await guard();
    if(await eda.pcb_Layer.setTheNumberOfCopperLayers(desired)!==true)throw Error('Native copper layer count write was not acknowledged');
    await guard();const after=await copperLayerCount();
    if(after!==desired)throw Error('Copper layer count readback mismatch');
    results.push({id:op.id,status:'modified',primitiveId:'PCB_STACKUP',before:{copperLayerCount:before},after:{copperLayerCount:after},verified:true,requiresRepour:true});continue;
   }
   if(op.kind==='pour'&&op.type!=='pour.delete'&&(await eda.sys_Environment?.getEditorCurrentVersion?.())==='3.2.186'){const requested=op.state??op.set??{};if(('pourPriority'in requested)||('lineWidth'in requested&&Math.abs(requested.lineWidth-0.2)>1e-9))throw Error('Client 3.2.186 renumbers pour priorities and ignores nondefault outline widths. Use explicit native priority policy without a priority number and lineWidth=0.2 mil, or another independently verified client. No write performed.');}
   const api=apiFor(op.kind);if(!api)throw Error('Unsupported API kind');
   if(op.type.endsWith('.create')){
    let ids=await verifyCreate(op);if(ids){results.push({id:op.id,status:'already_exists',primitiveIds:ids,verified:true,...await priorityInfo(op,ids)});continue;}
    const s=op.state;await guard();
    if(op.kind==='line')await api.create(s.net,s.layer,s.startX,s.startY,s.endX,s.endY,s.lineWidth,s.primitiveLock);
    else if(op.kind==='arc')await api.create(s.net,s.layer,s.startX,s.startY,s.endX,s.endY,s.arcAngle,s.lineWidth,s.interactiveMode,s.primitiveLock);
    else if(op.kind==='polyline'){const polygon=eda.pcb_MathPolygon.createPolygon(op.polygon);if(!polygon)throw Error('Invalid polyline polygon source');await api.create(s.net,s.layer,polygon,s.lineWidth,s.primitiveLock);}
    else if(op.kind==='pad')await api.create(s.layer,s.padNumber,s.x,s.y,s.rotation,s.pad,s.net||undefined,s.hole,s.holeOffsetX,s.holeOffsetY,s.holeRotation,s.metallization,s.padType,undefined,null,null,s.primitiveLock);
    else if(op.kind==='via')await api.create(s.net,s.x,s.y,s.holeDiameter,s.diameter,0,null,null,s.primitiveLock);
    else if(op.kind==='fill'){const polygon=eda.pcb_MathPolygon.createPolygon(op.polygon);if(!polygon)throw Error('Invalid fill polygon source');await api.create(s.layer,polygon,s.net||undefined,s.fillMode,s.lineWidth,s.primitiveLock);}
    else if(op.kind==='pour'){
     const existing=await api.getAll(s.net,s.layer);if(existing.some(x=>state(x,'pourName')===s.pourName))throw Error('pourName already used with different geometry/properties');
     const polygon=eda.pcb_MathPolygon.createPolygon(op.polygon);if(!polygon)throw Error('Invalid polygon source');
     await guard();await api.create(s.net,s.layer,polygon,'solid',s.preserveSilos,s.pourName,s.pourPriority,s.lineWidth,s.primitiveLock);
    }
    await guard();ids=await verifyCreate(op);if(!ids)throw Error('Creation not verified by independent geometry readback');
    results.push({id:op.id,status:'created',primitiveIds:ids,verified:true,requiresRepour:op.kind!=='polyline',...await priorityInfo(op,ids)});continue;
   }
   let current=await readOne(api,op.kind,op.primitiveId);
   if(op.type.endsWith('.delete')){
    const expectedMatches=value=>matches(value,op.expected,{standalonePadState:op.kind==='pad'})&&(!['fill','polyline'].includes(op.kind)||equalSource(value,op.expectedPolygon));
    if(!current){const all=await api.getAll();if(all.some(expectedMatches))throw Error('Original ID vanished but expected geometry still exists; requery split/merged objects');results.push({id:op.id,status:'already_absent',verified:true});continue;}
    if(!expectedMatches(current))throw Error('Old-value assertion failed before delete');
    if(state(current,'primitiveLock'))throw Error('Locked primitive: explicitly unlock in a separate operation');
    const old=plain(current,op.kind),beforePolygon=['fill','polyline'].includes(op.kind)?sourceOf(current):undefined;
    await guard();current=await readOne(api,op.kind,op.primitiveId);if(!expectedMatches(current)||state(current,'primitiveLock'))throw Error('Old-value assertion failed after delete preflight');await api.delete(op.primitiveId);await guard();if(await readOne(api,op.kind,op.primitiveId))throw Error('Delete readback still contains target');results.push({id:op.id,status:'deleted',primitiveId:op.primitiveId,before:old,...(beforePolygon?{beforePolygon}:{}),verified:true,requiresRepour:true});continue;
   }
   const desired={...op.expected,...op.set},desiredPolygon=['fill','polyline'].includes(op.kind)?(op.polygon??op.expectedPolygon):null;
   const expectedMatches=value=>matches(value,op.expected,{standalonePadState:op.kind==='pad'})&&(!['fill','polyline'].includes(op.kind)||equalSource(value,op.expectedPolygon));
   const desiredMatches=value=>matches(value,desired,{standalonePadState:op.kind==='pad'})&&(!['fill','polyline'].includes(op.kind)||equalSource(value,desiredPolygon));
   let already=current&&desiredMatches(current);
   if(!current)throw Error('Primitive ID is stale; inspect current geometry before replanning');
   if(!already&&!expectedMatches(current))throw Error('Old-value assertion failed before modify');
   if(!already&&state(current,'primitiveLock')&&op.set.primitiveLock!==false)throw Error('Locked primitive requires an explicit unlock');
   let beforePads=null,beforePinMap=null,affectedNets=[];
   const pinMap=pads=>JSON.stringify(pads.map(p=>{const number=state(p,'padNumber'),net=state(p,'net');if(number===undefined||number===null||String(number)==='')throw Error('Pad number unavailable; cannot guard pin-net identity');return [String(number),net??''];}).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
   if(op.kind==='component'){
    beforePads=await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(op.primitiveId);if(!Array.isArray(beforePads))throw Error('Component pads unavailable');
    beforePinMap=pinMap(beforePads);
    affectedNets=[...new Set(beforePads.map(p=>state(p,'net')).filter(Boolean))];
    if(op.copperPolicy==='unrouted'){
     const lines=await eda.pcb_PrimitiveLine.getAll(),arcs=await eda.pcb_PrimitiveArc.getAll(),fills=await eda.pcb_PrimitiveFill.getAll(),vias=await eda.pcb_PrimitiveVia.getAll(),pours=await eda.pcb_PrimitivePour.getAll();
     if([...lines,...arcs,...fills,...vias,...pours].some(x=>affectedNets.includes(state(x,'net'))))throw Error('Connected nets already contain copper; use relayout with explicit replan and affectedNets');
    }else if(affectedNets.some(n=>!op.affectedNets.includes(n)))throw Error('affectedNets must cover every net of the moved component');
   }
   const before=plain(current,op.kind),beforePolygon=['fill','polyline'].includes(op.kind)?sourceOf(current):undefined;let returned=null;
   await guard();current=await readOne(api,op.kind,op.primitiveId);already=current&&desiredMatches(current);if(!already&&(!expectedMatches(current)||(state(current,'primitiveLock')&&op.set.primitiveLock!==false)))throw Error('Old-value assertion failed after asynchronous preflight');
   if(!already){
    let nativeSet=op.set;
    if(['fill','polyline'].includes(op.kind)&&op.polygon){const polygon=eda.pcb_MathPolygon.createPolygon(op.polygon);if(!polygon)throw Error('Invalid polygon source');nativeSet={...op.set,...(op.kind==='fill'?{complexPolygon:polygon}:{polygon})};}
    returned=await api.modify(op.primitiveId,nativeSet);
   }
   await guard();const actualId=id(returned)||op.primitiveId;current=await readOne(api,op.kind,actualId);
   if(!desiredMatches(current)){
    if(op.kind!=='line'||!await lineRead({...desired,primitiveLock:desired.primitiveLock??false}))throw Error('Modification failed independent readback; reconcile actual IDs and geometry');
   }
   const result={id:op.id,status:already?'already_modified':'modified',primitiveId:actualId,before,after:current?plain(current,op.kind):desired,...(beforePolygon?{beforePolygon}:{}),...(['fill','polyline'].includes(op.kind)?{afterPolygon:sourceOf(current)}:{}),verified:true,requiresRepour:!already};
   if(op.kind==='component'){
    const pads=await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(actualId);if(!Array.isArray(pads))throw Error('Moved component pads unavailable');
    if(beforePinMap!==pinMap(pads))throw Error('Unexpected per-pad pin-net change while moving component; reconcile live state before retry');
    result.affectedNets=affectedNets;result.requiresConnectivityCheck=true;result.pads=pads.map(p=>({primitiveId:id(p),padNumber:state(p,'padNumber'),net:state(p,'net'),x:state(p,'x'),y:state(p,'y'),layer:state(p,'layer')}));
   }
   results.push(result);
  }catch(error){return {ok:false,results,error:{operationId:op.id,message:String(error.message??error)},completedCount:results.length};}
 }
 if (job.checkpoint) await job.checkpoint(results);
  return {ok:true,results,completedCount:results.length};
}
export const buildReadCode = request => `const r=await (${readRuntime.toString()})(eda,${JSON.stringify(request)});const t=${JSON.stringify(request.target ?? null)};if(t){const d=await eda.dmt_SelectControl.getCurrentDocumentInfo();if(d?.uuid!==t.documentUuid||d?.documentType!==3)throw Error('PCB document changed during read');if(t.projectUuid&&(await eda.dmt_Project.getCurrentProjectInfo())?.uuid!==t.projectUuid)throw Error('PCB project changed during read');}return r;`;
export const buildBatchCode = job => `return await (${batchRuntime.toString()})(eda,${JSON.stringify(job)});`;
