// These checks exercise raster allocation/cropping, not native Paint typography.
// The oracle paints the same layout into a full document without using bounds.
export async function verifyTextRasterBounds(page, check) {
  const cases = [
    { name: 'italic overhang', text: 'jfj', font: 'Times New Roman, serif', italic: true, fontSize: 48, x: 40, y: 20 },
    { name: 'RTL ink', text: 'אבגדה עולם', direction: 'rtl', fontSize: 32, x: 30, y: 20 },
    { name: 'fractional origin', text: 'Glyph gyp', fontSize: 24.5, x: 21.375, y: 17.625 },
    { name: 'background and decorations', text: 'Ink gap\n\nMore ink', fontSize: 32, x: 20, y: 20,
      background: '#fff200', underline: true, strikethrough: true },
    { name: 'document edge clipping', text: 'Clipped ink\nDescenders gyp', fontSize: 32, x: 299.75, y: 174.5,
      background: '#fff200', underline: true },
    { name: 'all source off canvas', text: 'Outside\nStill retained', fontSize: 32, x: 460, y: 320,
      background: '#fff200', underline: true, strikethrough: true },
  ];
  for (const fixture of cases) {
    const result = await page.evaluate(async fixture => {
      const { layoutTextEditor, paintTextLayout, rasterizeTextLayout } = await import('/src/text-layout.js');
      const width = 360, height = 220, editor = document.createElement('textarea');
      editor.value = fixture.text;
      Object.assign(editor.style, { position: 'fixed', left: '0', top: '0', width: '240px', height: '180px',
        fontFamily: fixture.font || 'Arial, sans-serif', fontSize: `${fixture.fontSize}px`,
        fontStyle: fixture.italic ? 'italic' : 'normal', fontWeight: '400', lineHeight: '1.2',
        padding: '0', margin: '0', border: '0', boxSizing: 'content-box', whiteSpace: 'pre-wrap',
        overflowWrap: 'break-word', overflow: 'hidden', visibility: 'hidden',
        direction: fixture.direction || 'ltr', textAlign: fixture.direction === 'rtl' ? 'right' : 'left' });
      const oracle = document.createElement('canvas'), actual = document.createElement('canvas');
      oracle.width = actual.width = width; oracle.height = actual.height = height;
      let raster;
      document.body.append(editor);
      try {
        const layout = layoutTextEditor(editor);
        const style = { x: fixture.x, y: fixture.y, color: '#000000', background: fixture.background,
          underline: !!fixture.underline, strikethrough: !!fixture.strikethrough, fontSize: fixture.fontSize };
        // Both surfaces start fresh. Neither the oracle allocation nor its paint
        // coordinates depend on the crop returned by the implementation.
        const referenceContext = oracle.getContext('2d', { willReadFrequently: true });
        const actualContext = actual.getContext('2d', { willReadFrequently: true });
        paintTextLayout(referenceContext, layout, style);
        raster = rasterizeTextLayout(layout, style, { width, height });
        if (raster) actualContext.drawImage(raster.canvas, raster.x, raster.y);
        const reference = referenceContext.getImageData(0, 0, width, height).data;
        const rendered = actualContext.getImageData(0, 0, width, height).data;
        let differentPixels = 0, maxDelta = 0, inkPixels = 0;
        let left = width, top = height, right = -1, bottom = -1;
        for (let i = 0; i < reference.length; i += 4) {
          if (reference[i + 3]) inkPixels++;
          let differs = false;
          for (let channel = 0; channel < 4; channel++) {
            const delta = Math.abs(reference[i + channel] - rendered[i + channel]);
            if (delta) differs = true;
            maxDelta = Math.max(maxDelta, delta);
          }
          if (differs) {
            differentPixels++;
            const x = (i / 4) % width, y = Math.floor(i / 4 / width);
            left = Math.min(left, x); top = Math.min(top, y);
            right = Math.max(right, x); bottom = Math.max(bottom, y);
          }
        }
        referenceContext.font = layout.font; referenceContext.direction = layout.direction;
        referenceContext.textAlign = 'left'; referenceContext.textBaseline = 'alphabetic';
        referenceContext.letterSpacing = layout.letterSpacing; referenceContext.wordSpacing = layout.wordSpacing;
        const overhang = layout.lines.flatMap(line => line.runs).some(run => {
          const metric = referenceContext.measureText(run.text);
          return metric.actualBoundingBoxLeft > 0 || metric.actualBoundingBoxRight > metric.width;
        });
        const placement = raster && { x: raster.x, y: raster.y, width: raster.canvas.width, height: raster.canvas.height };
        const bounded = !raster || (Number.isInteger(raster.x) && Number.isInteger(raster.y) &&
          raster.x >= 0 && raster.y >= 0 && raster.canvas.width > 0 && raster.canvas.height > 0 &&
          raster.x + raster.canvas.width <= width && raster.y + raster.canvas.height <= height);
        const offCanvas = fixture.name === 'all source off canvas';
        const relevant = offCanvas ? !raster && inkPixels === 0 : !!raster && inkPixels > 0;
        const edgeClipped = fixture.name !== 'document edge clipping' || (!!raster &&
          raster.x + raster.canvas.width === width && raster.y + raster.canvas.height === height);
        return { differentPixels, maxDelta, differenceBounds: differentPixels ? { left, top, right, bottom } : null,
          inkPixels, placement, bounded, relevant, edgeClipped, overhang,
          sourceRetained: layout.lines.map(line => line.source).join('') === fixture.text };
      } finally {
        editor.remove(); oracle.width = actual.width = 0;
        if (raster) raster.canvas.width = raster.canvas.height = 0;
      }
    }, fixture);
    check(`bounded text raster exactly matches uncropped paint for ${fixture.name}`,
      result.differentPixels === 0 && result.bounded && result.relevant && result.edgeClipped &&
      result.sourceRetained && (fixture.name !== 'italic overhang' || result.overhang), result);
  }
}
