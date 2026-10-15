// SJ Paint robustness checks: view gestures do not own pending artwork, and
// every drawing tool observes the same hidden-layer admission policy.
export async function verifyDrawingAdmission(page, check) {
  const initial = await page.evaluate(() => ({ project: paintApp.doc.serialize(), state: { ...paintApp.state },
    sizes: ['size', 'size-number'].map(id => document.getElementById(id).value) }));
  const snapshot = () => page.evaluate(() => ({ project: JSON.stringify(paintApp.doc.serialize()),
    png: paintApp.doc.composite().toDataURL(), undo: paintApp.doc._undo.length, redo: paintApp.doc._redo.length,
    transaction: Boolean(paintApp.doc._transaction), selection: paintApp.doc.getSelectionGeometry(),
    session: paintApp.doc.hasSelectionSession, text: document.querySelector('.text-editor')?.value }));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const tool = async name => {
    if (name === 'brush') { await page.locator('[data-menu="brushes"]').click(); await page.locator('[data-command="tool:brush"]').click(); }
    else await page.locator(`[data-tool="${name}"]`).click();
  };
  const move = async (x, y) => {
    const box = await page.locator('#overlay').boundingBox(); await page.mouse.move(box.x + x, box.y + y);
  };
  const click = async (x, y) => { await move(x, y); await page.mouse.down(); await page.mouse.up(); };
  const drag = async (x1, y1, x2, y2) => { await move(x1, y1); await page.mouse.down(); await move(x2, y2); await page.mouse.up(); };
  const reset = async () => {
    await page.keyboard.press('Escape'); await page.mouse.up(); await page.mouse.up({ button: 'middle' });
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      paintApp.doc.newDocument(800, 600);
      Object.assign(paintApp.state, { primary: '#000000', secondary: '#ffffff', size: 5, opacity: 1,
        outline: 'solid', fillStyle: 'none', transparentSelection: false });
      paintApp.setZoom(1);
    });
    await page.waitForFunction(() => document.querySelector('#overlay').width === 800 &&
      Math.abs(document.querySelector('#overlay').getBoundingClientRect().width - 800) < 0.01);
    await page.locator('#viewport').evaluate(viewport => { viewport.scrollTop = 0; viewport.scrollLeft = 0; });
  };
  const start = async name => {
    await tool(name === 'selection' ? 'select' : name);
    if (name === 'text') { await click(20, 20); await page.locator('.text-editor').pressSequentially('Draft'); }
    else if (name === 'polygon') { await click(30, 30); await click(130, 30); await click(80, 100); }
    else if (name === 'selection') { await drag(20, 20, 100, 100); await drag(60, 60, 100, 110); }
    else await drag(30, 30, 130, 100);
  };
  try {
    const cases = ['text', 'rectangle', 'curve', 'polygon', 'selection'].map(name => [name, 'Escape']);
    cases.push(['text', 'pointercancel'], ['text', 'lostpointercapture'], ['text', 'window blur']);
    for (const [name, cancellation] of cases) {
      await reset();
      if (name === 'selection') await page.evaluate(() => {
        const d = paintApp.doc; d.begin('Selection fixture'); d.activeLayer.canvas.getContext('2d').fillRect(30, 30, 40, 40); d.commit(); d.markSaved();
      });
      const original = await snapshot(); await start(name);
      await move(600, 350); await page.mouse.down({ button: 'middle' });
      const before = await snapshot();
      const scrollBefore = await page.locator('#viewport').evaluate(viewport => viewport.scrollTop);
      const pointer = await page.locator('#overlay').boundingBox();
      await page.mouse.move(pointer.x + 600, pointer.y + 310);
      await page.waitForFunction(previous => document.querySelector('#viewport').scrollTop > previous, scrollBefore);
      if (cancellation === 'Escape') await page.keyboard.press('Escape');
      else if (cancellation === 'window blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      else await page.locator('#overlay').evaluate((overlay, type) => {
        const pointerId = Array.from({ length: 16 }, (_, id) => id).find(id => overlay.hasPointerCapture(id));
        if (pointerId === undefined) throw new Error('The real pan did not capture its pointer.');
        overlay.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId, pointerType: 'mouse' }));
      }, cancellation);
      await page.mouse.up({ button: 'middle' });
      check(`${cancellation} cancels only the pan while preserving pending ${name} ownership`, same(before, await snapshot()));
      await tool('pencil');
      const finished = await snapshot();
      check(`${name} remains one undoable edit after its pan is canceled by ${cancellation}`,
        !finished.transaction && !finished.session && finished.text === undefined && finished.png !== original.png && finished.undo === original.undo + 1);
      await page.keyboard.press('Control+z');
      check(`Undo restores the original pixels after committing ${name} following canceled pan`, (await snapshot()).png === original.png);
    }

    for (const name of ['curve', 'polygon']) {
      await reset(); const original = await snapshot(); await start(name);
      await move(600, 350);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      const pending = await snapshot(), preview = await page.locator('#canvas').evaluate(canvas => canvas.toDataURL());
      const scrollBefore = await page.locator('#viewport').evaluate(viewport => viewport.scrollTop);
      await page.mouse.down({ button: 'middle' });
      const pointer = await page.locator('#overlay').boundingBox();
      await page.mouse.move(pointer.x + 600, pointer.y + 310);
      await page.waitForFunction(previous => document.querySelector('#viewport').scrollTop > previous, scrollBefore);
      await page.mouse.up({ button: 'middle' });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      check(`normal pan release restores the pending ${name} preview and transaction`, same(pending, await snapshot()) &&
        await page.locator('#canvas').evaluate(canvas => canvas.toDataURL()) === preview);
      await move(300, 240);
      await page.waitForFunction(previous => document.querySelector('#canvas').toDataURL() !== previous, preview);
      check(`${name} hover editing resumes after normal pan release`, await page.locator('#canvas').evaluate(canvas => canvas.toDataURL()) !== preview);
      await click(300, 240);
      if (name === 'curve') await click(260, 180); else await page.keyboard.press('Enter');
      const finished = await snapshot(); await page.keyboard.press('Control+z');
      check(`continued ${name} after normal pan remains one undoable drawing`, !finished.transaction &&
        finished.png !== original.png && finished.undo === original.undo + 1 && (await snapshot()).png === original.png);
    }

    for (const name of ['brush', 'rectangle', 'fill', 'text', 'polygon', 'curve']) {
      await reset();
      if (!await page.locator('#layers-panel').isVisible()) await page.getByRole('button', { name: 'Layers', exact: true }).click();
      await page.locator('#layer-list [data-visible]').first().click(); await tool(name);
      const before = await snapshot();
      await drag(30, 30, 130, 100);
      check(`hidden active layer rejects ${name} without pixels, history, transaction or draft`,
        same(before, await snapshot()) && await page.locator('#toast').textContent() === 'Show the active layer before drawing.');
      await page.locator('#layer-list [data-visible]').first().click();
      const shown = await snapshot();
      if (name === 'brush') await drag(30, 30, 130, 100);
      else if (name === 'fill') await click(40, 40);
      else await start(name);
      await tool('pencil');
      const drawn = await snapshot();
      check(`${name} can draw normally after its active layer becomes visible`, drawn.png !== shown.png && drawn.undo === shown.undo + 1 && !drawn.transaction);
    }
  } finally {
    await page.keyboard.press('Escape'); await page.mouse.up(); await page.mouse.up({ button: 'middle' }); await page.keyboard.press('Escape');
    await page.evaluate(async initial => {
      await paintApp.doc.load(initial.project); Object.assign(paintApp.state, initial.state); paintApp.setZoom(initial.state.zoom);
      document.querySelector('#layers-panel').hidden = !initial.state.layers;
      ['size', 'size-number'].forEach((id, index) => { document.getElementById(id).value = initial.sizes[index]; });
    }, initial);
    await page.waitForFunction(project => document.querySelector('#overlay').width === project.width && document.querySelector('#overlay').height === project.height,
      initial.project);
  }
}
