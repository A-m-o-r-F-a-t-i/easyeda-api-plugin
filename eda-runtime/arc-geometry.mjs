const TAU = Math.PI * 2;

const finite = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label}: finite number required`);
  return value;
};
const normalizeAngle = angle => ((angle % TAU) + TAU) % TAU;

/** Resolve a signed two-point circular arc into its exact center/radius representation. */
export function describeArc({ startX, startY, endX, endY, arcAngle }, tolerance = 1e-9) {
  for (const [label, value] of Object.entries({ startX, startY, endX, endY, arcAngle })) finite(value, label);
  if (!(tolerance > 0) || !Number.isFinite(tolerance)) throw new Error('arc tolerance must be positive');
  const sweep = arcAngle * Math.PI / 180;
  if (Math.abs(sweep) <= tolerance || Math.abs(sweep) >= TAU - tolerance) throw new Error('Arc angle must be nonzero and strictly inside (-360, 360) degrees');
  const dx = endX - startX, dy = endY - startY;
  const chord = Math.hypot(dx, dy);
  if (chord <= tolerance) throw new Error('Arc endpoints must be distinct');
  const tangent = Math.tan(sweep / 2);
  if (Math.abs(tangent) <= tolerance) throw new Error('Arc geometry is numerically degenerate');
  const factor = 1 / (2 * tangent);
  const centerX = (startX + endX) / 2 - dy * factor;
  const centerY = (startY + endY) / 2 + dx * factor;
  const radius = Math.hypot(startX - centerX, startY - centerY);
  if (!(radius > tolerance) || !Number.isFinite(radius)) throw new Error('Arc radius is invalid');
  const startAngle = Math.atan2(startY - centerY, startX - centerX);
  return { startX, startY, endX, endY, arcAngle, sweep, centerX, centerY, radius, startAngle, endAngle: startAngle + sweep };
}

/** Whether a polar angle lies on the signed arc sweep. */
export function angleOnArc(angle, arc, tolerance = 1e-9) {
  const span = Math.abs(arc.sweep);
  const delta = arc.sweep > 0 ? normalizeAngle(angle - arc.startAngle) : normalizeAngle(arc.startAngle - angle);
  return delta <= span + tolerance;
}

/** Exact centerline bounds expanded by the requested stroke radius. */
export function arcBounds(arc, expansion = 0) {
  finite(expansion, 'arc bounds expansion');
  if (expansion < 0) throw new Error('arc bounds expansion must be nonnegative');
  const points = [[arc.startX, arc.startY], [arc.endX, arc.endY]];
  for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
    if (angleOnArc(angle, arc)) points.push([arc.centerX + arc.radius * Math.cos(angle), arc.centerY + arc.radius * Math.sin(angle)]);
  }
  return {
    minX: Math.min(...points.map(point => point[0])) - expansion,
    minY: Math.min(...points.map(point => point[1])) - expansion,
    maxX: Math.max(...points.map(point => point[0])) + expansion,
    maxY: Math.max(...points.map(point => point[1])) + expansion,
  };
}

/** Minimum distance from a point to the arc centerline. */
export function pointToArcDistance(x, y, arc) {
  finite(x, 'point x');
  finite(y, 'point y');
  const dx = x - arc.centerX, dy = y - arc.centerY;
  const radial = Math.hypot(dx, dy);
  if (radial > 0 && angleOnArc(Math.atan2(dy, dx), arc)) return Math.abs(radial - arc.radius);
  return Math.min(Math.hypot(x - arc.startX, y - arc.startY), Math.hypot(x - arc.endX, y - arc.endY));
}

/** Arc length and inward endpoint vectors used by geometry audits. */
export function arcEndpointVectors(arc) {
  const direction = Math.sign(arc.sweep);
  const startTangent = [-Math.sin(arc.startAngle) * direction, Math.cos(arc.startAngle) * direction];
  const endAngle = arc.startAngle + arc.sweep;
  const endTangent = [Math.sin(endAngle) * direction, -Math.cos(endAngle) * direction];
  const length = arc.radius * Math.abs(arc.sweep);
  return {
    length,
    start: { dx: startTangent[0] * length, dy: startTangent[1] * length },
    end: { dx: endTangent[0] * length, dy: endTangent[1] * length },
  };
}

/** Stable SVG path data for one native PCB arc. */
export function arcSvgPath(arc, format = value => String(value)) {
  const largeArc = Math.abs(arc.sweep) > Math.PI ? 1 : 0;
  const sweep = arc.sweep >= 0 ? 1 : 0;
  return `M ${format(arc.startX)} ${format(arc.startY)} A ${format(arc.radius)} ${format(arc.radius)} 0 ${largeArc} ${sweep} ${format(arc.endX)} ${format(arc.endY)}`;
}
