import { auditGeometry } from './audit.mjs';
import { arcBounds, describeArc, pointToArcDistance } from './arc-geometry.mjs';
// Explicit geometry only: no placement optimization and no path search.
export const VERSION = '2.2.0';
export const LAYERS = Object.freeze({ TOP:1, BOTTOM:2, TOP_SILKSCREEN:3, BOTTOM_SILKSCREEN:4, BOARD_OUTLINE:11, MULTI:12, ...Object.fromEntries(Array.from({length:30},(_,i)=>[`INNER_${i+1}`,15+i])) });
export const COPPER = new Set(['TOP','BOTTOM',...Array.from({length:30},(_,i)=>`INNER_${i+1}`)]);
const FIELDS = {
 line:['net','layer','startX','startY','endX','endY','lineWidth','primitiveLock'],
 arc:['net','layer','startX','startY','endX','endY','arcAngle','lineWidth','interactiveMode','primitiveLock'],
 polyline:['net','layer','lineWidth','primitiveLock'],
 pad:['layer','padNumber','x','y','rotation','pad','net','hole','holeOffsetX','holeOffsetY','holeRotation','metallization','padType','primitiveLock'],
 via:['net','x','y','holeDiameter','diameter','viaType','primitiveLock'],
 component:['x','y','rotation','layer','primitiveLock'],
 pour:['net','layer','pourName','pourPriority','preserveSilos','lineWidth','primitiveLock'],
 fill:['net','layer','fillMode','lineWidth','primitiveLock'],
 stackup:['copperLayerCount'],
};
const REQUIRED = {line:['net','layer','startX','startY','endX','endY','lineWidth'],arc:['net','layer','startX','startY','endX','endY','arcAngle','lineWidth','interactiveMode'],polyline:['net','layer','lineWidth'],pad:['layer','padNumber','x','y','rotation','pad','net','hole','holeOffsetX','holeOffsetY','holeRotation','metallization','padType','primitiveLock'],via:['net','x','y','holeDiameter','diameter','viaType'],component:['x','y','rotation','layer'],pour:['net','layer','pourName'],fill:['net','layer','fillMode','lineWidth'],stackup:['copperLayerCount']};
const LENGTHS = new Set(['x','y','startX','startY','endX','endY','lineWidth','holeDiameter','diameter','holeOffsetX','holeOffsetY']);
const PAD_TYPES = Object.freeze({NORMAL:0,TEST:1,MARK_POINT:2});
const PAD_SHAPES = new Set(['ELLIPSE','OVAL','RECT','NGON','POLYGON']);
export const assert = (ok,msg) => { if(!ok) throw new Error(msg); };
const number = (v,label) => {assert(typeof v==='number'&&Number.isFinite(v),`${label}: finite number required`);return v;};
const string = (v,label,empty=false) => {assert(typeof v==='string'&&(empty||v.trim()),`${label}: string required`);return v;};
const object = (v,label) => {assert(v&&typeof v==='object'&&!Array.isArray(v),`${label}: object required`);return v;};
const keys = (v,allowed,label) => {object(v,label);for(const k of Object.keys(v))assert(allowed.includes(k),`${label}: unknown field ${k}`);};
const point = (v,scale,label) => {assert(Array.isArray(v)&&v.length===2,`${label}: [x,y] required`);return v.map(x=>number(x,label)*scale);};
const layer = (v,outline=false) => {string(v,'layer');assert(COPPER.has(v)||(outline&&v==='BOARD_OUTLINE'),`Unsupported layer ${v}`);return LAYERS[v];};
const padLayer = (v,expected=false) => {if(expected&&typeof v==='number'){assert([1,2,12].includes(v),'Pad layer must be TOP, BOTTOM or MULTI');return v;}string(v,'pad layer');assert(['TOP','BOTTOM','MULTI'].includes(v),`Unsupported pad layer ${v}`);return LAYERS[v];};
const padType = (v,expected=false) => {if(v===undefined)return 0;if(expected&&typeof v==='number'){assert([0,1,2].includes(v),'Unsupported padType');return v;}string(v,'padType');assert(v in PAD_TYPES,`Unsupported padType ${v}`);return PAD_TYPES[v];};
function padShape(v,scale,label='pad'){
 if(Array.isArray(v)){
  const type=string(v[0],`${label}.type`);assert(PAD_SHAPES.has(type),`${label}: unsupported shape ${type}`);
  if(['ELLIPSE','OVAL'].includes(type)){assert(v.length===3,`${label}: ${type} width and height required`);return [type,number(v[1],`${label}.width`)*scale,number(v[2],`${label}.height`)*scale];}
  if(type==='RECT'){assert(v.length===4,`${label}: RECT width, height and round required`);return [type,number(v[1],`${label}.width`)*scale,number(v[2],`${label}.height`)*scale,number(v[3],`${label}.round`)*scale];}
  if(type==='NGON'){assert(v.length===3,`${label}: NGON diameter and sides required`);const sides=number(v[2],`${label}.sides`);assert(Number.isInteger(sides)&&sides>=3&&sides<=64,`${label}: NGON sides must be 3..64`);return [type,number(v[1],`${label}.diameter`)*scale,sides];}
  assert(type==='POLYGON'&&v.length===2,`${label}: POLYGON source required`);return [type,polygonSource(simplePolygonFromSource(v[1],scale,`${label}.polygon`))];
 }
 object(v,label);const type=string(v.type,`${label}.type`);assert(PAD_SHAPES.has(type),`${label}: unsupported shape ${type}`);
 if(['ELLIPSE','OVAL'].includes(type)){keys(v,['type','width','height'],label);return [type,number(v.width,`${label}.width`)*scale,number(v.height,`${label}.height`)*scale];}
 if(type==='RECT'){keys(v,['type','width','height','round'],label);return [type,number(v.width,`${label}.width`)*scale,number(v.height,`${label}.height`)*scale,number(v.round??0,`${label}.round`)*scale];}
 if(type==='NGON'){keys(v,['type','diameter','sides'],label);const sides=number(v.sides,`${label}.sides`);assert(Number.isInteger(sides)&&sides>=3&&sides<=64,`${label}: NGON sides must be 3..64`);return [type,number(v.diameter,`${label}.diameter`)*scale,sides];}
 keys(v,['type','points'],label);return [type,polygonSource(polygonPoints(v.points,scale,`${label}.points`,1e-9))];
}
function padHole(v,scale,label='hole'){
 if(v===null||v===undefined)return null;
 if(Array.isArray(v)){
  assert((v[0]==='ROUND'&&v.length===2)||(v[0]==='SLOT'&&v.length===3),`${label}: ROUND diameter or SLOT diameter/length required`);
  const out=[v[0],...v.slice(1).map((x,i)=>number(x,`${label}[${i+1}]`)*scale)];if(out[0]==='SLOT')assert(out[2]>=out[1],`${label}: slot length must be >= diameter`);return out;
 }
 keys(v,['type','diameter','length'],label);const type=string(v.type,`${label}.type`);assert(['ROUND','SLOT'].includes(type),`${label}: unsupported hole type ${type}`);
 const diameter=number(v.diameter,`${label}.diameter`)*scale;assert(diameter>0,`${label}: positive diameter required`);if(type==='ROUND')return ['ROUND',diameter];
 const length=number(v.length,`${label}.length`)*scale;assert(length>=diameter,`${label}: slot length must be >= diameter`);return ['SLOT',diameter,length];
}
export function segment(a,b,tol=0.02,fortyFive=true) {
 const dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy);
 assert(len>tol,'Zero-length segment');
 if(fortyFive)assert(Math.abs(dx)<=tol||Math.abs(dy)<=tol||Math.abs(Math.abs(dx)-Math.abs(dy))<=tol,'Copper segment must be horizontal, vertical or 45 degrees');
 return [Math.abs(dx)<=tol?0:Math.sign(dx),Math.abs(dy)<=tol?0:Math.sign(dy)];
}
function pointSegmentDistance(point,a,b){
 const dx=b[0]-a[0],dy=b[1]-a[1],length2=dx*dx+dy*dy;
 if(!length2)return Math.hypot(point[0]-a[0],point[1]-a[1]);
 const t=Math.max(0,Math.min(1,((point[0]-a[0])*dx+(point[1]-a[1])*dy)/length2));
 return Math.hypot(point[0]-(a[0]+t*dx),point[1]-(a[1]+t*dy));
}
function orientation(a,b,c){return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);}
function properIntersection(a,b,c,d,tol){
 const abC=orientation(a,b,c),abD=orientation(a,b,d),cdA=orientation(c,d,a),cdB=orientation(c,d,b);
 if(Math.abs(abC)<=tol||Math.abs(abD)<=tol||Math.abs(cdA)<=tol||Math.abs(cdB)<=tol)return false;
 return Math.sign(abC)!==Math.sign(abD)&&Math.sign(cdA)!==Math.sign(cdB);
}
function polygonPoints(input,scale,label,tol){
 assert(Array.isArray(input)&&input.length>=3&&input.length<=2000,`${label}: 3..2000 points required`);
 const points=input.map(value=>point(value,scale,label));
 if(Math.hypot(points[0][0]-points.at(-1)[0],points[0][1]-points.at(-1)[1])<=tol)points.pop();
 assert(points.length>=3,`${label}: 3 distinct points required`);
 for(let i=0;i<points.length;i++)segment(points[i],points[(i+1)%points.length],tol,false);
 let area=0;for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length];area+=a[0]*b[1]-b[0]*a[1];}
 assert(Math.abs(area)>tol,`${label}: degenerate polygon`);
 for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++){
  const adjacent=j===i||j===(i+1)%points.length||i===(j+1)%points.length;
  if(!adjacent&&properIntersection(points[i],points[(i+1)%points.length],points[j],points[(j+1)%points.length],tol))throw new Error(`${label}: self-intersecting polygon`);
 }
 return points;
}
function pointInPolygon(pointValue,points){
 let inside=false;
 for(let i=0,j=points.length-1;i<points.length;j=i++){
  const a=points[i],b=points[j];
  if(pointSegmentDistance(pointValue,a,b)<=1e-9)return true;
  if((a[1]>pointValue[1])!==(b[1]>pointValue[1])&&pointValue[0]<(b[0]-a[0])*(pointValue[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
 }
 return inside;
}
function polygonIntersectsCircle(points,circle){
 const center=[circle.x,circle.y];
 if(pointInPolygon(center,points))return true;
 for(let i=0;i<points.length;i++)if(pointSegmentDistance(center,points[i],points[(i+1)%points.length])+1e-9<circle.radius)return true;
 return false;
}
const polygonSource=points=>[...points[0],'L',...points.slice(1).flat(),...points[0]];
function simplePolygonFromSource(source,scale,label){
 if(Array.isArray(source)&&source.length===1&&Array.isArray(source[0]))source=source[0];
 assert(Array.isArray(source),`${label}: polygon source array required`);
 const numbers=[];for(const token of source){if(token==='L')continue;assert(typeof token==='number'&&Number.isFinite(token),`${label}: only simple L polygon sources are supported`);numbers.push(token);}
 assert(numbers.length>=6&&numbers.length%2===0,`${label}: at least three coordinate pairs required`);
 const points=[];for(let i=0;i<numbers.length;i+=2)points.push([numbers[i],numbers[i+1]]);
 return polygonPoints(points,scale,label,1e-9);
}
function normalizeFields(input,kind,scale,expected=false) {
 const allowed=expected?[...FIELDS[kind],'designator']:FIELDS[kind];keys(input,allowed,`${kind} properties`);
 const out={};for(const [k,v]of Object.entries(input)) {
  if(LENGTHS.has(k))out[k]=number(v,k)*scale;
  else if(k==='layer')out[k]=kind==='pad'?padLayer(v,expected):typeof v==='number'&&expected?number(v,k):layer(v,kind==='line'||kind==='polyline');
  else if(k==='pad')out[k]=padShape(v,scale,k);
  else if(k==='hole')out[k]=padHole(v,scale,k);
  else if(k==='padType')out[k]=padType(v,expected);
  else if(k==='net'||k==='designator'||k==='pourName'||k==='padNumber')out[k]=string(v,k,k==='net'||k==='padNumber');
  else if(k==='primitiveLock'||k==='preserveSilos'||k==='metallization'){assert(typeof v==='boolean',`${k}: boolean required`);out[k]=v;}
  else out[k]=number(v,k);
 }
 if(kind==='component'&&out.layer!==undefined)assert([1,2].includes(out.layer),'Components must be on TOP or BOTTOM');
 if(expected)for(const k of REQUIRED[kind])assert(k in out,`${kind}.expected.${k} required`);
 return out;
}
function validateState(kind,s,plan) {
 const c=plan.constraints,t=plan.options.toleranceMil;
 if(kind==='line') {
  assert(s.lineWidth>0,'Positive lineWidth required');
  segment([s.startX,s.startY],[s.endX,s.endY],t,c.noRightAngle&&s.layer!==11);
  if(s.layer!==11)assert(s.lineWidth+t>=c.minTrackWidth,'Track narrower than specified manufacturing minimum');
 }
 if(kind==='arc'){
  assert(s.lineWidth>0,'Positive arc lineWidth required');
  assert([1,2].includes(s.interactiveMode),'Arc interactiveMode must be 1 or 2');
  const arc=describeArc(s,t);
  assert(s.lineWidth+t>=c.minTrackWidth,'Arc narrower than specified manufacturing minimum');
  if(c.boardBounds){const b=arcBounds(arc,s.lineWidth/2);assert(b.minX>=c.boardBounds.minX-t&&b.maxX<=c.boardBounds.maxX+t&&b.minY>=c.boardBounds.minY-t&&b.maxY<=c.boardBounds.maxY+t,'Arc exceeds supplied rectangular boardBounds');}
 }
 if(kind==='polyline'){assert(s.layer===11,'Polyline geometry is reserved for BOARD_OUTLINE');assert(s.lineWidth>0,'Positive lineWidth required');}
 if(kind==='fill'){assert(s.fillMode===0,'Typed executor supports SOLID fillMode only');assert(s.lineWidth>0,'Positive fill lineWidth required');}
 if(kind==='stackup'){assert(Number.isInteger(s.copperLayerCount)&&s.copperLayerCount>=2&&s.copperLayerCount<=32&&s.copperLayerCount%2===0,'copperLayerCount must be an even integer from 2 to 32');}
 if(kind==='pad'){
  assert([1,2,12].includes(s.layer),'Pad layer must be TOP, BOTTOM or MULTI');assert(Array.isArray(s.pad)&&PAD_SHAPES.has(s.pad[0]),'Supported pad shape required');
  const shapeType=s.pad[0];let width=null,height=null;
  if(shapeType==='POLYGON'){
   simplePolygonFromSource(s.pad[1],1,'pad polygon');
   assert(s.hole===null,'Custom polygon pads currently support SMD copper only; drilled custom pads need a separately verified annular-ring model');
  }else if(shapeType==='NGON'){
   width=height=s.pad[1];assert(width>0&&Number.isInteger(s.pad[2])&&s.pad[2]>=3&&s.pad[2]<=64,'Invalid NGON pad');
  }else{
   width=s.pad[1];height=s.pad[2];assert(width>0&&height>0,'Positive pad width and height required');if(shapeType==='RECT')assert(s.pad[3]>=0&&s.pad[3]<=Math.min(width,height)/2,'Invalid pad corner radius');
  }
  assert([0,1,2].includes(s.padType),'Unsupported pad type');assert(typeof s.metallization==='boolean','Pad metallization boolean required');
  if(s.hole===null){assert([1,2].includes(s.layer),'A pad without a drill must be on TOP or BOTTOM');}
  else {
   assert(shapeType!=='POLYGON','Drilled custom polygon pads are unsupported');
   assert(s.layer===12,'A drilled pad must be on MULTI');const diameter=s.hole[1],length=s.hole[0]==='SLOT'?s.hole[2]:diameter;assert(diameter>0&&length>=diameter,'Invalid pad drill');
   const usableX=width-2*Math.abs(s.holeOffsetX),usableY=height-2*Math.abs(s.holeOffsetY);let radial,longitudinal;
   if(s.hole[0]==='ROUND'){radial=Math.min((usableX-diameter)/2,(usableY-diameter)/2);longitudinal=radial;}
   else {const angle=((s.holeRotation%180)+180)%180;assert(Math.abs(angle)<=t||Math.abs(angle-90)<=t,'Slot holeRotation must be 0 or 90 degrees');const vertical=Math.abs(angle)<=t;radial=((vertical?usableX:usableY)-diameter)/2;longitudinal=((vertical?usableY:usableX)-length)/2;}
   assert(radial>=-t&&longitudinal>=-t,'Pad copper shape is smaller than its drill');
   if(s.metallization){assert(radial+t>=c.minAnnularRing&&longitudinal+t>=c.minAnnularRing,'Pad annular ring below specified minimum');}
   else assert(s.net==='','A non-plated mechanical hole cannot carry a network');
  }
 }
 if(kind==='via') {
  assert(s.diameter>s.holeDiameter&&s.holeDiameter>0,'Via requires diameter > holeDiameter > 0');
  assert(s.holeDiameter+t>=c.minViaHole,'Via hole below specified minimum');
  assert((s.diameter-s.holeDiameter)/2+t>=c.minAnnularRing,'Via annular ring below specified minimum');
  assert(s.viaType===0,'Typed executor currently supports through vias only; blind/buried require separately verified layer-span rules');
 }
 if(s.layer!==undefined&&s.layer!==11&&!['component','pad'].includes(kind)) {
  assert(c.allowedLayers.includes(s.layer),'Layer is outside this plan stackup');
  const allowedNets=c.reservedLayers[s.layer];if(allowedNets)assert(allowedNets.includes(s.net),`Reserved plane layer ${s.layer} rejects net ${s.net}`);
 }
 const nr=c.netRules?.[s.net];
 if(nr&&['pour','fill'].includes(kind)&&nr.allowedLayers)assert(nr.allowedLayers.includes(s.layer),`Net ${s.net}: layer outside netRules.allowedLayers`);
 if(nr&&['line','arc'].includes(kind)&&s.layer!==11){
  if(nr.minTrackWidth!==undefined)assert(s.lineWidth+t>=nr.minTrackWidth,`Net ${s.net}: trace below netRules.minTrackWidth`);
  if(nr.allowedLayers)assert(nr.allowedLayers.includes(s.layer),`Net ${s.net}: layer outside netRules.allowedLayers`);
 }
 if(nr&&kind==='via'){
  if(nr.minViaHole!==undefined)assert(s.holeDiameter+t>=nr.minViaHole,`Net ${s.net}: hole below netRules.minViaHole`);
  if(nr.minViaDiameter!==undefined)assert(s.diameter+t>=nr.minViaDiameter,`Net ${s.net}: diameter below netRules.minViaDiameter`);
  if(nr.minAnnularRing!==undefined)assert((s.diameter-s.holeDiameter)/2+t>=nr.minAnnularRing,`Net ${s.net}: annulus below netRules.minAnnularRing`);
 }
 const bounds=c.boardBounds;
 for(const circle of c.circularKeepouts??[]){
  if(kind!=='via'&&!(kind==='line'&&s.layer!==11)&&kind!=='arc')continue;
  let distance;
  if(kind==='via')distance=Math.hypot(s.x-circle.x,s.y-circle.y)-s.diameter/2;
  else if(kind==='arc')distance=pointToArcDistance(circle.x,circle.y,describeArc(s,t))-s.lineWidth/2;
  else {const dx=s.endX-s.startX,dy=s.endY-s.startY;const u=Math.max(0,Math.min(1,((circle.x-s.startX)*dx+(circle.y-s.startY)*dy)/(dx*dx+dy*dy)));distance=Math.hypot(s.startX+u*dx-circle.x,s.startY+u*dy-circle.y)-s.lineWidth/2;}
  assert(distance+1e-9>=circle.radius,`Copper intersects mechanical circular keepout ${circle.name}`);
 }
 const pts=kind==='line'?[[s.startX,s.startY],[s.endX,s.endY]]:('x'in s&&'y'in s)?[[s.x,s.y]]:[];
 if(bounds)for(const [x,y]of pts){const r=kind==='via'?s.diameter/2:kind==='pad'?Math.max(s.pad[1],s.pad[2])/2:kind==='line'&&s.layer!==11?s.lineWidth/2:0;assert(x-r>=bounds.minX-t&&x+r<=bounds.maxX+t&&y-r>=bounds.minY-t&&y+r<=bounds.maxY+t,'Geometry exceeds supplied rectangular boardBounds');}
}
export function validatePlan(raw) {
 keys(raw,['schema','intent','target','units','phase','constraints','options','operations'],'plan');
 assert(raw.schema==='easyeda-pcb-plan/v2','Expected easyeda-pcb-plan/v2');
 string(raw.intent,'intent');assert(raw.intent.length<=1000,'intent too long');
 keys(raw.target,['documentUuid','projectUuid','windowId'],'target');string(raw.target.documentUuid,'target.documentUuid');
 for(const k of ['projectUuid','windowId'])if(raw.target[k]!==undefined)string(raw.target[k],`target.${k}`);
 assert(['mil','mm'].includes(raw.units),'Explicit units mil or mm required');
 assert(['layout','trial-route','route','relayout','finish'].includes(raw.phase),'Explicit phase required');
 const scale=raw.units==='mm'?1/0.0254:1;
 const rc=raw.constraints??{},ro=raw.options??{};
 keys(rc,['noRightAngle','minTrackWidth','minViaHole','minAnnularRing','allowedLayers','reservedLayers','boardBounds','fixedComponents','topOnlyExcept','netRules','circularKeepouts'],'constraints');
 keys(ro,['batchSize','saveAfterBatch','toleranceMil'],'options');
 const constraints={noRightAngle:rc.noRightAngle!==false,minTrackWidth:number(rc.minTrackWidth??0,'minTrackWidth')*scale,minViaHole:number(rc.minViaHole??0,'minViaHole')*scale,minAnnularRing:number(rc.minAnnularRing??0,'minAnnularRing')*scale,allowedLayers:(rc.allowedLayers??['TOP','BOTTOM']).map(x=>layer(x)),reservedLayers:{},boardBounds:null,fixedComponents:rc.fixedComponents??[],topOnlyExcept:rc.topOnlyExcept??null};
 for(const k of ['minTrackWidth','minViaHole','minAnnularRing'])assert(constraints[k]>=0,`${k} must be nonnegative`);
 for(const [k,v]of Object.entries(rc.reservedLayers??{})){assert(Array.isArray(v)&&v.every(n=>typeof n==='string'),'reservedLayers values must be net arrays');constraints.reservedLayers[layer(k)]=v;}
 for(const k of ['fixedComponents','topOnlyExcept'])if(constraints[k]!==null)assert(Array.isArray(constraints[k])&&constraints[k].every(n=>typeof n==='string'),`${k}: component-ID array required`);
 if(rc.boardBounds){keys(rc.boardBounds,['minX','maxX','minY','maxY'],'boardBounds');constraints.boardBounds=Object.fromEntries(Object.entries(rc.boardBounds).map(([k,v])=>[k,number(v,k)*scale]));const b=constraints.boardBounds;assert(b.minX<b.maxX&&b.minY<b.maxY,'Invalid boardBounds');}
 constraints.netRules=Object.create(null);
 assert(rc.circularKeepouts===undefined||(Array.isArray(rc.circularKeepouts)&&rc.circularKeepouts.length<=64),'circularKeepouts: at most 64 explicit circles');
 constraints.circularKeepouts=(rc.circularKeepouts??[]).map(item=>{keys(item,['name','center','diameter'],'circular keepout');const [x,y]=point(item.center,scale,'keepout center'),radius=number(item.diameter,'keepout diameter')*scale/2;assert(radius>0,'Positive keepout diameter required');return {name:string(item.name,'keepout name'),x,y,radius};});
 assert(new Set(constraints.circularKeepouts.map(c=>c.name)).size===constraints.circularKeepouts.length,'Duplicate circular keepout name');
 object(rc.netRules??{},'netRules');
 for(const [net,rule]of Object.entries(rc.netRules??{})){
  string(net,'netRules net');keys(rule,['minTrackWidth','minViaHole','minViaDiameter','minAnnularRing','allowedLayers'],'net rule');
  const out={};for(const k of ['minTrackWidth','minViaHole','minViaDiameter','minAnnularRing'])if(rule[k]!==undefined){out[k]=number(rule[k],`netRules.${net}.${k}`)*scale;assert(out[k]>=0,'Net rule minima must be nonnegative');}
  if(rule.allowedLayers!==undefined){assert(Array.isArray(rule.allowedLayers)&&rule.allowedLayers.length>0,'net rule allowedLayers requires nonempty array');out.allowedLayers=rule.allowedLayers.map(x=>layer(x));}
  constraints.netRules[net]=out;
 }
 if(ro.saveAfterBatch!==undefined)assert(typeof ro.saveAfterBatch==='boolean','saveAfterBatch: boolean required');
 const options={batchSize:ro.batchSize??24,saveAfterBatch:ro.saveAfterBatch!==false,toleranceMil:ro.toleranceMil??0.02};
 assert(Number.isInteger(options.batchSize)&&options.batchSize>=1&&options.batchSize<=100,'batchSize must be 1..100');
 assert(number(options.toleranceMil,'toleranceMil')>0&&options.toleranceMil<=0.1,'toleranceMil must be (0,0.1]');
 const plan={schema:raw.schema,intent:raw.intent,target:{...raw.target},units:'mil',inputUnits:raw.units,phase:raw.phase,constraints,options,operations:[],sourceOperationCount:raw.operations?.length};
 assert(Array.isArray(raw.operations)&&raw.operations.length>0&&raw.operations.length<=5000,'operations must contain 1..5000 items');
 const ids=new Set();
 for(const op of raw.operations){
  keys(op,['id','type','net','layer','points','expectedPoints','expectedPosition','expectedDiameter','width','start','end','angle','interactiveMode','fillMode','position','holeDiameter','diameter','locked','primitiveId','expected','set','copperPolicy','affectedNets','pourName','priority','priorityPolicy','preserveSilos','padNumber','rotation','shape','hole','holeOffset','holeRotation','metallization','padType'],'operation');
  string(op.id,'operation.id');assert(!ids.has(op.id),'Duplicate operation id');ids.add(op.id);
  if(op.type==='outline.create'){
   const width=number(op.width,'width')*scale;assert(width>0,'Positive outline width required');
   if(op.shape==='CIRCLE'){
    assert(op.points===undefined,'Circular outline uses position and diameter, not points');
    const [cx,cy]=point(op.position,scale,'outline center'),diameter=number(op.diameter,'diameter')*scale;assert(diameter>0,'Positive outline diameter required');
    const radius=diameter/2;
    if(constraints.boardBounds){const b=constraints.boardBounds,t=options.toleranceMil;assert(cx-radius>=b.minX-t&&cx+radius<=b.maxX+t&&cy-radius>=b.minY-t&&cy+radius<=b.maxY+t,'Circular outline exceeds supplied rectangular boardBounds');}
    plan.operations.push({id:op.id,type:'polyline.create',kind:'polyline',state:{net:'',layer:11,lineWidth:width,primitiveLock:!!op.locked},polygon:['CIRCLE',cx,cy,radius]});
   }else{
    assert(op.shape===undefined,'outline.create shape must be CIRCLE or omitted for a polygon');
    assert(op.position===undefined&&op.diameter===undefined,'Polygon outline uses points, not position or diameter');
    assert(Array.isArray(op.points)&&op.points.length>=3&&op.points.length<=2000,'Outline points: 3..2000 required');
    const pts=op.points.map(p=>point(p,scale,'outline point'));
    assert(pts.length>=3,'Outline needs >=3 vertices');
    if(Math.hypot(pts[0][0]-pts.at(-1)[0],pts[0][1]-pts.at(-1)[1])<=options.toleranceMil)pts.pop();
    assert(pts.length>=3,'Outline needs >=3 distinct vertices');
    let area=0;for(let i=0;i<pts.length;i++){const a=pts[i],b=pts[(i+1)%pts.length];segment(a,b,options.toleranceMil,false);area+=a[0]*b[1]-b[0]*a[1];}
    assert(Math.abs(area)>options.toleranceMil,'Degenerate outline polygon');
    if(constraints.boardBounds){const b=constraints.boardBounds,t=options.toleranceMil;for(const [x,y]of pts)assert(x>=b.minX-t&&x<=b.maxX+t&&y>=b.minY-t&&y<=b.maxY+t,'Outline vertices exceed supplied rectangular boardBounds');}
    plan.operations.push({id:op.id,type:'polyline.create',kind:'polyline',state:{net:'',layer:11,lineWidth:width,primitiveLock:!!op.locked},polygon:[...pts[0],'L',...pts.slice(1).flat(),...pts[0]]});
   }
  } else if(op.type==='route.create'){
   assert(op.shape===undefined&&op.position===undefined&&op.diameter===undefined,'route.create uses points only');
   assert(Array.isArray(op.points)&&op.points.length>=2&&op.points.length<=2000,'points: 2..2000 required');
   const pts=op.points.map(p=>point(p,scale,'route point'));
   const ds=pts.slice(1).map((p,i)=>segment(pts[i],p,options.toleranceMil,constraints.noRightAngle));
   if(constraints.noRightAngle)for(let i=1;i<ds.length;i++)assert(ds[i-1][0]*ds[i][0]+ds[i-1][1]*ds[i][1]>0,'Route contains 90/135/reverse corner');
   for(let i=1;i<pts.length;i++)plan.operations.push({id:`${op.id}#${i}`,type:'line.create',kind:'line',state:{net:string(op.net,'route.net'),layer:layer(op.layer),startX:pts[i-1][0],startY:pts[i-1][1],endX:pts[i][0],endY:pts[i][1],lineWidth:number(op.width,'width')*scale,primitiveLock:!!op.locked}});
  } else if(op.type==='line.create') {
   assert(op.layer!=='BOARD_OUTLINE','Use outline.create for BOARD_OUTLINE so the native Polyline API can verify a closed contour');
   const a=point(op.start,scale,'start'),b=point(op.end,scale,'end');plan.operations.push({id:op.id,type:op.type,kind:'line',state:{net:string(op.net,'net'),layer:layer(op.layer),startX:a[0],startY:a[1],endX:b[0],endY:b[1],lineWidth:number(op.width,'width')*scale,primitiveLock:!!op.locked}});
  } else if(op.type==='arc.create') {
   const a=point(op.start,scale,'start'),b=point(op.end,scale,'end');
   plan.operations.push({id:op.id,type:op.type,kind:'arc',state:{net:string(op.net,'net'),layer:layer(op.layer),startX:a[0],startY:a[1],endX:b[0],endY:b[1],arcAngle:number(op.angle,'angle'),lineWidth:number(op.width,'width')*scale,interactiveMode:number(op.interactiveMode??1,'interactiveMode'),primitiveLock:!!op.locked}});
  } else if(op.type==='via.create') {
   const p=point(op.position,scale,'position');plan.operations.push({id:op.id,type:op.type,kind:'via',state:{net:string(op.net,'net'),x:p[0],y:p[1],holeDiameter:number(op.holeDiameter,'holeDiameter')*scale,diameter:number(op.diameter,'diameter')*scale,viaType:0,primitiveLock:!!op.locked}});
  } else if(op.type==='hole.create') {
   assert(op.net===undefined&&op.layer===undefined&&op.shape===undefined&&op.metallization===undefined&&op.padType===undefined&&op.holeOffset===undefined,'hole.create defines a bare NPTH only; use pad.create for copper, a net, custom shape or offset drill');
   const p=point(op.position,scale,'position'),hole=padHole(op.hole,scale,'hole');assert(hole!==null,'hole.create requires a drill');
   const shape=hole[0]==='ROUND'?['ELLIPSE',hole[1],hole[1]]:['OVAL',hole[1],hole[2]];
   plan.operations.push({id:op.id,type:'pad.create',kind:'pad',state:{layer:12,padNumber:string(op.padNumber??op.id,'padNumber',true),x:p[0],y:p[1],rotation:number(op.rotation??0,'rotation'),pad:shape,net:'',hole,holeOffsetX:0,holeOffsetY:0,holeRotation:number(op.holeRotation??0,'holeRotation'),metallization:false,padType:0,primitiveLock:!!op.locked}});
  } else if(op.type==='pad.create') {
   const p=point(op.position,scale,'position'),offset=op.holeOffset===undefined?[0,0]:point(op.holeOffset,scale,'holeOffset');
   plan.operations.push({id:op.id,type:op.type,kind:'pad',state:{layer:padLayer(op.layer),padNumber:string(op.padNumber,'padNumber',true),x:p[0],y:p[1],rotation:number(op.rotation??0,'rotation'),pad:padShape(op.shape,scale,'shape'),net:string(op.net??'','net',true),hole:padHole(op.hole,scale,'hole'),holeOffsetX:offset[0],holeOffsetY:offset[1],holeRotation:number(op.holeRotation??0,'holeRotation'),metallization:op.metallization!==false,padType:padType(op.padType),primitiveLock:!!op.locked}});
  } else if(op.type==='pour.create'){
   const priorityPolicy=op.priorityPolicy??(op.priority===undefined?'native':'exact');assert(['native','exact'].includes(priorityPolicy),'priorityPolicy must be native or exact');assert(!(priorityPolicy==='native'&&op.priority!==undefined),'Native priority policy cannot also specify an exact priority');if(priorityPolicy==='exact')number(op.priority,'priority');
   const pts=op.points?.map(p=>point(p,scale,'pour point'));assert(pts&&pts.length>=3&&pts.length<=2000,'Pour needs 3..2000 vertices');
   if(constraints.boardBounds){const b=constraints.boardBounds,t=options.toleranceMil;for(const [x,y]of pts)assert(x>=b.minX-t&&x<=b.maxX+t&&y>=b.minY-t&&y<=b.maxY+t,'Pour vertices exceed supplied rectangular boardBounds');}
   assert(number(op.width??0.2/scale,'width')>0,'Positive pour outline width required');
   let area=0;for(let i=0;i<pts.length;i++){const a=pts[i],b=pts[(i+1)%pts.length];area+=a[0]*b[1]-b[0]*a[1];}assert(Math.abs(area)>options.toleranceMil,'Degenerate pour polygon');
   plan.operations.push({id:op.id,type:op.type,kind:'pour',priorityPolicy,state:{net:string(op.net,'net'),layer:layer(op.layer),pourName:string(op.pourName,'pourName'),...(priorityPolicy==='exact'?{pourPriority:number(op.priority,'priority')}:{}),preserveSilos:op.preserveSilos===true,lineWidth:number(op.width??0.2/scale,'width')*scale,primitiveLock:!!op.locked},polygon:[...pts[0],'L',...pts.slice(1).flat(),...pts[0]]});
  } else if(/^polyline\.(modify|delete)$/.test(op.type)){
   const action=op.type.split('.')[1],expected=normalizeFields(op.expected,'polyline',scale,true);assert(expected.layer===11&&expected.net==='','Board outline polyline identity must remain on BOARD_OUTLINE with an empty net');
   let expectedPolygon;
   if(op.expectedPoints!==undefined){
    assert(op.expectedPosition===undefined&&op.expectedDiameter===undefined,'Expected outline uses either expectedPoints or expectedPosition/expectedDiameter');
    expectedPolygon=polygonSource(polygonPoints(op.expectedPoints,scale,'expected outline points',options.toleranceMil));
   }else{
    const [cx,cy]=point(op.expectedPosition,scale,'expected outline center'),diameter=number(op.expectedDiameter,'expectedDiameter')*scale;assert(diameter>0,'Positive expected outline diameter required');expectedPolygon=['CIRCLE',cx,cy,diameter/2];
   }
   if(action==='delete'){
    assert(op.set===undefined&&op.points===undefined&&op.position===undefined&&op.diameter===undefined&&op.shape===undefined,'polyline.delete accepts expected state and expected geometry only');
    plan.operations.push({id:op.id,type:op.type,kind:'polyline',primitiveId:string(op.primitiveId,'primitiveId'),expected,set:null,expectedPolygon});
   }else{
    const set=normalizeFields(op.set??{},'polyline',scale);assert(set.net===undefined||set.net==='','Board outline net cannot change');assert(set.layer===undefined||set.layer===11,'Board outline layer cannot change');
    const geometrySpecified=op.points!==undefined||op.position!==undefined||op.diameter!==undefined||op.shape!==undefined;let polygon;
    if(geometrySpecified){
     if(op.shape==='CIRCLE'){
      assert(op.points===undefined,'Circular outline modification uses position and diameter, not points');const [cx,cy]=point(op.position,scale,'outline center'),diameter=number(op.diameter,'diameter')*scale;assert(diameter>0,'Positive outline diameter required');polygon=['CIRCLE',cx,cy,diameter/2];
     }else{
      assert(op.shape===undefined&&op.position===undefined&&op.diameter===undefined,'Polygon outline modification uses points only');polygon=polygonSource(polygonPoints(op.points,scale,'outline points',options.toleranceMil));
     }
    }
    assert(Object.keys(set).length>0||polygon,'Empty polyline modification');
    const desiredPolygon=polygon??expectedPolygon;
    if(constraints.boardBounds){const b=constraints.boardBounds,t=options.toleranceMil;if(desiredPolygon[0]==='CIRCLE'){const [,cx,cy,radius]=desiredPolygon;assert(cx-radius>=b.minX-t&&cx+radius<=b.maxX+t&&cy-radius>=b.minY-t&&cy+radius<=b.maxY+t,'Circular outline exceeds supplied rectangular boardBounds');}else{const pts=[];for(const token of desiredPolygon){if(typeof token==='number')pts.push(token);}for(let i=0;i<pts.length;i+=2)assert(pts[i]>=b.minX-t&&pts[i]<=b.maxX+t&&pts[i+1]>=b.minY-t&&pts[i+1]<=b.maxY+t,'Outline vertices exceed supplied rectangular boardBounds');}}
    plan.operations.push({id:op.id,type:op.type,kind:'polyline',primitiveId:string(op.primitiveId,'primitiveId'),expected,set,expectedPolygon,...(polygon?{polygon}:{})});
   }
  } else if(op.type==='fill.create'){
   const fillMode=op.fillMode===undefined||op.fillMode==='SOLID'||op.fillMode===0?0:null;assert(fillMode===0,'fillMode must be SOLID or 0');
   const pts=polygonPoints(op.points,scale,'fill points',options.toleranceMil);
   if(constraints.boardBounds){const b=constraints.boardBounds,t=options.toleranceMil;for(const [x,y]of pts)assert(x>=b.minX-t&&x<=b.maxX+t&&y>=b.minY-t&&y<=b.maxY+t,'Fill vertices exceed supplied rectangular boardBounds');}
   for(const circle of constraints.circularKeepouts)assert(!polygonIntersectsCircle(pts,circle),`Fill intersects mechanical circular keepout ${circle.name}`);
   plan.operations.push({id:op.id,type:op.type,kind:'fill',state:{net:string(op.net,'net'),layer:layer(op.layer),fillMode,lineWidth:number(op.width??0.2/scale,'width')*scale,primitiveLock:!!op.locked},polygon:polygonSource(pts)});
  } else if(/^(fill)\.(modify|delete)$/.test(op.type)){
   const action=op.type.split('.')[1],expected=normalizeFields(op.expected,'fill',scale,true);
   const expectedPts=polygonPoints(op.expectedPoints,scale,'expected fill points',options.toleranceMil),expectedPolygon=polygonSource(expectedPts);
   if(action==='delete'){
    assert(op.set===undefined&&op.points===undefined,'fill.delete accepts expected state and expectedPoints only');
    plan.operations.push({id:op.id,type:op.type,kind:'fill',primitiveId:string(op.primitiveId,'primitiveId'),expected,set:null,expectedPolygon});
   }else{
    const set=normalizeFields(op.set??{},'fill',scale),pts=op.points===undefined?null:polygonPoints(op.points,scale,'fill points',options.toleranceMil);
    assert(Object.keys(set).length>0||pts,'Empty fill modification');
    const desiredPts=pts??expectedPts;
    if(constraints.boardBounds){const b=constraints.boardBounds,t=options.toleranceMil;for(const [x,y]of desiredPts)assert(x>=b.minX-t&&x<=b.maxX+t&&y>=b.minY-t&&y<=b.maxY+t,'Fill vertices exceed supplied rectangular boardBounds');}
    for(const circle of constraints.circularKeepouts)assert(!polygonIntersectsCircle(desiredPts,circle),`Fill intersects mechanical circular keepout ${circle.name}`);
    plan.operations.push({id:op.id,type:op.type,kind:'fill',primitiveId:string(op.primitiveId,'primitiveId'),expected,set,expectedPolygon,...(pts?{polygon:polygonSource(pts)}:{})});
   }
  } else if(op.type==='stackup.modify'){
   assert(['layout','relayout'].includes(plan.phase),'Stackup changes require layout or relayout phase');
   const expected=normalizeFields(op.expected,'stackup',scale,true),set=normalizeFields(op.set,'stackup',scale);
   assert(Object.keys(set).length===1&&set.copperLayerCount!==undefined,'stackup.modify requires set.copperLayerCount');
   assert(set.copperLayerCount>=expected.copperLayerCount,'Copper layer reduction is intentionally unsupported; use the native UI after reviewing inner-layer copper');
   plan.operations.push({id:op.id,type:op.type,kind:'stackup',primitiveId:'PCB_STACKUP',expected,set});
  } else if(/^(line|arc|pad|via|component|pour)\.(modify|delete)$/.test(op.type)){
   const [kind,action]=op.type.split('.');assert(!(kind==='component'&&action==='delete'),'Component deletion belongs to explicit netlist/ECO workflow');
   const expected=normalizeFields(op.expected,kind,scale,true),set=action==='modify'?normalizeFields(op.set,kind,scale):null;
   if(set)assert(Object.keys(set).length>0,'Empty modification');
   const n={id:op.id,type:op.type,kind,primitiveId:string(op.primitiveId,'primitiveId'),expected,set};
   if(kind==='component'){
    assert(['layout','relayout'].includes(plan.phase),'Component changes require layout or relayout phase');
    assert(!constraints.fixedComponents.includes(n.primitiveId),'Component is mechanically fixed');
    if(constraints.topOnlyExcept&&!constraints.topOnlyExcept.includes(n.primitiveId))assert((set.layer??expected.layer)===1,'Non-exempt component must stay on TOP');
    assert(['unrouted','replan'].includes(op.copperPolicy),'Component change requires copperPolicy unrouted or replan');
    n.copperPolicy=op.copperPolicy;n.affectedNets=op.affectedNets??[];assert(Array.isArray(n.affectedNets)&&n.affectedNets.every(x=>typeof x==='string'),'affectedNets must be string array');
   }
   plan.operations.push(n);
  } else throw new Error(`Unsupported operation ${op.type}`);
 }
 const stackupOperations=plan.operations.filter(operation=>operation.kind==='stackup');if(stackupOperations.length)assert(plan.operations.length===1&&stackupOperations.length===1,'stackup.modify must be the only operation in its guarded plan');
 assert(plan.operations.length<=20000,'Expanded operations exceed 20000');
 const expandedIds=new Set();for(const op of plan.operations){assert(!expandedIds.has(op.id),'Expanded operation IDs collide');expandedIds.add(op.id);if(op.state)validateState(op.kind,op.state,plan);else if(op.set)validateState(op.kind,{...op.expected,...op.set},plan);}
 // Cross-operation endpoint checks use neighbor-cell tolerance, avoiding rounding-bin misses.
 if(constraints.noRightAngle){
  const lines=plan.operations.filter(o=>o.type==='line.create').map(o=>({...o.state,primitiveId:o.id}));
  const arcs=plan.operations.filter(o=>o.type==='arc.create').map(o=>({...o.state,primitiveId:o.id}));
  const audit=auditGeometry({units:'mil',lines,arcs,pads:[],vias:[]},{toleranceMil:options.toleranceMil,detailLimit:0});
  assert(audit.counts.ordinaryBadJoints===0,'Separate straight or arc segments form a right/acute/reverse continuation; use a smooth tangent or chamfered route');
 }
 return plan;
}
export function planSummary(p){return {schema:p.schema,intent:p.intent,target:p.target,phase:p.phase,inputUnits:p.inputUnits,executionUnits:'mil',sourceOperationCount:p.sourceOperationCount,expandedOperationCount:p.operations.length,batchSize:p.options.batchSize,netRuleCount:Object.keys(p.constraints.netRules).length,operationCounts:p.operations.reduce((a,o)=>(a[o.type]=(a[o.type]??0)+1,a),{}),checks:['finite geometry','explicit units','target PCB UUID','expected old values','native circular or closed polygon outlines','45-degree copper policy','supplied layer/width/drill/annular/bounds constraints'],notChecked:['full native DRC','electrical connectivity','impedance/current/thermal performance','component body/courtyard collision','actual pour fill connectivity']};}
