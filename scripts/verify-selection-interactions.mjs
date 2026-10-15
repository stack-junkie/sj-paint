// Reference-backed selection lifecycle checks: Escape cancels a released move;
// Undo cancels it and Redo restores committed moved pixels without handles.
// Development APIs establish fixtures and inspect state; selection operations
// themselves use the public toolbar, real mouse gestures, and keyboard input.
export async function verifySelectionInteractions(page, check) {
  const initial = await page.evaluate(() => ({ project: paintApp.doc.serialize(), state: { ...paintApp.state } }));
  const snapshot = () => page.evaluate(() => {
    const d = paintApp.doc;
    return { project: JSON.stringify(d.serialize()), png: d.composite().toDataURL(), revision: d.revision,
      dirty: d.dirty, undo: d._undo.length, redo: d._redo.length, session: d.hasSelectionSession,
      selection: d.selection ? { x: d.selection.x, y: d.selection.y, width: d.selection.width, height: d.selection.height } : null };
  });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const move = async (x, y) => {
    const box = await page.locator('#overlay').boundingBox();
    const zoom = await page.locator('#zoom-presets').inputValue();
    await page.mouse.move(box.x + x * Number(zoom), box.y + y * Number(zoom), { steps: 4 });
  };
  const drag = async (x1, y1, x2, y2) => {
    await move(x1, y1); await page.mouse.down(); await move(x2, y2); await page.mouse.up();
  };
  const click = async (x, y) => { await move(x, y); await page.mouse.down(); await page.mouse.up(); };
  const setZoom = async zoom => {
    await page.locator('#zoom-presets').selectOption({ label: `${zoom * 100}%` });
    await page.waitForFunction(expected => {
      const canvas = document.querySelector('#canvas');
      return Math.abs(canvas.getBoundingClientRect().width / canvas.width - expected) < 0.001;
    }, zoom, { polling: 100 });
  };
  const fixture = async (small = false) => {
    await page.keyboard.press('Escape'); await page.mouse.up();
    await page.evaluate(small => {
      const d = paintApp.doc;
      d.newDocument(small ? 12 : 240, small ? 10 : 160);
      Object.assign(paintApp.state, { transparentSelection: false, name: 'Untitled', project: false, format: 'png' });
      d.setSelectionTransparency(false, '#ffffff');
      d.begin('Red selection fixture');
      const c = d.activeLayer.canvas.getContext('2d'); c.fillStyle = '#ff0000';
      if (small) c.fillRect(3, 2, 7, 6); else c.fillRect(30, 30, 40, 30);
      d.commit(); d.markSaved();
      // Existing redo must survive a canceled selection session unchanged.
      d.begin('Existing redo fixture'); d.activeLayer.canvas.getContext('2d').fillStyle = '#0000ff';
      d.activeLayer.canvas.getContext('2d').fillRect(0, 0, 1, 1); d.commit(); d.undo();
      paintApp.setZoom(1);
    }, small);
    await page.waitForFunction(width => document.querySelector('#canvas').width === width, small ? 12 : 240, { polling: 100 });
    await setZoom(small ? 8 : 1);
    await page.locator('[data-tool="select"]').click();
    return snapshot();
  };
  const select = async () => {
    await drag(20, 20, 80, 70);
    await page.waitForFunction(() => paintApp.doc.selection?.width === 60 && paintApp.doc.selection?.height === 50,
      null, { polling: 100 });
  };
  const selectAndMove = async () => {
    await select(); await drag(50, 45, 120, 85);
    await page.waitForFunction(() => paintApp.doc.selection?.x === 90 && paintApp.doc.selection?.y === 60,
      null, { polling: 100 });
  };
  const waitPixels = expected => page.waitForFunction(png => paintApp.doc.composite().toDataURL() === png,
    expected, { polling: 100 });

  try {
    const untouched = await fixture();
    await select();
    const entered = await snapshot();
    await page.keyboard.press('Enter');
    check('Enter retains an unchanged selection and its handles', same(entered, await snapshot()));
    await page.keyboard.press('Control+z');
    check('Undo of an unchanged selection removes handles without undoing earlier artwork', same(untouched, await snapshot()));

    const original = await fixture();
    await selectAndMove();
    const moved = await snapshot();
    check('released selection move remains an engine-owned session with changed visible pixels',
      moved.session === true && moved.png !== original.png && moved.selection?.x === 90 && moved.selection?.y === 60);
    await page.keyboard.press('Escape');
    await waitPixels(original.png);
    check('Escape after releasing a moved selection restores original pixels, history, redo, and saved state',
      same(original, await snapshot()));
    await page.keyboard.press('Control+y');
    check('canceled selection retains the actual prior redo edit', await page.evaluate(() => {
      const d = paintApp.doc, pixel = d.composite().getContext('2d').getImageData(0, 0, 1, 1).data;
      return pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 255 && pixel[3] === 255 && !d.selection;
    }));

    const beforeResize = await fixture();
    await select(); await drag(80, 70, 100, 90);
    await page.waitForFunction(() => paintApp.doc.selection?.width === 80 && paintApp.doc.selection?.height === 70,
      null, { polling: 100 });
    check('released selection resize remains a pending session', await page.evaluate(() => paintApp.doc.hasSelectionSession));
    await page.keyboard.press('Escape'); await waitPixels(beforeResize.png);
    check('Escape after selection resizing restores the complete original session state', same(beforeResize, await snapshot()));

    const beforeUndo = await fixture();
    await selectAndMove(); const movedForRedo = await snapshot();
    await page.keyboard.press('Control+z'); await waitPixels(beforeUndo.png);
    const undone = await snapshot();
    check('Undo after a pending selection move restores original artwork and drops selection handles',
      undone.png === beforeUndo.png && !undone.selection && undone.session === false &&
      !undone.dirty && undone.undo === beforeUndo.undo && undone.redo > 0);
    await page.keyboard.press('Control+y'); await waitPixels(movedForRedo.png);
    const redone = await snapshot();
    check('Redo after selection Undo restores moved pixels as committed raster without handles',
      redone.png === movedForRedo.png && !redone.selection && redone.session === false &&
      redone.dirty && redone.undo === beforeUndo.undo + 1);

    for (const settlement of ['outside click', 'tool change']) {
      const before = await fixture(); await selectAndMove(); const preview = await snapshot();
      if (settlement === 'outside click') await click(190, 120);
      else await page.locator('[data-tool="pencil"]').click();
      const committed = await snapshot();
      check(`selection ${settlement} commits moved pixels in one history step`, committed.png === preview.png &&
        !committed.selection && committed.session === false && committed.undo === before.undo + 1 && committed.redo === 0);
      await page.locator('#overlay').focus(); await page.keyboard.press('Control+z'); await waitPixels(before.png);
      check(`one Undo restores original pixels after selection ${settlement}`, await page.evaluate(() => !paintApp.doc.selection));
      await page.keyboard.press('Control+y'); await waitPixels(preview.png);
      check(`one Redo restores committed moved pixels after selection ${settlement}`, await page.evaluate(() => !paintApp.doc.selection && !paintApp.doc.hasSelectionSession));
    }

    for (const [name, endX, endY, width, height] of [
      ['1 by N', 4, 8, 1, 6], ['N by 1', 10, 3, 7, 1], ['1 by 1', 4, 3, 1, 1],
    ]) {
      const before = await fixture(true);
      await drag(3, 2, endX, endY);
      const thin = await snapshot();
      check(`${name} selection can be created by a real pointer gesture at 800%`,
        thin.selection?.width === width && thin.selection?.height === height && thin.session === true &&
        thin.png === before.png && thin.undo === before.undo && thin.redo === before.redo);
      await page.keyboard.press('Escape');
      check(`${name} selection cancellation preserves pixels and existing history`, same(before, await snapshot()));
    }
    const beforeClick = await fixture(true);
    await click(3, 2);
    check('a no-motion click creates no one-pixel selection or history entry', same(beforeClick, await snapshot()));
  } finally {
    await page.keyboard.press('Escape'); await page.mouse.up();
    await page.evaluate(async saved => {
      await paintApp.doc.load(saved.project);
      Object.assign(paintApp.state, saved.state);
      document.querySelector('#layers-panel').hidden = !saved.state.layers;
      paintApp.setZoom(saved.state.zoom);
    }, initial);
    await page.waitForFunction(saved => document.querySelector('#canvas').width === saved.project.width &&
      document.querySelector('#canvas').height === saved.project.height && document.querySelector('[data-action="undo"]').disabled,
    initial, { polling: 100 });
  }
}
