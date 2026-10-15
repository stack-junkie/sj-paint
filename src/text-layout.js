// The browser owns text wrapping for both the live textarea and its raster output.
// Range probes only read the mirror after its single layout; line boundaries use
// binary searches rather than measuring every character independently.
export function layoutTextEditor(editor, { scale = 1 } = {}) {
  if (!(scale > 0) || !Number.isFinite(scale)) throw new RangeError('Text scale must be positive and finite.');
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
