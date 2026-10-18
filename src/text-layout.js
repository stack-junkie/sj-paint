import { createCanvas } from './engine.js';

// The browser owns text wrapping for both the live textarea and its raster output.
// Range probes only read the mirror after its single layout; line boundaries use
// binary searches rather than measuring every character independently.
function createTextMirror(editor) {
  const document = editor.ownerDocument, style = document.defaultView.getComputedStyle(editor);
  const text = editor.value;
  const padding = { left: parseFloat(style.paddingLeft) || 0, top: parseFloat(style.paddingTop) || 0 };
  const border = { left: parseFloat(style.borderLeftWidth) || 0, top: parseFloat(style.borderTopWidth) || 0 };
  const width = Math.max(1, editor.clientWidth - padding.left - (parseFloat(style.paddingRight) || 0));
  const mirror = document.createElement('div');
  for (const name of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariant',
    'fontKerning', 'fontFeatureSettings', 'fontVariationSettings', 'letterSpacing', 'wordSpacing',
    'lineHeight', 'whiteSpace', 'overflowWrap', 'wordBreak', 'tabSize', 'textAlign', 'direction', 'textIndent']) {
    mirror.style[name] = style[name];
  }
  Object.assign(mirror.style, { position: 'fixed', left: '0', top: '0', width: `${width}px`,
    height: 'auto', minHeight: '0', padding: '0', margin: '0', border: '0', boxSizing: 'content-box',
    visibility: 'hidden', pointerEvents: 'none', overflow: 'visible' });
  mirror.setAttribute('aria-hidden', 'true');
  const node = document.createTextNode(text); mirror.append(node);
  // A zero-width final inline box retains the last empty line after a newline.
  const endMarker = document.createElement('span');
  Object.assign(endMarker.style, { display: 'inline-block', width: '0', height: '0', verticalAlign: 'baseline' });
  mirror.append(endMarker);
  return { document, style, text, padding, border, width, mirror, node, endMarker };
}

// The same browser layout owner measures the native selection endpoint. Return
// CSS offsets so the coordinator can reveal it in the document viewport.
export function measureTextCaret(editor) {
  const { document, padding, border, mirror, text, node, endMarker } = createTextMirror(editor);
  const index = editor.selectionDirection === 'backward' ? editor.selectionStart : editor.selectionEnd;
  let probe;
  document.body.append(mirror);
  try {
    const range = document.createRange(); range.setStart(node, index); range.collapse(true);
    const origin = mirror.getBoundingClientRect();
    let rect = range.getClientRects()[0] || range.getBoundingClientRect();
    // Inserting a zero-width character would add a word-break opportunity and
    // change the very wrapping being measured. Read the unchanged source.
    if (!rect.height && index < text.length) {
      range.setEnd(node, index + 1);
      rect = range.getClientRects()[0] || range.getBoundingClientRect();
    }
    if (!rect.height && index === text.length) {
      // Empty input and the empty line after a final newline have no text Range
      // box. The existing final marker supplies their baseline; a separate
      // probe supplies the font's caret ascent/descent without altering wrapping.
      probe = mirror.cloneNode(false);
      const probeText = document.createTextNode('x'), baseline = endMarker.cloneNode();
      probe.append(probeText, baseline); document.body.append(probe);
      range.selectNodeContents(probeText);
      const ink = range.getBoundingClientRect(), end = endMarker.getBoundingClientRect();
      const top = end.top - (baseline.getBoundingClientRect().top - ink.top);
      rect = { left: end.left, right: end.right, top, bottom: top + ink.height, height: ink.height };
    }
    if (!rect.height) return null;
    return { left: rect.left - origin.left + padding.left + border.left,
      right: rect.right - origin.left + padding.left + border.left,
      top: rect.top - origin.top + padding.top + border.top,
      bottom: rect.bottom - origin.top + padding.top + border.top };
  } finally { mirror.remove(); probe?.remove(); }
}

export function layoutTextEditor(editor, { scale = 1 } = {}) {
  if (!(scale > 0) || !Number.isFinite(scale)) throw new RangeError('Text scale must be positive and finite.');
  const { document, style, text, padding, border, width, mirror, node, endMarker } = createTextMirror(editor);
  const probe = mirror.cloneNode(false), probeText = document.createTextNode('x'), baseline = endMarker.cloneNode();
  probe.append(probeText, baseline);
  document.body.append(mirror, probe);
  try {
    const range = document.createRange(); range.selectNodeContents(probeText);
    const baselineOffset = baseline.getBoundingClientRect().top - range.getBoundingClientRect().top;
    const origin = mirror.getBoundingClientRect();
    const boundaries = [];
    for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) boundaries.push(part.index);
    boundaries.push(text.length);
    const rectAt = index => {
      range.setStart(node, boundaries[index]); range.setEnd(node, boundaries[index + 1]);
      return range.getBoundingClientRect();
    };
    const lines = [];
    let start = 0;
    while (start < boundaries.length - 1) {
      const first = rectAt(start);
      let low = start + 1, high = boundaries.length - 1;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (Math.abs(rectAt(middle).top - first.top) < 0.5) low = middle + 1;
        else high = middle;
      }
      const from = boundaries[start], to = boundaries[low], source = text.slice(from, to), runs = [];
      // Tabs occupy browser-measured space but are not painted as canvas glyphs.
      const fragments = /[^\t\n]+/g; let match;
      while ((match = fragments.exec(source))) {
        range.setStart(node, from + match.index); range.setEnd(node, from + match.index + match[0].length);
        const rect = range.getBoundingClientRect();
        runs.push({ text: match[0], x: (rect.left - origin.left + padding.left + border.left) / scale,
          baseline: (rect.top - origin.top + baselineOffset + padding.top + border.top) / scale, width: rect.width / scale });
      }
      lines.push({ start: from, end: to, source, text: source.replace(/\n$/, ''), runs });
      start = low;
    }
    if (!text || text.endsWith('\n')) lines.push({ start: text.length, end: text.length, source: '', text: '', runs: [] });
    return { lines, width: width / scale, height: origin.height / scale,
      contentX: (padding.left + border.left) / scale, contentY: (padding.top + border.top) / scale,
      lineHeight: parseFloat(style.lineHeight) / scale,
      font: `${style.fontStyle} ${style.fontWeight} ${parseFloat(style.fontSize) / scale}px ${style.fontFamily}`,
      direction: style.direction, letterSpacing: style.letterSpacing === 'normal' ? '0px' : `${parseFloat(style.letterSpacing) / scale}px`,
      wordSpacing: style.wordSpacing === 'normal' ? '0px' : `${parseFloat(style.wordSpacing) / scale}px` };
  } finally { mirror.remove(); probe.remove(); }
}

// Preview and acceptance use the same document-space raster, including decorations
// and the existing content-box background policy. Layer composition belongs to
// PaintDocument, never to the input element's CSS.
export function paintTextLayout(ctx, layout, { x, y, color, background, underline, strikethrough, fontSize }) {
  ctx.save();
  try {
    ctx.font = layout.font; ctx.direction = layout.direction;
    ctx.letterSpacing = layout.letterSpacing; ctx.wordSpacing = layout.wordSpacing;
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(x + layout.contentX, y + layout.contentY, layout.width, layout.height);
    }
    ctx.fillStyle = color;
    for (const line of layout.lines) for (const run of line.runs) {
      ctx.fillText(run.text, x + run.x, y + run.baseline);
      if (underline) ctx.fillRect(x + run.x, y + run.baseline + Math.max(1, fontSize / 12), run.width, Math.max(1, fontSize / 16));
      if (strikethrough) ctx.fillRect(x + run.x, y + run.baseline - fontSize * .3, run.width, Math.max(1, fontSize / 16));
    }
  } finally { ctx.restore(); }
}

// Retain one bounded text raster per layout/style revision. Replaying fillText
// into a reused compositor surface and a new layer can round antialiasing
// differently, even with the same Canvas2D backend. Preview and Apply consume
// these same pixels. Measure ink as well as the box so italic overhang survives.
export function rasterizeTextLayout(layout, style, { width, height }) {
  const canvas = createCanvas(1, 1), ctx = canvas.getContext('2d');
  ctx.font = layout.font; ctx.direction = layout.direction;
  ctx.letterSpacing = layout.letterSpacing; ctx.wordSpacing = layout.wordSpacing;
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  const include = (x1, y1, x2, y2) => {
    left = Math.min(left, x1); top = Math.min(top, y1);
    right = Math.max(right, x2); bottom = Math.max(bottom, y2);
  };
  if (style.background) include(style.x + layout.contentX, style.y + layout.contentY,
    style.x + layout.contentX + layout.width, style.y + layout.contentY + layout.height);
  for (const line of layout.lines) for (const run of line.runs) {
    const metrics = ctx.measureText(run.text), x = style.x + run.x, y = style.y + run.baseline;
    include(x - metrics.actualBoundingBoxLeft, y - metrics.actualBoundingBoxAscent,
      x + metrics.actualBoundingBoxRight, y + metrics.actualBoundingBoxDescent);
    if (style.underline) include(x, y + Math.max(1, style.fontSize / 12),
      x + run.width, y + Math.max(1, style.fontSize / 12) + Math.max(1, style.fontSize / 16));
    if (style.strikethrough) include(x, y - style.fontSize * .3,
      x + run.width, y - style.fontSize * .3 + Math.max(1, style.fontSize / 16));
  }
  // One surrounding pixel retains fractional edge coverage. The document clips
  // the allocation before it happens; off-canvas source text remains editable.
  left = Math.max(0, Math.floor(left) - 1); top = Math.max(0, Math.floor(top) - 1);
  right = Math.min(width, Math.ceil(right) + 1); bottom = Math.min(height, Math.ceil(bottom) + 1);
  if (right <= left || bottom <= top) return null;
  canvas.width = right - left; canvas.height = bottom - top;
  paintTextLayout(ctx, layout, { ...style, x: style.x - left, y: style.y - top });
  return { canvas, x: left, y: top };
}
