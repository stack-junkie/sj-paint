// These regressions establish coherent gesture ownership and document history.
// They do not assert Microsoft Paint's unobserved keyboard or touch policies.
export async function verifyGestureCancellation(page, check) {
  const initial = await page.evaluate(() => ({ width: paintApp.doc.width, height: paintApp.doc.height, state: { ...paintApp.state } }));
  const snapshot = () => page.evaluate(() => {
    const d = paintApp.doc;
    return { png: d.composite().toDataURL(), revision: d.revision, dirty: d.dirty,
      undo: d._undo.length, redo: d._redo.length, transaction: !!d._transaction,
      selection: d.selection ? { x: d.selection.x, y: d.selection.y, width: d.selection.width, height: d.selection.height,
        png: d.selection.canvas.toDataURL() } : null };
  });
  const unchanged = (before, after) => JSON.stringify(before) === JSON.stringify(after);
  const tool = async name => page.locator(`[data-tool="${name}"]`).click();
  const move = async (x, y) => {
    const bounds = await page.locator('#overlay').boundingBox();
    const zoom = await page.evaluate(() => paintApp.state.zoom);
    await page.mouse.move(bounds.x + x * zoom, bounds.y + y * zoom, { steps: 4 });
  };
  const click = async (x, y) => { await move(x, y); await page.mouse.down(); await page.mouse.up(); };
  const drag = async (x1, y1, x2, y2, release = true) => {
    await move(x1, y1); await page.mouse.down(); await move(x2, y2);
    if (release) await page.mouse.up();
  };
  const reset = async () => {
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.evaluate(() => {
      paintApp.doc.newDocument(200, 160);
      Object.assign(paintApp.state, { primary: '#000000', secondary: '#ffffff', size: 5, opacity: 1, outline: 'solid', fillStyle: 'none' });
      paintApp.setZoom(1);
    });
    await page.waitForFunction(() => document.querySelector('#canvas').width === 200 &&
      document.querySelector('#canvas').height === 160 && !document.querySelector('#title').textContent.includes('•'), null, { polling: 100 });
  };
  const interrupt = async type => {
    if (type === 'Escape') await page.keyboard.press('Escape');
    else await page.locator('#overlay').evaluate((overlay, eventType) => {
      const pointerId = Array.from({ length: 16 }, (_, id) => id).find(id => overlay.hasPointerCapture(id));
      if (pointerId === undefined) throw new Error('Expected the real mouse gesture to own pointer capture.');
      overlay.dispatchEvent(new PointerEvent(eventType, { bubbles: true, pointerId, pointerType: 'mouse' }));
    }, type);
    await page.mouse.up();
  };
  const cleanPending = () => page.evaluate(() => !paintApp.doc._transaction &&
    window.dispatchEvent(new Event('beforeunload', { cancelable: true })));

  for (const selectedTool of ['pencil', 'rectangle']) {
    await reset(); await tool(selectedTool);
    const before = await snapshot();
    await drag(20, 20, 95, 80, false);
    check(`${selectedTool} gesture opens a document transaction`, await page.evaluate(() => !!paintApp.doc._transaction));
    await page.keyboard.press('Escape');
    await move(125, 100); await page.mouse.up();
    check(`Escape rolls back ${selectedTool} without a late pointer-up commit`, unchanged(before, await snapshot()) && await cleanPending());
  }

  await reset(); await tool('select');
  await page.evaluate(() => {
    const d = paintApp.doc;
    d.begin('Selection fixture');
    d.activeLayer.canvas.getContext('2d').fillRect(15, 15, 30, 30);
    d.commit(); d.markSaved();
  });
  const selected = await snapshot();
  await page.evaluate(() => paintApp.doc.selectRect(10, 10, 50, 50));
  await drag(35, 35, 90, 70, false);
  check('selection drag actually moves the selected artwork', await page.evaluate(() => paintApp.doc.selection.x !== 10));
  await interrupt('Escape');
  check('Escape restores the pre-selection pixels and history', unchanged(selected, await snapshot()) && await cleanPending());

  for (const selectedTool of ['curve', 'polygon']) {
    for (const cancellation of ['Escape', 'pointercancel', 'lostpointercapture']) {
      await reset(); await tool(selectedTool);
      const before = await snapshot();
      if (selectedTool === 'curve') await drag(20, 20, 100, 80);
      else await click(20, 20);
      check(`${selectedTool} remains pending between clicks before ${cancellation}`, await page.evaluate(() => !!paintApp.doc._transaction && !paintApp.doc.dirty));
      if (cancellation !== 'Escape') { await move(65, 25); await page.mouse.down(); }
      await interrupt(cancellation);
      check(`${cancellation} clears pending ${selectedTool} and its transaction`, unchanged(before, await snapshot()) && await cleanPending());

      // Finish a new shape of the same type, rather than changing tools, so a
      // stale curve/polygon or canceled transaction cannot hide behind reset.
      if (selectedTool === 'curve') {
        await drag(20, 20, 100, 80); await click(60, 10); await click(100, 110);
      } else {
        await click(20, 20); await click(100, 20); await click(60, 110); await page.keyboard.press('Enter');
      }
      const finished = await snapshot();
      check(`${selectedTool} drawn after ${cancellation} records pixels and one undo step`,
        finished.png !== before.png && finished.dirty && finished.undo === before.undo + 1 && !finished.transaction);
      await page.keyboard.press('Control+z');
      const undone = await snapshot();
      check(`${selectedTool} drawn after ${cancellation} can be undone`,
        undone.png === before.png && !undone.dirty && undone.undo === before.undo && !undone.transaction && await cleanPending());
    }
  }

  await reset(); await tool('pencil');
  await drag(20, 20, 100, 30);
  await page.evaluate(() => paintApp.doc.markSaved());
  const priorStroke = await snapshot();
  await drag(20, 65, 100, 75, false);
  await page.keyboard.press('Control+z');
  await move(140, 80); await page.mouse.up();
  check('Undo during a stroke cancels only that gesture and preserves the preceding edit', unchanged(priorStroke, await snapshot()) && await cleanPending());
  await drag(20, 110, 100, 120);
  const followingStroke = await snapshot();
  check('a fresh stroke after interrupted undo paints the current layer and records history',
    followingStroke.png !== priorStroke.png && followingStroke.dirty && followingStroke.undo === priorStroke.undo + 1);
  await page.keyboard.press('Control+z');
  check('undoing that fresh stroke restores the saved preceding artwork', await page.evaluate(expected =>
    paintApp.doc.composite().toDataURL() === expected && !paintApp.doc.dirty, priorStroke.png));

  await reset(); await tool('pencil');
  await drag(20, 20, 75, 65, false);
  const owned = await snapshot();
  await page.locator('#overlay').evaluate(overlay => {
    // A second physical device is not available in the headless runner. Only
    // the foreign pointer is synthetic; the owned gesture remains a real mouse.
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
      overlay.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 99999,
        pointerType: 'touch', button: 0, buttons: 1, clientX: 1, clientY: 1 }));
    }
  });
  check('foreign pointer events cannot replace, move, or finish the owned gesture', unchanged(owned, await snapshot()));
  await move(125, 105); await page.mouse.up();
  const released = await snapshot();
  check('the owning pointer can still finish after foreign events', released.dirty && released.undo === 1 && !released.transaction);

  await reset(); await tool('pencil');
  const resizeBefore = await snapshot();
  const resizeHandle = page.locator('.resize-handle[data-handle="se"]');
  const handleBounds = await resizeHandle.boundingBox();
  const handleX = handleBounds.x + handleBounds.width / 2, handleY = handleBounds.y + handleBounds.height / 2;
  await page.mouse.move(handleX, handleY); await page.mouse.down();
  await page.mouse.move(handleX + 20, handleY + 15, { steps: 4 });
  await page.locator('#canvas-resize-preview').waitFor({ state: 'visible' });
  await page.locator('#overlay').evaluate(overlay => {
    const bounds = overlay.getBoundingClientRect();
    for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
      overlay.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 99999,
        pointerType: 'touch', button: 0, buttons: 1, clientX: bounds.left + 20, clientY: bounds.top + 20 }));
    }
  });
  check('an overlay pointer cannot start drawing inside an owned canvas resize',
    unchanged(resizeBefore, await snapshot()) && await page.locator('#canvas-resize-preview').isVisible());
  await page.mouse.up();
  await page.waitForFunction(() => paintApp.doc.width === 220 && paintApp.doc.height === 175, null, { polling: 100 });
  const resizeReleased = await snapshot();
  check('the resize owner still commits exactly one history step after a foreign overlay pointer',
    resizeReleased.dirty && resizeReleased.undo === 1 && !resizeReleased.transaction);

  await reset(); await tool('pencil');
  await drag(20, 20, 75, 65, false);
  const strokeBeforeResize = await snapshot();
  await resizeHandle.evaluate(handle => {
    const bounds = handle.getBoundingClientRect();
    for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
      handle.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 99999,
        pointerType: 'touch', button: 0, buttons: 1, clientX: bounds.left + 20, clientY: bounds.top + 20 }));
    }
  });
  check('a resize handle pointer cannot steal an owned drawing gesture',
    unchanged(strokeBeforeResize, await snapshot()) && !await page.locator('#canvas-resize-preview').isVisible());
  await move(125, 105); await page.mouse.up();
  const strokeReleased = await snapshot();
  check('the drawing owner still commits exactly one history step after a foreign resize pointer',
    strokeReleased.dirty && strokeReleased.undo === 1 && !strokeReleased.transaction &&
    await page.evaluate(() => paintApp.doc.width === 200 && paintApp.doc.height === 160));

  await reset(); await tool('pencil');
  const beforeZoom = await snapshot();
  await drag(20, 20, 80, 65, false);
  await page.keyboard.press('Control+=');
  await move(120, 95); await page.mouse.up();
  check('zoom during a held gesture rolls back its pixels and releases ownership',
    unchanged(beforeZoom, await snapshot()) && await page.evaluate(() => paintApp.state.zoom > 1) && await cleanPending());

  await reset();
  await page.evaluate(saved => {
    paintApp.doc.newDocument(saved.width, saved.height);
    Object.assign(paintApp.state, saved.state);
    paintApp.setZoom(saved.state.zoom);
  }, initial);
  await page.waitForFunction(saved => document.querySelector('#canvas').width === saved.width &&
    document.querySelector('#canvas').height === saved.height && document.querySelector('[data-action="undo"]').disabled,
  initial, { polling: 100 });
}
