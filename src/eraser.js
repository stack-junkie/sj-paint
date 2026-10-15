const finitePoint = (x, y) => Number.isFinite(x) && Number.isFinite(y);

function eraserSize(size) {
  if (!Number.isFinite(size) || size < 1 || size > 16384) throw new RangeError('Eraser size must be between 1 and 16384 pixels.');
  return Math.round(size);
}

/** Shared document-pixel footprint for the stroke and its cursor. */
export function eraserFootprint(x, y, size = 8) {
  size = eraserSize(size);
  if (!finitePoint(x, y)) return null;
  x = Math.floor(x-size/2); y = Math.floor(y-size/2);
  return Number.isSafeInteger(x) && Number.isSafeInteger(y) ? { x, y, width: size, height: size } : null;
}

function colorBytes(ctx, color) {
  if (typeof color !== 'string' || !CSS.supports('color', color)) throw new TypeError('Eraser colors must be valid CSS colors.');
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : ctx.canvas.ownerDocument.createElement('canvas');
  canvas.width = canvas.height = 1;
  const swatch = canvas.getContext('2d', { willReadFrequently: true });
  swatch.fillStyle = color; swatch.fillRect(0, 0, 1, 1);
  return [...swatch.getImageData(0, 0, 1, 1).data];
}

/**
 * Square eraser in document pixel coordinates. The caller owns history and capture.
 * The owned native horizontal and diagonal fixtures match a continuous square sweep
 * with binary pixel-center coverage. Fractional coordinates and odd-size snapping
 * use floor(pointer-size/2); those cases have not yet been observed in native Paint.
 */
export function createEraserStroke(ctx, { size = 8, mode = 'erase', primary = '#000000', secondary = '#ffffff' } = {}) {
  if (!ctx || !ctx.canvas || typeof ctx.clearRect !== 'function') throw new TypeError('A 2D canvas context is required.');
  size = eraserSize(size);
  if (mode !== 'erase' && mode !== 'replace') throw new TypeError('Unknown eraser mode.');
  const fromColor = mode === 'replace' ? colorBytes(ctx, primary) : null;
  const toColor = mode === 'replace' ? colorBytes(ctx, secondary) : null;
  let previous, ended = false;

  function spans(from, to) {
    const [x0, y0] = from, [x1, y1] = to, dx = x1-x0, dy = y1-y0;
    const top = Math.max(0, Math.min(y0, y1)), bottom = Math.min(ctx.canvas.height, Math.max(y0, y1)+size);
    const rows = [];
    // Iteration is bounded by canvas height even when pointer coordinates lie far outside it.
    for (let y = top; y < bottom; y++) {
      let low = 0, high = 1;
      if (dy) {
        const a = (y+.5-size-y0)/dy, b = (y+.5-y0)/dy;
        low = Math.max(0, Math.min(a, b)); high = Math.min(1, Math.max(a, b));
        if (low > high) continue;
      }
      const a = x0+dx*low, b = x0+dx*high;
      const left = Math.max(0, Math.ceil(Math.min(a, b)-.5));
      const right = Math.min(ctx.canvas.width, Math.ceil(Math.max(a, b)+size-.5));
      if (right > left) rows.push({ y, left, right });
    }
    return rows;
  }

  function paint(rows) {
    if (!rows.length) return;
    if (mode === 'erase') {
      ctx.save();
      try {
        ctx.resetTransform();
        for (const { y, left, right } of rows) ctx.clearRect(left, y, right-left, 1);
      } finally { ctx.restore(); }
      return;
    }
    // The owned red-centered native grid accepts RGB squared distances 0..6 and
    // rejects 8, 9 and 12. Other primary colors have not yet been sampled.
    // Native partial-alpha samples retain alpha. Read only small bounded strips.
    for (let first = 0; first < rows.length; first += 32) {
      const strip = rows.slice(first, first+32), top = strip[0].y, height = strip.at(-1).y-top+1;
      const left = Math.min(...strip.map(row => row.left)), right = Math.max(...strip.map(row => row.right));
      const image = ctx.getImageData(left, top, right-left, height), pixels = image.data;
      let changed = false;
      for (const row of strip) for (let x = row.left; x < row.right; x++) {
        const index = ((row.y-top)*(right-left)+x-left)*4;
        if (!pixels[index+3]) continue;
        const red = pixels[index]-fromColor[0], green = pixels[index+1]-fromColor[1], blue = pixels[index+2]-fromColor[2];
        if (red*red+green*green+blue*blue > 6) continue;
        if (pixels[index] === toColor[0] && pixels[index+1] === toColor[1] && pixels[index+2] === toColor[2]) continue;
        pixels[index] = toColor[0]; pixels[index+1] = toColor[1]; pixels[index+2] = toColor[2]; changed = true;
      }
      if (changed) ctx.putImageData(image, left, top);
    }
  }

  function move(x, y) {
    if (ended) return;
    const footprint = eraserFootprint(x, y, size);
    if (!footprint) return;
    const point = [footprint.x, footprint.y];
    if (previous && previous[0] === point[0] && previous[1] === point[1]) return;
    paint(spans(previous ?? point, point));
    previous = point;
  }
  function end() { ended = true; previous = undefined; }
  return { move, end };
}
