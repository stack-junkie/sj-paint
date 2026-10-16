import { drawShape } from './shapes.js';

/** Initial endpoint constraints become document geometry before bending begins. */
export function createCurve(start, end, { constrain = false } = {}) {
  if (![start, end].every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))) {
    throw new TypeError('Curve endpoints must be finite coordinates.');
  }
  start = [...start]; end = [...end];
  if (constrain) {
    const dx = end[0] - start[0], dy = end[1] - start[1];
    const distance = Math.hypot(dx, dy);
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4;
    end = [start[0] + Math.cos(angle) * distance, start[1] + Math.sin(angle) * distance];
  }
  return { start, end, controls: [] };
}

/** Held, released and accepted curves use the same geometry and raster path. */
export function paintCurve(context, curve, options = {}) {
  const controls = [...curve.controls];
  if (controls.length < 2 && curve.hover) controls.push(curve.hover);
  drawShape(context, controls.length ? 'curve' : 'line', ...curve.start, ...curve.end, {
    ...options, constrain: false, controlPoints: controls.map(([x, y]) => ({ x, y })),
  });
}
