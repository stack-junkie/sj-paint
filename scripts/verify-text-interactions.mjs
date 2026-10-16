// Public text gestures, with engine inspection limited to pixels and ownership.
// These checks establish editing robustness, not complete native text parity.
export async function verifyTextInteractions(page, check) {
  const initial = await page.evaluate(() => ({ project: paintApp.doc.serialize(), state: { ...paintApp.state },
    controls: Object.fromEntries(['font', 'font-size', 'text-align', 'text-background', 'size', 'size-number'].map(id => {
      const el = document.getElementById(id); return [id, { value: el.value, checked: el.checked }];
    })), styles: Object.fromEntries(['bold', 'italic', 'underline'].map(action =>
      [action, document.querySelector(`[data-action="${action}"]`).className])) }));
  const reset = async () => {
    await page.keyboard.press('Escape'); await page.mouse.up();
    await page.evaluate(() => {
      paintApp.doc.newDocument(240, 220);
      Object.assign(paintApp.state, { primary: '#000000', font: 'Arial', fontSize: 24,
        bold: false, italic: false, underline: false, textBackground: false, align: 'left' });
      paintApp.setZoom(1);
    });
    await page.waitForFunction(() => document.querySelector('#overlay').width === 240 && document.querySelector('#overlay').height === 220);
    await page.locator('[data-tool="text"]').click();
  };
  const type = async text => {
    const bounds = await page.locator('#overlay').boundingBox();
    await page.mouse.click(bounds.x + 20, bounds.y + 20);
    await page.locator('.text-editor').pressSequentially(text);
  };
  const snapshot = () => page.evaluate(() => ({ pixels: paintApp.doc.activeLayer.canvas.toDataURL(),
    transaction: Boolean(paintApp.doc._transaction), undo: paintApp.doc._undo.length, redo: paintApp.doc._redo.length,
    value: document.querySelector('.text-editor')?.value }));
  const ink = () => page.evaluate(() => {
    const d = paintApp.doc, data = d.activeLayer.canvas.getContext('2d').getImageData(0, 0, d.width, d.height).data;
    let minX = d.width, bands = 0, previous = false;
    for (let y = 0; y < d.height; y++) {
      let row = false;
      for (let x = 0; x < d.width; x++) if (data[(y * d.width + x) * 4 + 3]) { minX = Math.min(minX, x); row = true; }
      if (row && !previous) bands++; previous = row;
    }
    return { minX, bands };
  });
  try {
    await reset(); await type('W'.repeat(40));
    const draft = await snapshot();
    await page.locator('[data-action="commit-text"]').click();
    const committed = await snapshot(), longWord = await ink();
    check('public Apply text preserves all five wrapped rows of a long unbroken word', longWord.bands === 5, longWord);
    check('Apply text commits one owned history edit and removes the editor',
      draft.transaction && !committed.transaction && committed.value === undefined && committed.undo === draft.undo + 1);
    await page.keyboard.press('Control+z');
    check('one Undo removes the entire wrapped text drawing', (await snapshot()).pixels === draft.pixels);

    await reset(); await type('indented'); await page.locator('[data-action="commit-text"]').click();
    const unindented = await ink();
    await reset(); await type('    indented'); await page.locator('[data-action="commit-text"]').click();
    const indented = await ink();
    const spaces = await page.evaluate(() => { const c = document.createElement('canvas').getContext('2d'); c.font = '24px Arial'; return c.measureText('    ').width; });
    check('public Apply text preserves the visible leading-space indentation', Math.abs(indented.minX - unindented.minX - spaces) <= 1,
      { unindented, indented, spaces });

    await reset();
    await page.evaluate(() => {
      const d = paintApp.doc; d.begin('Prior redo fixture');
      d.activeLayer.canvas.getContext('2d').fillRect(200, 200, 5, 5); d.commit(); d.undo();
    });
    await type('Draft'); await page.locator('[data-action="bold"]').click();
    await page.locator('[data-action="bold"]').focus();
    const beforeRedo = await snapshot(); await page.keyboard.press('Control+y');
    const afterRedo = await snapshot();
    check('Ctrl+Y from a focused text-style button preserves the draft transaction and prior redo',
      beforeRedo.transaction && JSON.stringify(beforeRedo) === JSON.stringify(afterRedo), { beforeRedo, afterRedo });
    await page.locator('.text-editor').focus(); await page.keyboard.press('End'); await page.keyboard.type(' continues');
    const beforeColor = await snapshot(); await page.getByRole('button', { name: 'Edit colors', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#dialog').open);
    check('opening Edit colors retains the editable text and its transaction', JSON.stringify(await snapshot()) === JSON.stringify(beforeColor));
    await page.locator('#dialog-cancel').click();
    check('canceling Edit colors preserves the draft pixels, text, history and ownership', JSON.stringify(await snapshot()) === JSON.stringify(beforeColor));
    await page.keyboard.press('Escape');
    check('Escape after text-style and color-dialog interactions clears the draft without consuming redo',
      await page.evaluate(() => !document.querySelector('.text-editor') && !paintApp.doc._transaction && paintApp.doc._redo.length === 1));
  } finally {
    if (await page.locator('#dialog').evaluate(dialog => dialog.open)) await page.locator('#dialog-cancel').click();
    await page.keyboard.press('Escape'); await page.mouse.up();
    await page.evaluate(async initial => {
      await paintApp.doc.load(initial.project); Object.assign(paintApp.state, initial.state); paintApp.setZoom(initial.state.zoom);
      for (const [id, properties] of Object.entries(initial.controls)) Object.assign(document.getElementById(id), properties);
      for (const [action, className] of Object.entries(initial.styles)) document.querySelector(`[data-action="${action}"]`).className = className;
    }, initial);
    await page.waitForFunction(project => document.querySelector('#overlay').width === project.width && document.querySelector('#overlay').height === project.height,
      initial.project);
  }
}
