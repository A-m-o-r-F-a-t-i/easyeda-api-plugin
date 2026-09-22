// Read-only geometry review. Never routes, edits, repours, or certifies connectivity.
import { arcEndpointVectors, describeArc } from './arc-geometry.mjs';
const copper = l => Number.isInteger(l) && (l === 1 || l === 2 || l >= 15 && l <= 44);
const finite = (v, name) => { if (!Number.isFinite(v)) throw Error(`${name}: finite number required`); return v; };
const array = (v, name, optional=false) => {
  if (v === undefined && optional) return [];
  if (!Array.isArray(v) || v.length > 100000) throw Error(`${name}: array of at most 100000 objects required`);
  return v;
};
function indexPoints(points, tolerance) {
  const cells = new Map();
  for (const p of points) {
    const key = `${Math.floor(p.x/tolerance)},${Math.floor(p.y/tolerance)}`;
    const cell = cells.get(key) ?? []; cell.push(p); cells.set(key, cell);
  }
  return (x, y) => {
    const found=[], ix=Math.floor(x/tolerance), iy=Math.floor(y/tolerance);
    for(let a=-1;a<=1;a++) for(let b=-1;b<=1;b++) {
      for(const p of cells.get(`${ix+a},${iy+b}`)??[]) if(Math.hypot(p.x-x,p.y-y)<=tolerance) found.push(p);
    }
    return found;
  };
}
export function auditGeometry(snapshot, {toleranceMil=0.02, detailLimit=100}={}) {
  if(!snapshot || !['mil','mm'].includes(snapshot.units)) throw Error('snapshot.units must explicitly be mil or mm');
  if(!(finite(toleranceMil,'toleranceMil')>0 && toleranceMil<=0.1)) throw Error('toleranceMil must be (0,0.1]');
  if(!Number.isInteger(detailLimit)||detailLimit<0||detailLimit>5000) throw Error('detailLimit must be 0..5000');
  const scale=snapshot.units==='mm'?1/0.0254:1, t=toleranceMil;
  const rawLines=array(snapshot.lines,'lines'), rawArcs=array(snapshot.arcs,'arcs',true), rawPads=array(snapshot.pads,'pads',true), rawVias=array(snapshot.vias,'vias',true);
  const warnings=[];
  if(!Object.hasOwn(snapshot,'pads')) warnings.push('Pad centers unavailable: ordinary-joint classification is provisional');
  if(!Object.hasOwn(snapshot,'vias')) warnings.push('Via centers unavailable: ordinary-joint classification is provisional');
  if(!Object.hasOwn(snapshot,'arcs')) warnings.push('Arc geometry unavailable: joint and length statistics cover straight segments only');
  const non45=[], degenerate=[], ordinary=[], nodes=[], endpointList=[], stats=new Map();
  let ignoredNonCopper=0, ignoredNonCopperArcs=0, branchNodes=0, padNodes=0, viaNodes=0, ordinaryNodes=0;
  const pairCounts={ordinary:0,pad:0,via:0,branch:0};
  const stat=net=>{if(!stats.has(net))stats.set(net,{net,traceCount:0,straightTraceCount:0,arcTraceCount:0,segmentLengthSumMil:0,minTraceWidthMil:null,viaCount:0,minViaHoleMil:null});return stats.get(net);};
  const ids=new Set();
  const lines=rawLines.map((l,i)=>{
    if(!l || typeof l.net!=='string' || !Number.isInteger(l.layer)) throw Error(`lines[${i}]: net string and integer layer required`);
    const id=l.primitiveId??`input-line-${i}`;
    if(ids.has(id)) throw Error('Duplicate line primitiveId: '+id); ids.add(id);
    const s={id,net:l.net,layer:l.layer};
    for(const k of ['startX','startY','endX','endY','lineWidth'])s[k]=finite(l[k],`lines[${i}].${k}`)*scale;
    if(s.lineWidth<=0)throw Error(`lines[${i}]: positive lineWidth required`);
    return s;
  });
  const arcs=rawArcs.map((arc,i)=>{
    if(!arc||typeof arc.net!=='string'||!Number.isInteger(arc.layer))throw Error(`arcs[${i}]: net string and integer layer required`);
    const id=arc.primitiveId??`input-arc-${i}`;
    if(ids.has(id))throw Error('Duplicate copper primitiveId: '+id);ids.add(id);
    const value={id,net:arc.net,layer:arc.layer,interactiveMode:finite(arc.interactiveMode,`arcs[${i}].interactiveMode`),arcAngle:finite(arc.arcAngle,`arcs[${i}].arcAngle`)};
    for(const key of ['startX','startY','endX','endY','lineWidth'])value[key]=finite(arc[key],`arcs[${i}].${key}`)*scale;
    if(value.lineWidth<=0)throw Error(`arcs[${i}]: positive lineWidth required`);
    return value;
  });
  const centers=(items,name)=>items.map((p,i)=>{
    if(!p||typeof p.net!=='string')throw Error(`${name}[${i}]: net string required`);
    return {...p,x:finite(p.x,`${name}[${i}].x`)*scale,y:finite(p.y,`${name}[${i}].y`)*scale};
  });
  const pads=centers(rawPads,'pads'), vias=centers(rawVias,'vias');
  const padsNear=indexPoints(pads,t), viasNear=indexPoints(vias,t);
  for(const v of vias){const s=stat(v.net);s.viaCount++;if(Number.isFinite(v.holeDiameter)){const d=v.holeDiameter*scale;s.minViaHoleMil=s.minViaHoleMil===null?d:Math.min(s.minViaHoleMil,d);}}
  for(const l of lines){
    if(!copper(l.layer)){ignoredNonCopper++;continue;}
    const dx=l.endX-l.startX,dy=l.endY-l.startY,len=Math.hypot(dx,dy),s=stat(l.net);
    s.traceCount++;s.straightTraceCount++;s.segmentLengthSumMil+=len;s.minTraceWidthMil=s.minTraceWidthMil===null?l.lineWidth:Math.min(s.minTraceWidthMil,l.lineWidth);
    if(len<=t){degenerate.push(l);continue;}
    if(!(Math.abs(dx)<=t||Math.abs(dy)<=t||Math.abs(Math.abs(dx)-Math.abs(dy))<=t)) non45.push(l);
    endpointList.push({x:l.startX,y:l.startY,net:l.net,layer:l.layer,id:l.id,dx,dy,len});
    endpointList.push({x:l.endX,y:l.endY,net:l.net,layer:l.layer,id:l.id,dx:-dx,dy:-dy,len});
  }
  for(const arcItem of arcs){
    if(!copper(arcItem.layer)){ignoredNonCopperArcs++;continue;}
    let geometry;
    try{geometry=describeArc(arcItem,t);}catch(error){degenerate.push({...arcItem,kind:'arc',reason:error.message});continue;}
    const vectors=arcEndpointVectors(geometry),s=stat(arcItem.net);
    s.traceCount++;s.arcTraceCount++;s.segmentLengthSumMil+=vectors.length;s.minTraceWidthMil=s.minTraceWidthMil===null?arcItem.lineWidth:Math.min(s.minTraceWidthMil,arcItem.lineWidth);
    endpointList.push({x:arcItem.startX,y:arcItem.startY,net:arcItem.net,layer:arcItem.layer,id:arcItem.id,dx:vectors.start.dx,dy:vectors.start.dy,len:vectors.length,kind:'arc'});
    endpointList.push({x:arcItem.endX,y:arcItem.endY,net:arcItem.net,layer:arcItem.layer,id:arcItem.id,dx:vectors.end.dx,dy:vectors.end.dy,len:vectors.length,kind:'arc'});
  }
  // Neighbor cells avoid rounding-boundary misses. Cluster radius is tolerance around a representative.
  endpointList.sort((a,b)=>a.x-b.x||a.y-b.y||String(a.id).localeCompare(String(b.id)));
  const cells=new Map();
  for(const e of endpointList){
    const ix=Math.floor(e.x/t),iy=Math.floor(e.y/t);let match=null;
    for(let a=-1;a<=1&&!match;a++)for(let b=-1;b<=1&&!match;b++){
      const key=JSON.stringify([e.net,e.layer,ix+a,iy+b]);
      match=(cells.get(key)??[]).find(n=>Math.hypot(n.x-e.x,n.y-e.y)<=t)??null;
    }
    if(!match){match={x:e.x,y:e.y,net:e.net,layer:e.layer,ends:[]};nodes.push(match);const key=JSON.stringify([e.net,e.layer,ix,iy]);const group=cells.get(key)??[];group.push(match);cells.set(key,group);}
    match.ends.push(e);
  }
  const special=[];
  for(const n of nodes){
    if(n.ends.length<2)continue;
    const onPad=padsNear(n.x,n.y).some(p=>p.net===n.net&&(p.layer===n.layer||p.layer===12&&p.metallization===true));
    const onVia=viasNear(n.x,n.y).some(p=>p.net===n.net&&p.viaType===0);
    const category=onPad?'pad':onVia?'via':n.ends.length>2?'branch':'ordinary';
    if(category==='pad')padNodes++;else if(category==='via')viaNodes++;else if(category==='branch')branchNodes++;else ordinaryNodes++;
    if(n.ends.length>128){warnings.push('High-degree node omitted from angle pairs at '+n.x+','+n.y);continue;}
    let orthogonalPairs=0;
    for(let i=0;i<n.ends.length;i++)for(let j=i+1;j<n.ends.length;j++){
      const a=n.ends[i],b=n.ends[j],cos=(a.dx*b.dx+a.dy*b.dy)/(a.len*b.len);
      if(Math.abs(cos)<=0.00001){pairCounts[category]++;orthogonalPairs++;}
      if(category==='ordinary'&&cos>=-0.00001)ordinary.push({x:n.x,y:n.y,net:n.net,layer:n.layer,primitiveIds:[a.id,b.id],cosine:cos});
    }
    if(category!=='ordinary'&&orthogonalPairs)special.push({x:n.x,y:n.y,net:n.net,layer:n.layer,category,degree:n.ends.length,orthogonalPairs});
  }
  const findings=non45.length+degenerate.length+ordinary.length+special.length;
  return {ok:true,readOnly:true,scope:'supplied straight and circular-arc copper with coincident endpoint centers',units:'mil',inputUnits:snapshot.units,toleranceMil:t,
    verdict:findings||warnings.length?'REVIEW_REQUIRED':'NO_FINDINGS_IN_CHECKED_SCOPE',engineeringRelease:'NOT_EVALUATED',
    counts:{inputLines:rawLines.length,copperLines:rawLines.length-ignoredNonCopper,ignoredNonCopper,inputArcs:rawArcs.length,copperArcs:rawArcs.length-ignoredNonCopperArcs,ignoredNonCopperArcs,pads:pads.length,vias:vias.length,non45Segments:non45.length,degenerateSegments:degenerate.length,ordinaryBadJoints:ordinary.length,ordinaryNodes,padNodes,viaNodes,branchNodes,orthogonalPairs:pairCounts},
    details:{non45:non45.slice(0,detailLimit),degenerate:degenerate.slice(0,detailLimit),ordinaryBadJoints:ordinary.slice(0,detailLimit),specialOrthogonalNodes:special.slice(0,detailLimit)},
    detailLimit,detailsTruncated:[non45,degenerate,ordinary,special].some(x=>x.length>detailLimit),
    netStatistics:[...stats.values()].sort((a,b)=>a.net.localeCompare(b.net)),
    netStatisticsMeaning:'sum of straight and native circular-arc centerline lengths, NOT endpoint path length; no deduplication of overlapping geometry',
    inputCoverage:snapshot.coverage??null,warnings,
    notChecked:['native DRC and clearance','interior intersections and non-center pad/via contacts','teardrops and polygon/pour boundaries','actual fill connectivity and netlist completeness','end-to-end electrical length and impedance','current, temperature and power integrity','silkscreen, component body, courtyard and height']};
}
