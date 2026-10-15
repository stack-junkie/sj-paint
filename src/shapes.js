const TEXTURED_STYLES = new Set(['crayon', 'marker', 'oil', 'natural-pencil', 'watercolor']);
const patternCaches = new WeakMap();
const TEXTURE_SIZE = 64;
const MAX_CACHED_PATTERNS = 24;

/**
 * Small, repeatable pigment masks approximate the named drawing media. These
 * are Canvas textures, not reproductions of Microsoft's proprietary rasters.
 * Cost is bounded by tile size, independent of the shape's document area.
 */
function shapePaint(ctx, style, color) {
  if (!TEXTURED_STYLES.has(style)) return color;
  let cache = patternCaches.get(ctx);
  if (!cache) {
    cache = new Map();
    patternCaches.set(ctx, cache);
  }
  const key = `${style}\0${color}`;
  if (cache.has(key)) {
    const cached = cache.get(key);
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const tile = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(TEXTURE_SIZE, TEXTURE_SIZE)
    : (ctx.canvas.ownerDocument ?? globalThis.document).createElement('canvas');
  tile.width = tile.height = TEXTURE_SIZE;
  const texture = tile.getContext('2d');
  if (!texture) throw new Error('A 2D canvas context is required for shape textures.');
  const pixels = texture.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
  let seed = 0x9E3779B9;
  const noise = () => {
    seed = Math.imul(seed ^ (seed >>> 16), 0x21F0AAAD);
    seed = Math.imul(seed ^ (seed >>> 15), 0x735A2D97);
    seed ^= seed >>> 15;
    return (seed >>> 0) / 4294967296;
  };
  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const grain = noise();
      const phaseX = x / TEXTURE_SIZE * Math.PI * 2;
      const phaseY = y / TEXTURE_SIZE * Math.PI * 2;
      let alpha;
      switch (style) {
        case 'crayon':
          alpha = grain < 0.2 ? 0 : 0.18 + grain * 0.72;
          break;
        case 'marker':
          alpha = 0.54 + Math.sin(phaseY * 4) * 0.025 + grain * 0.025;
          break;
        case 'oil':
          alpha = 0.8 + Math.sin(phaseY * 13 + Math.sin(phaseX) * 0.5) * 0.12 + grain * 0.08;
          break;
        case 'natural-pencil': {
          const tooth = Math.sin((phaseX + phaseY) * 17) * 0.1;
          alpha = grain < 0.48 ? 0.025 : 0.15 + grain * 0.45 + tooth;
          break;
        }
        case 'watercolor':
          alpha = 0.3 + Math.sin(phaseX + Math.sin(phaseY)) * 0.065
            + Math.cos(phaseY * 2 - Math.sin(phaseX * 2)) * 0.045 + grain * 0.025;
          break;
      }
      const index = (y * TEXTURE_SIZE + x) * 4;
      pixels.data[index] = pixels.data[index + 1] = pixels.data[index + 2] = 255;
      pixels.data[index + 3] = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
    }
  }
  texture.putImageData(pixels, 0, 0);
  texture.globalCompositeOperation = 'source-in';
  texture.fillStyle = color;
  texture.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  const pattern = ctx.createPattern(tile, 'repeat');
  if (!pattern) throw new Error('Could not create a shape texture.');
  if (cache.size >= MAX_CACHED_PATTERNS) cache.delete(cache.keys().next().value);
  cache.set(key, pattern);
  return pattern;
}

/** Draw a Paint-style shape in document coordinates. */
export function drawShape(ctx, type, x0, y0, x1, y1, options = {}) {
  const { stroke = '#000000', fill = '#ffffff', lineWidth = 2,
    outline = 'solid', fillStyle = 'none', constrain = false, opacity = 1 } = options;
  if (![x0, y0, x1, y1, lineWidth].every(Number.isFinite)) return;
  if (constrain) {
    if (type === 'line' || type === 'curve') {
      const distance = Math.hypot(x1 - x0, y1 - y0);
      const angle = Math.round(Math.atan2(y1 - y0, x1 - x0) / (Math.PI / 4)) * Math.PI / 4;
      x1 = x0 + Math.cos(angle) * distance; y1 = y0 + Math.sin(angle) * distance;
    } else {
      const size = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      x1 = x0 + (x1 < x0 ? -size : size); y1 = y0 + (y1 < y0 ? -size : size);
    }
  }
  const left = Math.min(x0, x1), top = Math.min(y0, y1);
  const width = Math.abs(x1 - x0), height = Math.abs(y1 - y0);
  const px = x => left + x * width, py = y => top + y * height;
  const move = (x, y) => ctx.moveTo(px(x), py(y));
  const line = (x, y) => ctx.lineTo(px(x), py(y));
  const bezier = (a, b, c, d, e, f) => ctx.bezierCurveTo(px(a), py(b), px(c), py(d), px(e), py(f));
  const polygon = points => { points.forEach(([x, y], index) => index ? line(x, y) : move(x, y)); ctx.closePath(); };
  const regular = (sides, radius = 0.5, rotation = -Math.PI / 2) => {
    polygon(Array.from({ length: sides }, (_, i) => {
      const angle = rotation + i * Math.PI * 2 / sides;
      return [0.5 + Math.cos(angle) * radius, 0.5 + Math.sin(angle) * radius];
    }));
  };
  const star = (points, inner) => polygon(Array.from({ length: points * 2 }, (_, i) => {
    const angle = -Math.PI / 2 + i * Math.PI / points;
    const radius = i % 2 ? inner : 0.5;
    return [0.5 + Math.cos(angle) * radius, 0.5 + Math.sin(angle) * radius];
  }));
  const strokePaint = shapePaint(ctx, outline, stroke);
  const fillPaint = shapePaint(ctx, fillStyle, fill);
  ctx.save();
  ctx.globalAlpha *= Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1;
  ctx.strokeStyle = strokePaint;
  ctx.fillStyle = fillPaint;
  ctx.lineWidth = Math.max(0.1, lineWidth);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  let open = false;
  switch (type) {
    case 'line':
      ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); open = true; break;
    case 'curve': {
      ctx.moveTo(x0, y0);
      const controls = options.controlPoints;
      if (controls?.length >= 2) ctx.bezierCurveTo(controls[0].x, controls[0].y, controls[1].x, controls[1].y, x1, y1);
      else if (controls?.length === 1) ctx.quadraticCurveTo(controls[0].x, controls[0].y, x1, y1);
      else ctx.bezierCurveTo(x0 + (x1 - x0) / 3, y0, x0 + (x1 - x0) * 2 / 3, y1, x1, y1);
      open = true; break;
    }
    case 'oval': ctx.ellipse(px(0.5), py(0.5), width / 2, height / 2, 0, 0, Math.PI * 2); break;
    case 'rectangle': ctx.rect(left, top, width, height); break;
    case 'rounded-rectangle': {
      const radius = Math.min(width, height) * 0.18;
      ctx.roundRect(left, top, width, height, radius); break;
    }
    case 'polygon':
      if (options.points?.length >= 3) {
        options.points.forEach((point, index) => ctx[index ? 'lineTo' : 'moveTo'](point.x, point.y));
        ctx.closePath();
      } else polygon([[0.15, 0], [0.85, 0.12], [1, 0.7], [0.55, 1], [0, 0.7]]);
      break;
    case 'triangle': polygon([[0.5, 0], [1, 1], [0, 1]]); break;
    case 'right-triangle': polygon([[0, 0], [1, 1], [0, 1]]); break;
    case 'diamond': polygon([[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]); break;
    case 'pentagon': regular(5); break;
    case 'hexagon': regular(6, 0.5, 0); break;
    case 'right-arrow': polygon([[0, 0.3], [0.6, 0.3], [0.6, 0], [1, 0.5], [0.6, 1], [0.6, 0.7], [0, 0.7]]); break;
    case 'left-arrow': polygon([[1, 0.3], [0.4, 0.3], [0.4, 0], [0, 0.5], [0.4, 1], [0.4, 0.7], [1, 0.7]]); break;
    case 'up-arrow': polygon([[0.3, 1], [0.3, 0.4], [0, 0.4], [0.5, 0], [1, 0.4], [0.7, 0.4], [0.7, 1]]); break;
    case 'down-arrow': polygon([[0.3, 0], [0.3, 0.6], [0, 0.6], [0.5, 1], [1, 0.6], [0.7, 0.6], [0.7, 0]]); break;
    case 'star4': star(4, 0.15); break;
    case 'star5': star(5, 0.21); break;
    case 'star6': star(6, 0.25); break;
    case 'rect-callout': polygon([[0, 0], [1, 0], [1, 0.75], [0.4, 0.75], [0.2, 1], [0.25, 0.75], [0, 0.75]]); break;
    case 'oval-callout':
      move(0.3, 0.71); line(0.16, 1); line(0.47, 0.75);
      bezier(0.78, 0.78, 1, 0.61, 1, 0.38);
      bezier(1, 0.16, 0.78, 0, 0.5, 0);
      bezier(0.22, 0, 0, 0.16, 0, 0.38);
      bezier(0, 0.53, 0.12, 0.66, 0.3, 0.71); ctx.closePath(); break;
    case 'cloud-callout':
      move(0.2, 0.65);
      bezier(-0.03, 0.7, -0.05, 0.4, 0.08, 0.33);
      bezier(-0.01, 0.17, 0.13, 0.04, 0.3, 0.12);
      bezier(0.35, -0.04, 0.58, -0.03, 0.66, 0.1);
      bezier(0.85, 0.02, 1.02, 0.16, 0.92, 0.32);
      bezier(1.09, 0.42, 0.99, 0.66, 0.82, 0.65);
      bezier(0.75, 0.83, 0.51, 0.78, 0.45, 0.7);
      bezier(0.38, 0.81, 0.2, 0.78, 0.2, 0.65); ctx.closePath();
      ctx.moveTo(px(0.29), py(0.85)); ctx.ellipse(px(0.23), py(0.85), width * 0.06, height * 0.05, 0, 0, Math.PI * 2);
      ctx.moveTo(px(0.16), py(0.97)); ctx.ellipse(px(0.13), py(0.97), width * 0.03, height * 0.025, 0, 0, Math.PI * 2); break;
    case 'heart':
      move(0.5, 1);
      bezier(0.42, 0.86, 0, 0.56, 0, 0.28);
      bezier(0, -0.05, 0.35, -0.1, 0.5, 0.2);
      bezier(0.65, -0.1, 1, -0.05, 1, 0.28);
      bezier(1, 0.56, 0.58, 0.86, 0.5, 1); ctx.closePath(); break;
    case 'lightning': polygon([[0.4, 0], [0.9, 0], [0.57, 0.4], [1, 0.4], [0.16, 1], [0.38, 0.57], [0, 0.57]]); break;
    default:
      ctx.restore();
      throw new Error(`Unknown shape: ${type}`);
  }
  if (!open && fillStyle !== 'none') ctx.fill();
  if (outline !== 'none') ctx.stroke();
  ctx.restore();
}
