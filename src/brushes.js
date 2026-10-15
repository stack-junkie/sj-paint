export const BRUSHES = [
  { id: 'pencil', label: 'Pencil' },
  { id: 'brush', label: 'Brush' },
  { id: 'calligraphy', label: 'Calligraphy brush' },
  { id: 'calligraphy-pen', label: 'Calligraphy pen' },
  { id: 'airbrush', label: 'Airbrush' },
  { id: 'oil', label: 'Oil brush' },
  { id: 'crayon', label: 'Crayon' },
  { id: 'marker', label: 'Marker' },
  { id: 'natural-pencil', label: 'Natural pencil' },
  { id: 'watercolor', label: 'Watercolor brush' },
];

const TAU = Math.PI * 2;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;

function randomSource(seed) {
  let state = 2166136261;
  for (const character of String(seed)) {
    state = Math.imul(state ^ character.charCodeAt(0), 16777619);
  }
  return () => {
    state += 0x6D2B79F5;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSurface(canvas) {
  const surface = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(canvas.width, canvas.height)
    : (canvas.ownerDocument ?? globalThis.document).createElement('canvas');
  surface.width = canvas.width;
  surface.height = canvas.height;
  const context = surface.getContext('2d');
  if (!context) throw new Error('A 2D canvas context is required to paint.');
  return { canvas: surface, context };
}

function ellipse(context, x, y, radiusX, radiusY, angle = 0) {
  context.beginPath();
  context.ellipse(x, y, radiusX, radiusY, angle, 0, TAU);
  context.fill();
}

/**
 * Paint a distance-sampled stroke. A separate paint layer applies the requested
 * opacity once, even where dabs overlap. Coordinates use the caller's current
 * canvas transform. The caller owns pointer capture and should call end().
 */
export function createStroke(ctx, tool, options = {}) {
  if (!BRUSHES.some((brush) => brush.id === tool)) {
    throw new RangeError(`Unknown brush: ${tool}`);
  }

  const color = options.color ?? '#000000';
  const size = Math.max(0.5, finite(options.size, 8));
  const opacity = clamp(finite(options.opacity, 1), 0, 1) * ctx.globalAlpha;
  const random = randomSource(options.seed ?? Math.floor(Math.random() * 4294967296));
  const transform = ctx.getTransform();
  const pressureSensitive = !['marker', 'calligraphy-pen', 'airbrush'].includes(tool);
  const spacing = Math.max(0.35, size * (tool === 'airbrush' ? 0.16 : tool === 'watercolor' ? 0.13 : 0.075));
  const pigmentOpacity = tool === 'marker' ? 0.58 : tool === 'watercolor' ? 0.28 : 1;
  let base;
  let paint;
  let previous;
  let lastDab;
  let distanceToDab = spacing;
  let dirty;
  let ended = false;

  function initialize() {
    base = makeSurface(ctx.canvas);
    paint = makeSurface(ctx.canvas);
    base.context.drawImage(ctx.canvas, 0, 0);
    paint.context.setTransform(transform);
  }

  function markDirty(x, y, radius) {
    const points = [
      [x - radius, y - radius], [x + radius, y - radius],
      [x - radius, y + radius], [x + radius, y + radius],
    ].map(([px, py]) => ({
      x: transform.a * px + transform.c * py + transform.e,
      y: transform.b * px + transform.d * py + transform.f,
    }));
    const left = Math.floor(Math.min(...points.map((point) => point.x))) - 2;
    const top = Math.floor(Math.min(...points.map((point) => point.y))) - 2;
    const right = Math.ceil(Math.max(...points.map((point) => point.x))) + 2;
    const bottom = Math.ceil(Math.max(...points.map((point) => point.y))) + 2;
    dirty = dirty ? {
      left: Math.min(dirty.left, left), top: Math.min(dirty.top, top),
      right: Math.max(dirty.right, right), bottom: Math.max(dirty.bottom, bottom),
    } : { left, top, right, bottom };
  }

  function dab(x, y, pressure, angle) {
    const context = paint.context;
    const radius = size * (pressureSensitive ? 0.45 + pressure * 1.1 : 1) / 2;
    const grainCount = Math.min(240, Math.max(12, Math.ceil(radius * 5)));
    context.save();
    try {
      context.fillStyle = color;
      context.strokeStyle = color;
      context.lineCap = 'round';

      if (tool === 'pencil' || tool === 'brush') {
        ellipse(context, x, y, radius, radius);
      } else if (tool === 'calligraphy' || tool === 'calligraphy-pen') {
        ellipse(context, x, y, radius, Math.max(0.3, radius * (tool === 'calligraphy' ? 0.23 : 0.1)), -Math.PI / 4);
      } else if (tool === 'marker') {
        context.translate(x, y);
        context.rotate(-Math.PI / 6);
        context.fillRect(-radius, -radius * 0.35, radius * 2, radius * 0.7);
      } else if (tool === 'airbrush') {
        // Uniform disk candidates with a soft radial acceptance function.
        for (let index = 0; index < grainCount; index += 1) {
          const theta = random() * TAU;
          const distance = Math.sqrt(random());
          const accepted = random() < (1 - distance) * 0.85;
          const droplet = Math.max(0.35, radius * (0.012 + random() * 0.025));
          if (!accepted) continue;
          context.globalAlpha = 0.2 + random() * 0.65;
          ellipse(context, x + Math.cos(theta) * distance * radius, y + Math.sin(theta) * distance * radius, droplet, droplet);
        }
      } else if (tool === 'oil') {
        context.globalAlpha = 0.9;
        ellipse(context, x, y, radius, radius * 0.86, angle);
        // Bristles leave thin streaks parallel to the direction of travel.
        context.translate(x, y);
        context.rotate(angle);
        for (let index = 0; index < grainCount / 2; index += 1) {
          const offset = (random() * 2 - 1) * radius * 0.8;
          const reach = Math.sqrt(Math.max(0, radius * radius - offset * offset)) * 0.8;
          context.strokeStyle = index % 4 === 0 ? (options.secondaryColor ?? '#ffffff') : color;
          context.globalAlpha = index % 4 === 0 ? 0.07 : 0.4;
          context.lineWidth = Math.max(0.4, radius * (0.015 + random() * 0.035));
          context.beginPath();
          context.moveTo(-reach, offset);
          context.lineTo(reach, offset);
          context.stroke();
        }
      } else if (tool === 'crayon' || tool === 'natural-pencil') {
        context.globalAlpha = tool === 'crayon' ? 0.055 : 0.035;
        ellipse(context, x, y, radius, radius);
        for (let index = 0; index < grainCount; index += 1) {
          const theta = random() * TAU;
          const distance = Math.sqrt(random()) * radius;
          const grain = Math.max(0.25, radius * (0.015 + random() * 0.045));
          context.globalAlpha = (tool === 'crayon' ? 0.3 : 0.2) * (0.4 + pressure) * (0.3 + random());
          ellipse(context, x + Math.cos(theta) * distance, y + Math.sin(theta) * distance, grain, grain * 0.6, -Math.PI / 4);
        }
      } else if (tool === 'watercolor') {
        const gradient = context.createRadialGradient(x, y, radius * 0.12, x, y, radius);
        gradient.addColorStop(0, color);
        gradient.addColorStop(0.65, color);
        gradient.addColorStop(1, 'transparent');
        context.globalAlpha = 0.14;
        context.fillStyle = gradient;
        ellipse(context, x, y, radius, radius);
        // Uneven pigment at the wet edge gives each wash a soft organic rim.
        context.fillStyle = color;
        for (let index = 0; index < 7; index += 1) {
          const theta = random() * TAU;
          const distance = radius * (0.55 + random() * 0.2);
          context.globalAlpha = 0.025 + random() * 0.025;
          ellipse(context, x + Math.cos(theta) * distance, y + Math.sin(theta) * distance, radius * 0.2, radius * 0.13, theta);
        }
      }
    } finally {
      context.restore();
    }
    markDirty(x, y, radius * 1.1);
    lastDab = { x, y, pressure, angle };
  }

  function composite() {
    if (!dirty) return;
    const left = clamp(dirty.left, 0, ctx.canvas.width);
    const top = clamp(dirty.top, 0, ctx.canvas.height);
    const width = clamp(dirty.right, 0, ctx.canvas.width) - left;
    const height = clamp(dirty.bottom, 0, ctx.canvas.height) - top;
    dirty = undefined;
    if (width <= 0 || height <= 0) return;
    ctx.save();
    try {
      ctx.resetTransform();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      ctx.filter = 'none';
      ctx.clearRect(left, top, width, height);
      ctx.drawImage(base.canvas, left, top, width, height, left, top, width, height);
      ctx.globalAlpha = opacity * pigmentOpacity;
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(paint.canvas, left, top, width, height, left, top, width, height);
    } finally {
      ctx.restore();
    }
  }

  function move(x, y, pressure = 0.5) {
    if (ended || !Number.isFinite(x) || !Number.isFinite(y) || opacity === 0) return;
    const point = { x, y, pressure: clamp(finite(pressure, 0.5), 0, 1) };
    if (!previous) {
      initialize();
      dab(x, y, point.pressure, 0);
      previous = point;
      composite();
      return;
    }
    const dx = x - previous.x;
    const dy = y - previous.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 0.0001) return;
    const angle = Math.atan2(dy, dx);
    let consumed = distanceToDab;
    while (consumed <= distance) {
      const fraction = consumed / distance;
      dab(previous.x + dx * fraction, previous.y + dy * fraction,
        previous.pressure + (point.pressure - previous.pressure) * fraction, angle);
      consumed += spacing;
    }
    distanceToDab = consumed - distance;
    previous = point;
    composite();
  }

  function end() {
    if (ended) return;
    ended = true;
    if (previous && lastDab && Math.hypot(previous.x - lastDab.x, previous.y - lastDab.y) > spacing * 0.25) {
      dab(previous.x, previous.y, previous.pressure, lastDab.angle);
      composite();
    }
    // Release full-size backing stores as soon as the pointer is released.
    if (base) base.canvas.width = base.canvas.height = 0;
    if (paint) paint.canvas.width = paint.canvas.height = 0;
    base = undefined;
    paint = undefined;
  }

  return { move, end };
}
