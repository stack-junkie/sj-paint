// Source-space selection geometry. All matrices map source pixels to document coordinates.
import { resizeCursor } from './resize-cursor.js';
const HANDLES = [[0, 0], [.5, 0], [1, 0], [1, .5], [1, 1], [.5, 1], [0, 1], [0, .5]];
const clean = value => Math.abs(value - Math.round(value)) < 1e-10 ? Math.round(value) : value;
export const matrix = values => Object.freeze(values.map(clean));
export const translation = (x, y) => matrix([1, 0, 0, 1, x, y]);
export function multiply(left, right) {
  const [a, b, c, d, e, f] = left, [g, h, i, j, k, l] = right;
  return matrix([a*g+c*h, b*g+d*h, a*i+c*j, b*i+d*j, a*k+c*l+e, b*k+d*l+f]);
}
export const mapPoint = (m, [x, y]) => [m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5]];
export function inverse(m) {
  const [a, b, c, d, e, f] = m, determinant = a*d-b*c;
  if (!m.every(Number.isFinite) || Math.abs(determinant) < 1e-12) throw new RangeError('The selection transform must be finite and invertible.');
  return matrix([d/determinant, -b/determinant, -c/determinant, a/determinant,
    (c*f-d*e)/determinant, (b*e-a*f)/determinant]);
}
export function around(point, transform) {
  return multiply(translation(...point), multiply(transform, translation(-point[0], -point[1])));
}
export const rotation = angle => matrix([Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0]);
export function selectionGeometry(selection, zoom = 1) {
  const width = selection.canvas.width, height = selection.canvas.height, m = selection.transform;
  const point = ([x, y]) => mapPoint(m, [x*width, y*height]);
  const handles = HANDLES.map(point), corners = [handles[0], handles[2], handles[4], handles[6]];
  const xs = corners.map(p => clean(p[0])), ys = corners.map(p => clean(p[1]));
  const x = Math.floor(Math.min(...xs)), y = Math.floor(Math.min(...ys));
  const right = Math.ceil(Math.max(...xs)), bottom = Math.ceil(Math.max(...ys));
  const center = point([.5, .5]), top = handles[1];
  const direction = [top[0]-center[0], top[1]-center[1]], length = Math.hypot(...direction);
  const distance = 24 / (Number.isFinite(zoom) && zoom > 0 ? zoom : 1);
  return { corners, handles, center, bounds: { x, y, width: right-x, height: bottom-y },
    frameWidth: Math.hypot(m[0], m[1])*width, frameHeight: Math.hypot(m[2], m[3])*height,
    rotationHandle: [top[0]+direction[0]*distance/length, top[1]+direction[1]*distance/length] };
}
export function hitSelectionGeometry(selection, point, zoom = 1) {
  if (!Array.isArray(point) || !point.every(Number.isFinite)) return null;
  const geometry = selectionGeometry(selection, zoom), tolerance = 6/(Number.isFinite(zoom) && zoom > 0 ? zoom : 1);
  const distance = target => Math.hypot(target[0]-point[0], target[1]-point[1]);
  if (distance(geometry.rotationHandle) <= tolerance) return { kind: 'rotate' };
  let nearest = -1, minimum = Infinity;
  geometry.handles.forEach((handle, index) => {
    const d = distance(handle);
    if (d <= tolerance && d < minimum) { nearest = index; minimum = d; }
  });
  if (nearest >= 0) {
    const [horizontal, vertical] = HANDLES[nearest].map(value => value - .5);
    const [a, b, c, d] = selection.transform, sx = Math.hypot(a, b), sy = Math.hypot(c, d);
    return { kind: 'resize', index: nearest,
      cursor: resizeCursor([horizontal*a/sx + vertical*c/sy, horizontal*b/sx + vertical*d/sy]) };
  }
  const [x, y] = mapPoint(inverse(selection.transform), point);
  return x >= 0 && y >= 0 && x <= selection.canvas.width && y <= selection.canvas.height ? { kind: 'move' } : null;
}
export function gestureTransform(selection, hit, start, current) {
  const m = selection.transform, width = selection.canvas.width, height = selection.canvas.height;
  if (hit.kind === 'move') return multiply(translation(current[0]-start[0], current[1]-start[1]), m);
  if (hit.kind === 'rotate') {
    const center = mapPoint(m, [width/2, height/2]);
    if (!Math.hypot(start[0]-center[0], start[1]-center[1]) || !Math.hypot(current[0]-center[0], current[1]-center[1])) return m;
    const angle = Math.atan2(current[1]-center[1], current[0]-center[0])-Math.atan2(start[1]-center[1], start[0]-center[0]);
    return multiply(around(center, rotation(angle)), m);
  }
  if (hit.kind !== 'resize' || !HANDLES[hit.index]) return m;
  const [horizontal, vertical] = HANDLES[hit.index], inv = inverse(m);
  const from = mapPoint(inv, start), to = mapPoint(inv, current);
  const extent = (value, size) => Math.max(1/size, value);
  const frame = selectionGeometry(selection);
  const sx = horizontal === .5 ? 1 : extent(1+(to[0]-from[0])/(horizontal === 0 ? -width : width), frame.frameWidth);
  const sy = vertical === .5 ? 1 : extent(1+(to[1]-from[1])/(vertical === 0 ? -height : height), frame.frameHeight);
  const anchor = [(1-horizontal)*width, (1-vertical)*height];
  return multiply(m, around(anchor, matrix([sx, 0, 0, sy, 0, 0])));
}
export function paintSelection(ctx, selection, offsetX = 0, offsetY = 0) {
  if (!selection) return;
  ctx.save();
  try {
    ctx.translate(offsetX, offsetY);
    ctx.transform(...selection.transform);
    // Match the existing smooth raster resize while always sampling the original source.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';
    ctx.drawImage(selection.canvas, 0, 0);
  } finally { ctx.restore(); }
}
export function ownsDocumentPoint(selection, x, y, inv = inverse(selection.transform)) {
  const local = mapPoint(inv, [x, y]), sx = Math.floor(local[0]), sy = Math.floor(local[1]);
  return sx >= 0 && sy >= 0 && sx < selection.canvas.width && sy < selection.canvas.height &&
    Boolean(selection.mask?.[sy*selection.canvas.width+sx] ?? 1);
}
