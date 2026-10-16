// Public text controls and independent raster comparisons. The native resource
// establishes the control's existence, not matching glyph or decoration metrics.
export async function verifyStrikethrough(page, check) {
  const styles = ['bold', 'italic', 'underline', 'strikethrough'];
  const initial = await page.evaluate(styles => ({ project: paintApp.doc.serialize(), state: { ...paintApp.state },
    controls: Object.fromEntries(['font', 'font-size', 'text-align', 'text-background', 'size', 'size-number'].map(id => {
      const el = document.getElementById(id); return [id, { value: el.value, checked: el.checked }];
    })), styles: Object.fromEntries(styles.map(action =>
      [action, document.querySelector(`[data-action="${action}"]`).className])) }), styles);
  const text = 'II II\nII II';
  const reset = async () => {
    await page.keyboard.press('Escape'); await page.mouse.up();
    await page.evaluate(styles => {
      paintApp.doc.newDocument(300, 180);
      Object.assign(paintApp.state, { primary: '#000000', font: 'Arial', fontSize: 32,
        bold: false, italic: false, underline: false, strikethrough: false, textBackground: false, align: 'left' });
      for (const action of styles) document.querySelector(`[data-action="${action}"]`).classList.remove('active');
      document.querySelector('#font').value = 'Arial'; document.querySelector('#font-size').value = '32';
      document.querySelector('#text-align').value = 'left'; document.querySelector('#text-background').checked = false;
      paintApp.setZoom(1);
    }, styles);
    await page.waitForFunction(() => document.querySelector('#overlay').width === 300 &&
      Math.abs(document.querySelector('#overlay').getBoundingClientRect().width - 300) < 0.02);
    await page.locator('[data-tool="text"]').click();
    const bounds = await page.locator('#overlay').boundingBox();
    await page.mouse.click(bounds.x + 20, bounds.y + 20);
    await page.locator('.text-editor').fill(text);
  };
  const snapshot = () => page.evaluate(() => {
    const d = paintApp.doc, editor = document.querySelector('.text-editor');
    return { pixels: d.activeLayer.canvas.toDataURL(), transaction: Boolean(d._transaction),
      undo: d._undo.length, redo: d._redo.length, value: editor?.value,
      decoration: editor ? getComputedStyle(editor).textDecorationLine : null };
  });
  try {
    await reset(); await page.locator('[data-action="commit-text"]').click();
    const plain = await page.evaluate(() => {
      const d = paintApp.doc;
      return [...d.activeLayer.canvas.getContext('2d').getImageData(0, 0, d.width, d.height).data];
    });
    await reset(); const draft = await snapshot();
    await page.locator('[data-action="underline"]').click();
    await page.locator('[data-action="strikethrough"]').click();
    const decorated = await snapshot();
    check('Strikethrough retains the live text draft and its original transaction',
      decorated.value === text && decorated.transaction && decorated.pixels === draft.pixels &&
      decorated.undo === draft.undo && decorated.redo === draft.redo, decorated);
    check('live text supports underline and strikethrough together',
      decorated.decoration.includes('underline') && decorated.decoration.includes('line-through'), decorated.decoration);
    await page.locator('[data-action="underline"]').click();
    check('turning underline off retains strikethrough in the live draft',
      (await snapshot()).decoration === 'line-through');
    await page.locator('[data-action="underline"]').click();
    await page.locator('[data-action="strikethrough"]').click();
    check('turning strikethrough off retains underline in the live draft',
      (await snapshot()).decoration === 'underline');
    await page.locator('[data-action="strikethrough"]').click();
    await page.locator('[data-action="commit-text"]').click();
    const committed = await snapshot();
    const comparison = await page.evaluate(plain => {
      const d = paintApp.doc;
      const pixels = d.activeLayer.canvas.getContext('2d').getImageData(0, 0, d.width, d.height).data;
      const glyphBands = [], additions = []; let keepsInk = true, previousInk = false;
      for (let y = 0; y < d.height; y++) {
        let ink = false, added = 0;
        for (let x = 0; x < d.width; x++) {
          const alpha = (y * d.width + x) * 4 + 3;
          if (plain[alpha]) ink = true;
          if (pixels[alpha] < plain[alpha]) keepsInk = false;
          if (pixels[alpha] > plain[alpha]) added++;
        }
        additions.push(added);
        if (ink && !previousInk) glyphBands.push({ top: y, bottom: y });
        if (ink) glyphBands.at(-1).bottom = y;
        previousInk = ink;
      }
      // An underline alone adds ink below these capital-letter bands. A strike
      // must also span their interior, including the blank gap between words.
      return { keepsInk, glyphBands, interiorStrokes: glyphBands.map(({ top, bottom }) =>
        additions.slice(top + 1, bottom).some(count => count >= 15)) };
    }, plain);
    check('committed strikethrough adds horizontal ink inside both text rows without moving or removing glyphs',
      comparison.keepsInk && comparison.glyphBands.length === 2 && comparison.interiorStrokes.every(Boolean), comparison);
    check('text decoration changes remain one whole text history edit',
      committed.value === undefined && !committed.transaction && committed.undo === draft.undo + 1);
    await page.locator('#overlay').focus(); await page.keyboard.press('Control+z');
    check('one Undo removes the entire decorated text drawing', (await snapshot()).pixels === draft.pixels);
    await page.keyboard.press('Control+y');
    check('one Redo restores the exact committed decorated text pixels', (await snapshot()).pixels === committed.pixels);
  } finally {
    await page.keyboard.press('Escape'); await page.mouse.up();
    await page.evaluate(async initial => {
      await paintApp.doc.load(initial.project); Object.assign(paintApp.state, initial.state); paintApp.setZoom(initial.state.zoom);
      for (const [id, properties] of Object.entries(initial.controls)) Object.assign(document.getElementById(id), properties);
      for (const [action, className] of Object.entries(initial.styles)) document.querySelector(`[data-action="${action}"]`).className = className;
    }, initial);
    await page.waitForFunction(project => document.querySelector('#overlay').width === project.width &&
      document.querySelector('#overlay').height === project.height, initial.project);
  }
}
