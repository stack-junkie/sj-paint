// Native observations establish square clearing and Color 1 to Color 2 replacement
// with alpha preserved. Cancellation/history/zoom checks establish robustness.
// Fixtures use the engine; every eraser edit uses public pointer interactions.
export async function verifyEraserInteractions(page, check) {
  const initial = await page.evaluate(() => ({ project: paintApp.doc.serialize(), state: { ...paintApp.state },
    controls: Object.fromEntries(['size', 'size-number', 'opacity', 'opacity-value'].map(id => [id, document.getElementById(id).value])) }));
  const snapshot = () => page.evaluate(() => {
    const d = paintApp.doc;
    return { project: JSON.stringify(d.serialize()), revision: d.revision, dirty: d.dirty,
      undo: d._undo.length, redo: d._redo.length, transaction: Boolean(d._transaction) };
  });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const move = async (x, y, steps = 1) => {
    const bounds = await page.locator('#overlay').boundingBox();
    const zoom = await page.locator('#overlay').evaluate(canvas => canvas.getBoundingClientRect().width / canvas.width);
    await page.mouse.move(bounds.x + x * zoom, bounds.y + y * zoom, { steps });
  };
  const stroke = async (x1, y1, x2 = x1, y2 = y1, { button = 'left', held = false } = {}) => {
    await move(x1, y1); await page.mouse.down({ button });
    if (x1 !== x2 || y1 !== y2) await move(x2, y2);
    if (!held) await page.mouse.up({ button });
  };
  const size = async value => {
    await page.locator('#size-number').fill(String(value)); await page.locator('#size-number').press('Tab');
  };
  const fixture = async (zoom = 1) => {
    await page.keyboard.press('Escape'); await page.mouse.up(); await page.mouse.up({ button: 'right' });
    await page.evaluate(() => {
      const d = paintApp.doc; d.newDocument(160, 120); d.setBackground(null);
      d.begin('Lower blue layer'); const lower = d.activeLayer.canvas.getContext('2d');
      lower.fillStyle = '#0000ff'; lower.fillRect(0, 0, 160, 120); d.commit();
      d.addLayer('Eraser target'); d.begin('Red and green eraser fixture');
      const c = d.activeLayer.canvas.getContext('2d'); c.fillStyle = '#ff0000'; c.fillRect(0, 0, 160, 120);
      c.clearRect(70, 20, 40, 30);
      c.fillStyle = 'rgba(255,0,0,0.25098039215686274)'; c.fillRect(70, 20, 20, 30);
      c.fillStyle = 'rgba(255,0,0,0.5019607843137255)'; c.fillRect(90, 20, 20, 30);
      c.fillStyle = '#00ff00'; c.fillRect(110, 20, 35, 30); d.commit(); d.markSaved();
      d.begin('Prior redo fixture'); c.fillStyle = '#ffffff'; c.fillRect(150, 110, 1, 1); d.commit(); d.undo();
      Object.assign(paintApp.state, { primary: '#ff0000', secondary: '#ffffff', opacity: 1, grid: false, rulers: false });
      document.querySelector('#opacity').value = '100'; document.querySelector('#opacity-value').value = '100%';
      paintApp.setZoom(1);
    });
    await page.waitForFunction(() => document.querySelector('#canvas').width === 160 && document.querySelector('#canvas').height === 120,
      null, { polling: 100 });
    await page.locator('#zoom-presets').selectOption({ label: `${zoom * 100}%` });
    await page.waitForFunction(zoom => Math.abs(document.querySelector('#canvas').getBoundingClientRect().width / 160 - zoom) < 0.001,
      zoom, { polling: 100 });
    await page.locator('[data-tool="eraser"]').click(); await size(8);
    await page.locator('[data-color="#00a2e8"]').click({ button: 'right' });
    return snapshot();
  };
  const pixels = coordinates => page.evaluate(coordinates => {
    const d = paintApp.doc, c = d.activeLayer.canvas.getContext('2d');
    return coordinates.map(([x, y]) => [...c.getImageData(x, y, 1, 1).data]);
  }, coordinates);
  const erased = () => page.evaluate(() => {
    const d = paintApp.doc, data = d.activeLayer.canvas.getContext('2d').getImageData(0, 0, d.width, d.height).data;
    const result = []; for (let p = 0; p < data.length; p += 4) if (data[p + 3] === 0) result.push([p / 4 % d.width, Math.floor(p / 4 / d.width)]);
    return result;
  });
  try {
    for (const zoom of [0.5, 1, 2]) {
      const before = await fixture(zoom); await stroke(30, 80); const cleared = await erased();
      check(`zoom preset remains selected at ${zoom * 100}%`, await page.locator('#zoom-presets').evaluate((select, label) =>
        select.selectedOptions[0]?.textContent === label, `${zoom * 100}%`));
      check(`eraser cursor matches its document footprint at ${zoom * 100}%`, await page.locator('#eraser-cursor').evaluate((cursor, zoom) =>
        !cursor.hidden && Number.parseFloat(cursor.style.width) === 8 * zoom && Number.parseFloat(cursor.style.height) === 8 * zoom &&
        Number.parseFloat(cursor.style.left) === 26 * zoom && Number.parseFloat(cursor.style.top) === 76 * zoom, zoom));
      check(`left eraser is an exact eight-pixel transparent square at ${zoom * 100}%`, cleared.length === 64 &&
        cleared.every(([x, y]) => x >= 26 && x < 34 && y >= 76 && y < 84),
      { count: cleared.length, first: cleared[0], last: cleared.at(-1), size: await page.locator('#size-number').inputValue() });
      check(`left eraser records one undoable change at ${zoom * 100}%`, (await snapshot()).undo === before.undo + 1 && (await snapshot()).dirty);
      await page.keyboard.press('Control+z');
      const undone = await snapshot();
      check(`Undo restores eraser pixels and saved state at ${zoom * 100}%`, undone.project === before.project && !undone.dirty && undone.undo === before.undo);
      await page.keyboard.press('Control+y');
      check(`Redo restores the transparent eraser square at ${zoom * 100}%`, same(await erased(), cleared));
    }

    // Keep the physical pointer fixed: recalculating only cursor dimensions can
    // conceal a stale document-space hover position after the viewport changes.
    const cursorAt = client => page.evaluate(({ x, y }) => {
      const canvas = document.querySelector('#overlay'), rect = canvas.getBoundingClientRect();
      const zoom = rect.width / canvas.width, size = Number(document.querySelector('#size-number').value);
      const cursor = document.querySelector('#eraser-cursor');
      const actual = ['left', 'top', 'width', 'height'].map(key => Number.parseFloat(cursor.style[key]));
      const expected = [Math.floor((x - rect.left) / zoom - size / 2) * zoom,
        Math.floor((y - rect.top) / zoom - size / 2) * zoom, size * zoom, size * zoom];
      return { actual, expected, zoom, hidden: cursor.hidden,
        matches: !cursor.hidden && actual.every((value, index) => Math.abs(value - expected[index]) < 0.01) };
    }, client);
    const zoomBefore = await fixture(2);
    const zoomRect = await page.locator('#overlay').boundingBox();
    const zoomPointer = { x: zoomRect.x + 60.5, y: zoomRect.y + 160.5 };
    await page.mouse.move(zoomPointer.x, zoomPointer.y);
    const cursorBeforeZoom = await cursorAt(zoomPointer);
    await page.keyboard.down('Control');
    try { await page.mouse.wheel(0, -200); } finally { await page.keyboard.up('Control'); }
    await page.waitForFunction(() => document.querySelector('#overlay').getBoundingClientRect().width / 160 > 2.01);
    const cursorAfterZoom = await cursorAt(zoomPointer);
    check('stationary eraser cursor stays under the physical pointer after Ctrl+wheel zoom',
      cursorBeforeZoom.matches && cursorAfterZoom.matches && !same(cursorBeforeZoom.actual, cursorAfterZoom.actual), cursorAfterZoom);
    check('hover zoom leaves document pixels and history unchanged', same(zoomBefore, await snapshot()));

    const scrollBefore = await fixture(8);
    const viewportRect = await page.locator('#viewport').boundingBox();
    const scrollRect = await page.locator('#overlay').boundingBox();
    const scrollPointer = { x: Math.max(viewportRect.x, scrollRect.x) + 100.5,
      y: Math.max(viewportRect.y, scrollRect.y) + 150.5 };
    await page.mouse.move(scrollPointer.x, scrollPointer.y);
    const cursorBeforeScroll = await cursorAt(scrollPointer);
    const previousScroll = await page.locator('#viewport').evaluate(viewport => viewport.scrollTop);
    await page.mouse.wheel(0, 160);
    await page.waitForFunction(previous => document.querySelector('#viewport').scrollTop > previous, previousScroll);
    // Allow the scroll event's cursor render to finish without generating a move.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const cursorAfterScroll = await cursorAt(scrollPointer);
    check('stationary eraser cursor follows the new document position after viewport scrolling',
      cursorBeforeScroll.matches && cursorAfterScroll.matches && cursorAfterScroll.expected[1] > cursorBeforeScroll.expected[1], cursorAfterScroll);
    check('hover scrolling leaves document pixels and history unchanged', same(scrollBefore, await snapshot()));

    const sweepBefore = await fixture();
    const lowerBefore = await page.evaluate(() => paintApp.doc.layers[0].canvas.toDataURL());
    await stroke(20, 80, 120, 80); const swept = await erased();
    check('one sparse mouse move produces a continuous square eraser sweep including both endpoints', swept.length === 108 * 8 &&
      swept.every(([x, y]) => x >= 16 && x < 124 && y >= 76 && y < 84));
    check('erasing the active layer reveals the unchanged lower layer', await page.evaluate(expected =>
      paintApp.doc.layers[0].canvas.toDataURL() === expected &&
      [...paintApp.doc.composite().getContext('2d').getImageData(60, 80, 1, 1).data].join(',') === '0,0,255,255', lowerBefore));
    await page.keyboard.press('Control+z');
    check('one Undo restores the entire eraser sweep', (await snapshot()).project === sweepBefore.project);

    await fixture(); await stroke(30, 30, 135, 30, { button: 'right' });
    const replaced = await pixels([[40, 30], [80, 30], [100, 30], [125, 30], [40, 40]]);
    check('right eraser replaces opaque Color 1 with Color 2 and leaves unmatched green untouched',
      same(replaced[0], [0, 162, 232, 255]) && same(replaced[3], [0, 255, 0, 255]) && same(replaced[4], [255, 0, 0, 255]), replaced);
    check('right eraser preserves alpha 64 and 128 while replacing the selected red',
      replaced[1][3] === 64 && replaced[2][3] === 128 && [replaced[1], replaced[2]].every(pixel =>
        pixel[0] === 0 && Math.abs(pixel[1] - 162) <= 2 && Math.abs(pixel[2] - 232) <= 2), replaced.slice(1, 3));
    const replacedSnapshot = await snapshot(); await page.keyboard.press('Control+z'); await page.keyboard.press('Control+y');
    check('color replacement is restored by one Undo and Redo', (await snapshot()).project === replacedSnapshot.project);

    const noOp = await fixture(); await stroke(120, 30, 135, 30, { button: 'right' });
    check('right eraser over unmatched green preserves saved state, history and prior redo', same(noOp, await snapshot()));
    await page.locator('[data-menu="brushes"]').click(); await page.locator('[data-command="tool:brush"]').click();
    await page.locator('#opacity').focus(); await page.locator('#opacity').press('Home');
    check('eraser opacity fixture first sets brush opacity below full strength', await page.evaluate(() => paintApp.state.opacity < 1));
    await page.locator('[data-tool="eraser"]').click(); await size(8); await stroke(30, 80);
    check('left eraser clears fully after using a low-opacity brush', same((await pixels([[30, 80]]))[0], [0, 0, 0, 0]));

    for (const cancellation of ['Escape', 'pointercancel', 'lostpointercapture']) {
      const before = await fixture(); await stroke(20, 80, 100, 80, { held: true });
      check(`eraser held before ${cancellation} owns one pending transaction`, await page.evaluate(() => Boolean(paintApp.doc._transaction)));
      if (cancellation === 'Escape') await page.keyboard.press('Escape');
      else await page.locator('#overlay').evaluate((overlay, type) => {
        const pointerId = Array.from({ length: 16 }, (_, id) => id).find(id => overlay.hasPointerCapture(id));
        if (pointerId === undefined) throw new Error('The real eraser gesture did not capture its pointer.');
        overlay.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId, pointerType: 'mouse' }));
      }, cancellation);
      await move(130, 90); await page.mouse.up();
      check(`${cancellation} rolls back erasure without a late pointer-up commit`, same(before, await snapshot()));
      await stroke(30, 80);
      check(`a fresh eraser gesture after ${cancellation} remains tracked by history`, (await snapshot()).undo === before.undo + 1 && (await erased()).length === 64);
    }
    for (const command of ['layer switch', 'visibility']) {
      const before = await fixture();
      if (!await page.locator('#layers-panel').isVisible()) await page.getByRole('button', { name: 'Layers', exact: true }).click();
      const layers = await page.evaluate(() => paintApp.doc.layers.map(layer => ({ id: layer.id, png: layer.canvas.toDataURL() })));
      await stroke(20, 80, 100, 80, { held: true });
      if (command === 'layer switch') {
        // A second input source activates the public row click handler while the
        // real mouse owns capture; layer rows do not yet support keyboard entry.
        await page.locator(`#layer-list [data-layer="${layers[0].id}"]`).dispatchEvent('click');
      } else {
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
        await page.locator('#layer-list [data-visible]').first().focus();
        await page.keyboard.press('Space');
      }
      const afterCommand = await snapshot(); await move(130, 90); await page.mouse.up();
      check(`${command} during held erasure cancels the stroke before changing layer state`,
        !afterCommand.transaction && same(afterCommand, await snapshot()) && await page.evaluate(layers =>
          paintApp.doc.layers.every((layer, index) => layer.canvas.toDataURL() === layers[index].png), layers));
      if (command === 'layer switch') {
        await stroke(30, 80);
        check('erasing after a held-stroke layer switch targets only the newly active layer', await page.evaluate(layers => {
          const d = paintApp.doc;
          return d.activeLayerId === layers[0].id && d.layers[0].canvas.getContext('2d').getImageData(30, 80, 1, 1).data[3] === 0 &&
            d.layers[1].canvas.toDataURL() === layers[1].png;
        }, layers));
      } else {
        check('visibility change after canceling erasure creates only its own history edit', afterCommand.undo === before.undo + 1);
      }
    }
  } finally {
    await page.keyboard.press('Escape'); await page.mouse.up(); await page.mouse.up({ button: 'right' });
    await page.evaluate(async saved => {
      await paintApp.doc.load(saved.project); Object.assign(paintApp.state, saved.state);
      for (const [id, value] of Object.entries(saved.controls)) document.getElementById(id).value = value;
      document.querySelector('#layers-panel').hidden = !saved.state.layers; paintApp.setZoom(saved.state.zoom);
    }, initial);
    await page.waitForFunction(saved => document.querySelector('#canvas').width === saved.project.width &&
      document.querySelector('#canvas').height === saved.project.height && document.querySelector('[data-action="undo"]').disabled,
    initial, { polling: 100 });
  }
}
