export async function verifyTextLayout(page, check) {
  const cases = [
    ['long unbroken words', 'W'.repeat(40)],
    ['leading and repeated spaces', '    indented  words   stay'],
    ['explicit blank lines', 'first\n\nthird\n'],
    ['tabs', 'a\tb\tend'],
    ['emoji graphemes', '👨‍👩‍👧‍👦🙂🇳🇴'.repeat(8)],
  ];
  for (const [name, text] of cases) {
    const result = await page.evaluate(async text => {
      const { layoutTextEditor } = await import('/src/text-layout.js');
      const editor = document.createElement('textarea'); editor.value = text;
      Object.assign(editor.style, { position: 'fixed', left: '0', top: '0', width: '220px', height: '100px',
        font: '24px Arial', lineHeight: '1.2', padding: '0', border: '0', boxSizing: 'content-box',
        whiteSpace: 'pre-wrap', overflowWrap: 'break-word', overflow: 'scroll' });
      document.body.append(editor);
      try {
        const beforeChildren = document.body.children.length, layout = layoutTextEditor(editor);
        editor.scrollTop = 80; editor.scrollLeft = 30;
        const scrolled = layoutTextEditor(editor);
        const boundaries = new Set([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(s => s.index));
        boundaries.add(text.length);
        return { layout, source: layout.lines.map(line => line.source).join(''),
          graphemesIntact: layout.lines.every(line => boundaries.has(line.start) && boundaries.has(line.end)),
          stable: JSON.stringify(layout) === JSON.stringify(scrolled), cleaned: document.body.children.length === beforeChildren,
          scrollHeight: editor.scrollHeight };
      } finally { editor.remove(); }
    }, text);
    check(`text layout preserves every source character and grapheme for ${name}`, result.source === text && result.graphemesIntact);
    check(`text layout remains independent of editor scrolling and removes mirrors for ${name}`, result.stable && result.cleaned);
    if (name === 'long unbroken words') check('long-word raster lines fit the editor and retain all forty glyphs',
      result.layout.lines.length > 1 && result.layout.lines.every(line => line.runs.every(run => run.width <= result.layout.width + 0.1)) &&
      Math.abs(result.layout.height - result.scrollHeight) <= 1, result);
    if (name === 'explicit blank lines') check('blank lines including a trailing newline retain their line boxes', result.layout.lines.length === 4, result.layout);
    if (name === 'tabs') check('tab runs retain measured gaps instead of painting tabs as ordinary spaces',
      result.layout.lines[0].runs.length >= 2 && result.layout.lines[0].runs[1].x > result.layout.lines[0].runs[0].width,
      result.layout);
  }
  const raster = await page.evaluate(async () => {
    const { layoutTextEditor } = await import('/src/text-layout.js');
    const editor = document.createElement('textarea'); editor.value = 'W'.repeat(40);
    Object.assign(editor.style, { position: 'fixed', width: '220px', height: '100px', font: '24px Arial',
      lineHeight: '1.2', padding: '0', border: '0', boxSizing: 'content-box', overflow: 'hidden',
      whiteSpace: 'pre-wrap', overflowWrap: 'break-word' });
    document.body.append(editor);
    try {
      const layout = layoutTextEditor(editor), canvas = document.createElement('canvas');
      canvas.width = 240; canvas.height = 180;
      const c = canvas.getContext('2d'); c.font = layout.font; c.textBaseline = 'alphabetic';
      for (const line of layout.lines) for (const run of line.runs) c.fillText(run.text, 20 + run.x, 20 + run.baseline);
      const data = c.getImageData(0, 0, 240, 180).data;
      let bands = 0, previous = false;
      for (let y = 0; y < 180; y++) {
        let ink = false; for (let x = 0; x < 240; x++) if (data[(y * 240 + x) * 4 + 3]) { ink = true; break; }
        if (ink && !previous) bands++; previous = ink;
      }
      const base = layoutTextEditor(editor);
      Object.assign(editor.style, { width: '440px', fontSize: '48px', lineHeight: '1.2', padding: '6px 10px' });
      const doubled = layoutTextEditor(editor, { scale: 2 });
      return { bands, text: layout.lines.map(line => line.source).join(''),
        scales: doubled.lines.map(line => line.source).join('|') === base.lines.map(line => line.source).join('|') &&
          doubled.lines.every((line, i) => line.runs.every((run, j) =>
            Math.abs(run.x - base.lines[i].runs[j].x - 5) < 0.1 &&
            Math.abs(run.baseline - base.lines[i].runs[j].baseline - 3) < 0.6)) };
    } finally { editor.remove(); }
  });
  check('committing the forty-character word paints all five wrapped rows instead of one clipped row',
    raster.bands === 5 && raster.text === 'W'.repeat(40), raster);
  check('text layout converts zoom and textarea content padding into document coordinates', raster.scales, raster);
  for (const zoom of [0.5, 1, 2]) {
    const origin = await page.evaluate(async zoom => {
      const { layoutTextEditor } = await import('/src/text-layout.js');
      const editor = document.createElement('textarea'); editor.className = 'text-editor'; editor.value = 'Word';
      Object.assign(editor.style, { width: `${220 * zoom}px`, fontFamily: 'Arial', fontSize: `${24 * zoom}px`, lineHeight: '1.2' });
      document.querySelector('#stage').append(editor);
      try {
        const bordered = layoutTextEditor(editor, { scale: zoom });
        const css = getComputedStyle(editor), borderLeft = parseFloat(css.borderLeftWidth), borderTop = parseFloat(css.borderTopWidth);
        editor.style.borderWidth = '0';
        const borderless = layoutTextEditor(editor, { scale: zoom });
        return { borderLeft, borderTop, x: bordered.lines[0].runs[0].x - borderless.lines[0].runs[0].x,
          y: bordered.lines[0].runs[0].baseline - borderless.lines[0].runs[0].baseline,
          contentX: bordered.contentX, contentY: bordered.contentY };
      } finally { editor.remove(); }
    }, zoom);
    check(`actual text editor border stays aligned in raster coordinates at ${zoom * 100}%`,
      origin.borderLeft === 1 && origin.borderTop === 1 && Math.abs(origin.x - 1 / zoom) < 0.01 &&
      Math.abs(origin.y - 1 / zoom) < 0.01 && origin.contentX === 1 / zoom && origin.contentY === 1 / zoom, origin);
  }
}
