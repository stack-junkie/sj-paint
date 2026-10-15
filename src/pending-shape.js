import { drawShape } from './shapes.js';

// Clockwise from the northwest corner: NW, N, NE, E, SE, S, SW, W.
const HANDLES = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]];
const TAU = Math.PI * 2;
const pointCoordinates = point => Array.isArray(point) ? point : [point?.x, point?.y];
const finitePoint = point => point?.length === 2 && point.every(Number.isFinite);
const zoomFactor = zoom => Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
const clone = shape => ({ ...shape, start: [...shape.start], end: [...shape.end], options: { ...shape.options } });

function bounds(shape) {
  const left = Math.min(shape.start[0], shape.end[0]);
  const top = Math.min(shape.start[1], shape.end[1]);
  const right = Math.max(shape.start[0], shape.end[0]);
  const bottom = Math.max(shape.start[1], shape.end[1]);
  return { left, top, right, bottom, width: right - left, height: bottom - top,
    center: [(left + right) / 2, (top + bottom) / 2] };
}

function rotateVector([x, y], angle) {
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  return [x * cosine - y * sine, x * sine + y * cosine];
}

function localPoint(shape, point, center) {
  const delta = rotateVector([point[0] - center[0], point[1] - center[1]], -shape.angle);
  return [center[0] + delta[0], center[1] + delta[1]];
}

function handlePoints(box) {
  return HANDLES.map(([x, y]) => [box.left + x * box.width, box.top + y * box.height]);
}

/** Angles are radians. Initial constraints are baked into the endpoints once. */
export function createPendingShape(type, start, end, options = {}) {
  start = pointCoordinates(start); end = pointCoordinates(end);
  if (!finitePoint(start) || !finitePoint(end)) throw new TypeError('Shape endpoints must be finite coordinates.');
  if (type === 'curve' || type === 'polygon') throw new TypeError('Curves and polygons use their own editing state.');
  start = [...start]; end = [...end];
  if (options.constrain) {
    const dx = end[0] - start[0], dy = end[1] - start[1];
    if (type === 'line') {
      const distance = Math.hypot(dx, dy);
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4;
      end = [start[0] + Math.cos(angle) * distance, start[1] + Math.sin(angle) * distance];
    } else {
      const size = Math.max(Math.abs(dx), Math.abs(dy));
      end = [start[0] + (dx < 0 ? -size : size), start[1] + (dy < 0 ? -size : size)];
    }
  }
  return { type, start, end, options: { ...options, constrain: false }, angle: 0 };
}

/** Paint into the caller's context; controls use constant CSS-pixel dimensions. */
export function paintPendingShape(ctx, shape, { handles = false, pixels = true, zoom = 1 } = {}) {
  const box = bounds(shape), [cx, cy] = box.center;
  const scale = zoomFactor(zoom);
  ctx.save();
  try {
    ctx.translate(cx, cy);
    ctx.rotate(shape.angle);
    ctx.translate(-cx, -cy);
    if(pixels)drawShape(ctx, shape.type, ...shape.start, ...shape.end, { ...shape.options, constrain: false });
    if (!handles) return;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineWidth = 1 / scale;
    ctx.strokeStyle = '#0078d4';
    ctx.fillStyle = '#ffffff';
    ctx.setLineDash([3 / scale, 3 / scale]);
    ctx.strokeRect(box.left, box.top, box.width, box.height);
    ctx.setLineDash([]);
    const rotationY = box.top - 24 / scale;
    ctx.beginPath();
    ctx.moveTo(cx, box.top);
    ctx.lineTo(cx, rotationY);
    ctx.stroke();
    const radius = 3 / scale;
    for (const [x, y] of handlePoints(box)) {
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      ctx.strokeRect(x - radius, y - radius, radius * 2, radius * 2);
    }
    ctx.beginPath();
    ctx.arc(cx, rotationY, 4 / scale, 0, TAU);
    ctx.fill();
    ctx.stroke();
  } finally { ctx.restore(); }
}

/** Hit testing uses document coordinates and the same rotated controls as painting. */
export function hitPendingShape(shape, point, zoom = 1) {
  point = pointCoordinates(point);
  if (!finitePoint(point)) return null;
  const box = bounds(shape), scale = zoomFactor(zoom);
  const [x, y] = localPoint(shape, point, box.center);
  const tolerance = 6 / scale;
  if (Math.hypot(x - box.center[0], y - (box.top - 24 / scale)) <= tolerance) return { kind: 'rotate' };
  const controls = handlePoints(box);
  let nearest = -1, nearestDistance = Infinity;
  for (let index = 0; index < controls.length; index++) {
    const [hx, hy] = controls[index];
    const distance = Math.hypot(x - hx, y - hy);
    if (Math.abs(x - hx) <= tolerance && Math.abs(y - hy) <= tolerance && distance < nearestDistance) {
      nearest = index; nearestDistance = distance;
    }
  }
  if (nearest >= 0) return { kind: 'resize', index: nearest };
  const padding = shape.type === 'line' ? tolerance : 0;
  if (x >= box.left - padding && x <= box.right + padding && y >= box.top - padding && y <= box.bottom + padding) {
    return { kind: 'move' };
  }
  return null;
}

/** Return a replacement preview without changing the original shape or document. */
export function transformPendingShape(original, hit, start, current, { constrain = false } = {}) {
  const next = clone(original);
  start = pointCoordinates(start); current = pointCoordinates(current);
  if (!finitePoint(start) || !finitePoint(current) || !hit) return next;
  const box = bounds(original), [cx, cy] = box.center;
  const delta = [current[0] - start[0], current[1] - start[1]];
  if (hit.kind === 'move') {
    next.start = [original.start[0] + delta[0], original.start[1] + delta[1]];
    next.end = [original.end[0] + delta[0], original.end[1] + delta[1]];
    return next;
  }
  if (hit.kind === 'rotate') {
    if (Math.hypot(start[0] - cx, start[1] - cy) === 0 || Math.hypot(current[0] - cx, current[1] - cy) === 0) return next;
    const angle = original.angle + Math.atan2(current[1] - cy, current[0] - cx) - Math.atan2(start[1] - cy, start[0] - cx);
    next.angle = ((angle + Math.PI) % TAU + TAU) % TAU - Math.PI;
    return next;
  }
  if (hit.kind !== 'resize' || !Number.isInteger(hit.index) || !HANDLES[hit.index]) return next;
  const [horizontal, vertical] = HANDLES[hit.index];
  const [dx, dy] = rotateVector(delta, -original.angle);
  let { left, right, top, bottom } = box;
  if (horizontal === 0) left += dx;
  if (horizontal === 1) right += dx;
  if (vertical === 0) top += dy;
  if (vertical === 1) bottom += dy;
  // Aspect preservation is an optional editing rule, not a verified Paint modifier.
  if (constrain) {
    const ratio = box.width > 0 && box.height > 0 ? box.width / box.height : 1;
    const width = right - left, height = bottom - top;
    if (horizontal === 0.5) {
      const halfWidth = Math.abs(height) * ratio / 2;
      left = cx - halfWidth; right = cx + halfWidth;
    } else if (vertical === 0.5) {
      const halfHeight = Math.abs(width) / ratio / 2;
      top = cy - halfHeight; bottom = cy + halfHeight;
    } else {
      const extent = Math.max(Math.abs(width), Math.abs(height) * ratio);
      const constrainedWidth = (width < 0 ? -1 : 1) * extent;
      const constrainedHeight = (height < 0 ? -1 : 1) * extent / ratio;
      if (horizontal === 0) left = right - constrainedWidth;
      else right = left + constrainedWidth;
      if (vertical === 0) top = bottom - constrainedHeight;
      else bottom = top + constrainedHeight;
    }
  }
  const localCenter = [(left + right) / 2, (top + bottom) / 2];
  const centerShift = rotateVector([localCenter[0] - cx, localCenter[1] - cy], original.angle);
  const worldCenter = [cx + centerShift[0], cy + centerShift[1]];
  const remap = (point, end) => {
    const x = box.width ? (point[0] - box.left) / box.width : Number(end);
    const y = box.height ? (point[1] - box.top) / box.height : Number(end);
    return [worldCenter[0] + left + x * (right - left) - localCenter[0],
      worldCenter[1] + top + y * (bottom - top) - localCenter[1]];
  };
  next.start = remap(original.start, false);
  next.end = remap(original.end, true);
  return next;
}
