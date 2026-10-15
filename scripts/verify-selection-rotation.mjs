// Reference observations cover free rotation, Escape, and layered AABB crop.
// Source preservation, inverse transforms, and anchoring are robustness checks.
// Fixtures and inspections use the development API; edits use public gestures.
export async function verifySelectionRotation(page, check) {
  const initial = await page.evaluate(() => ({ project: paintApp.doc.serialize(), state: { ...paintApp.state } }));
  const snapshot = () => page.evaluate(() => {
    const d = paintApp.doc, s = d.selection;
    return { png: d.composite().toDataURL(), project: JSON.stringify(d.serialize()),
      width: d.width, height: d.height, revision: d.revision, dirty: d.dirty,
      undo: d._undo.length, redo: d._redo.length, session: d.hasSelectionSession,
      geometry: s ? d.getSelectionGeometry({ zoom: paintApp.state.zoom }) : null,
      source: s ? { png: s.canvas.toDataURL(), width: s.canvas.width, height: s.canvas.height,
        mask: Array.from(s.mask) } : null };
  });
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const near = (a, b, tolerance = 0.05) => Math.hypot(a[0] - b[0], a[1] - b[1]) < tolerance;
  const geometry = () => page.evaluate(() => paintApp.doc.getSelectionGeometry({ zoom: paintApp.state.zoom }));
  const move = async ([x, y]) => {
    const bounds = await page.locator('#overlay').boundingBox();
    const zoom = Number(await page.locator('#zoom-presets').inputValue());
    await page.mouse.move(bounds.x + x * zoom, bounds.y + y * zoom, { steps: 6 });
  };
  const drag = async (start, end) => {
    await move(start); await page.mouse.down(); await move(end); await page.mouse.up();
  };
  const waitPixels = expected => page.waitForFunction(value => paintApp.doc.composite().toDataURL() === value,
    expected, { polling: 100 });
  const select = async () => {
    await drag([100, 100], [220, 180]);
    await page.waitForFunction(() => paintApp.doc.selection?.canvas.width === 120 && paintApp.doc.selection?.canvas.height === 80,
      null, { polling: 100 });
  };
  const fixture = async (layers = false) => {
    await page.keyboard.press('Escape'); await page.mouse.up();
    await page.evaluate(layers => {
      const d = paintApp.doc;
      d.newDocument(480, 360);
      Object.assign(paintApp.state, { transparentSelection: false, grid: false, rulers: false,
        name: 'Untitled', project: false, format: 'png' });
      d.setSelectionTransparency(false, '#ffffff');
      if (layers) {
        d.begin('Lower layer fixture');
        const c = d.activeLayer.canvas.getContext('2d');
        c.fillStyle = '#113355'; c.fillRect(0, 0, 480, 360);
        c.fillStyle = '#22cc55'; c.fillRect(145, 0, 7, 360);
        c.fillStyle = '#ffee11'; c.fillRect(0, 155, 480, 9);
        d.commit(); d.addLayer('Selected artwork');
      }
      d.begin('Asymmetric selection fixture');
      const c = d.activeLayer.canvas.getContext('2d');
      c.fillStyle = '#ed1c24'; c.fillRect(105, 105, 108, 67);
      c.clearRect(170, 105, 43, 25);
      c.fillStyle = '#0000ff'; c.fillRect(110, 150, 16, 17);
      c.fillStyle = '#ffffff';
      for (let x = 133; x < 165; x += 3) c.fillRect(x, 133, 1, 31);
      d.commit(); d.markSaved(); paintApp.setZoom(1);
    }, layers);
    await page.waitForFunction(() => {
      const c = document.querySelector('#canvas');
      return c.width === 480 && c.height === 360 && Math.abs(c.getBoundingClientRect().width - 480) < 0.01;
    }, null, { polling: 100 });
    await page.locator('[data-tool="select"]').click();
    return snapshot();
  };
  const rotate = async (degrees, held = false) => {
    const g = await geometry(), radians = degrees * Math.PI / 180;
    const dx = g.rotationHandle[0] - g.center[0], dy = g.rotationHandle[1] - g.center[1];
    const end = [g.center[0] + dx * Math.cos(radians) - dy * Math.sin(radians),
      g.center[1] + dx * Math.sin(radians) + dy * Math.cos(radians)];
    await move(g.rotationHandle); await page.mouse.down(); await move(end);
    if (!held) await page.mouse.up();
    return g;
  };

  try {
    const original = await fixture(); await select(); const captured = await snapshot();
    await rotate(35, true); const held = await snapshot();
    check('rotation handle transforms visible selection while held without resampling its source',
      held.session && held.png !== original.png && held.undo === original.undo && equal(held.source, captured.source));
    check('held rotation keeps the selection center and rotates its frame',
      near(held.geometry.center, captured.geometry.center) && !near(held.geometry.corners[0], captured.geometry.corners[0]));
    await page.mouse.up(); const released = await snapshot();
    check('released free rotation retains its editable oriented frame',
      released.session && equal(held.geometry, released.geometry) && released.undo === original.undo);
    await page.keyboard.press('Enter');
    check('Enter retains the rotated selection and its pending edit', equal(released, await snapshot()));
    await page.keyboard.press('Escape'); await waitPixels(original.png);
    check('Escape after released free rotation restores original pixels and history', equal(original, await snapshot()));

    for (const position of ['button edge', 'outside canvas']) {
      const before = await fixture(); await select();
      if (position === 'outside canvas') {
        const g = await geometry(); await drag(g.center, [g.center[0], g.center[1] - 94]);
      }
      await page.locator('#selection-rotation').waitFor({ state: 'visible' });
      const g = await geometry(), button = await page.locator('#selection-rotation').boundingBox();
      const overlay = await page.locator('#overlay').boundingBox();
      const start = position === 'button edge'
        ? [button.x + button.width - 1, button.y + button.height / 2]
        : [button.x + button.width / 2, button.y + button.height / 2];
      check(`rotation ${position} fixture hits the public DOM button`, await page.evaluate(([x, y]) =>
        Boolean(document.elementFromPoint(x, y)?.closest('#selection-rotation')), start));
      if (position === 'outside canvas') check('top selection exposes its rotation button outside the canvas', start[1] < overlay.y);
      const capturedPointer = await page.evaluateHandle(() => {
        const eventState = { id: null };
        document.querySelector('#selection-rotation').addEventListener('pointerdown', event => { eventState.id = event.pointerId; }, { once: true });
        return eventState;
      });
      try {
        await page.mouse.move(...start); await page.mouse.down();
        check(`rotation ${position} transfers pointer capture to the overlay`, await capturedPointer.evaluate(event =>
          event.id !== null && document.querySelector('#overlay').hasPointerCapture(event.id)));
        const center = [overlay.x + g.center[0], overlay.y + g.center[1]], radians = Math.PI / 6;
        const dx = start[0] - center[0], dy = start[1] - center[1];
        await page.mouse.move(center[0] + dx * Math.cos(radians) - dy * Math.sin(radians),
          center[1] + dx * Math.sin(radians) + dy * Math.cos(radians), { steps: 6 });
        check(`rotation ${position} updates the oriented frame during capture`, !near((await geometry()).corners[0], g.corners[0]));
        await page.keyboard.press('Escape');
        check(`Escape releases the ${position} rotation pointer`, await capturedPointer.evaluate(event =>
          !document.querySelector('#overlay').hasPointerCapture(event.id)));
        await page.mouse.up(); await waitPixels(before.png);
        check(`Escape during ${position} rotation restores the original session`, equal(before, await snapshot()));
      } finally { await capturedPointer.dispose(); }
    }

    const beforeUndo = await fixture(); await select(); await rotate(35); const rotated = await snapshot();
    await page.keyboard.press('Control+z'); await waitPixels(beforeUndo.png);
    const undone = await snapshot();
    check('Undo of pending free rotation restores original artwork and removes handles',
      !undone.session && !undone.geometry && undone.undo === beforeUndo.undo && !undone.dirty);
    await page.keyboard.press('Control+y'); await waitPixels(rotated.png);
    const redone = await snapshot();
    check('Redo restores free rotation as committed raster without handles',
      !redone.session && !redone.geometry && redone.undo === beforeUndo.undo + 1);

    await fixture(); await select(); const source = (await snapshot()).source;
    await rotate(35); const beforeMove = await geometry();
    await drag(beforeMove.center, [beforeMove.center[0] + 25, beforeMove.center[1] + 18]);
    const moved = await geometry();
    check('moving a rotated selection translates every oriented corner',
      moved.corners.every((point, i) => near(point, [beforeMove.corners[i][0] + 25, beforeMove.corners[i][1] + 18])));
    const nw = moved.corners[0], se = moved.corners[2];
    const expanded = [nw[0] + (se[0] - nw[0]) * 1.25, nw[1] + (se[1] - nw[1]) * 1.25];
    await drag(se, expanded); const resized = await geometry();
    check('resizing the rotated southeast corner preserves the opposite corner', near(resized.corners[0], nw) &&
      Math.abs(resized.frameWidth / moved.frameWidth - 1.25) < 0.01 &&
      Math.abs(resized.frameHeight / moved.frameHeight - 1.25) < 0.01);
    check('move and anchored resize retain original source pixels and mask', equal(source, (await snapshot()).source));
    await drag(resized.corners[2], se);
    check('inverse anchored resize restores the pre-resize oriented frame',
      (await geometry()).corners.every((point, i) => near(point, moved.corners[i])));

    const beforeInverse = await fixture(); await select(); const inverseSource = (await snapshot()).source;
    for (let repeat = 0; repeat < 3; repeat++) { await rotate(35); await rotate(-35); }
    const inverse = await snapshot();
    check('repeated forward and inverse free rotations do not degrade source pixels or mask', equal(inverse.source, inverseSource));
    check('inverse rotations restore the original visible artwork', inverse.png === beforeInverse.png);

    const layeredOriginal = await fixture(true); await select(); await rotate(57);
    const beforeCrop = await snapshot();
    const expectedCrop = await page.evaluate(() => {
      const d = paintApp.doc, g = d.getSelectionGeometry(), b = g.bounds;
      const expectedLayer = layer => {
        const c = document.createElement('canvas'); c.width = b.width; c.height = b.height;
        c.getContext('2d').drawImage(layer, -b.x, -b.y); return c.toDataURL();
      };
      return { bounds: b, lower: expectedLayer(d.layers[0].canvas), composite: expectedLayer(d.composite()),
        independentWidth: Math.ceil(Math.max(...g.corners.map(p => p[0]))) - Math.floor(Math.min(...g.corners.map(p => p[0]))),
        independentHeight: Math.ceil(Math.max(...g.corners.map(p => p[1]))) - Math.floor(Math.min(...g.corners.map(p => p[1]))) };
    });
    await page.getByRole('button', { name: 'Crop', exact: true }).click();
    await page.waitForFunction(({ width, height }) => paintApp.doc.width === width && paintApp.doc.height === height,
      expectedCrop.bounds, { polling: 100 });
    const cropped = await snapshot();
    check('rotated selection crop uses the oriented frame raster AABB',
      cropped.width === expectedCrop.independentWidth && cropped.height === expectedCrop.independentHeight && !cropped.geometry);
    const cropPixels = await page.evaluate(async expected => {
      const d = paintApp.doc, actual = d.composite(), image = new Image(); image.src = expected.composite; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = actual.width; canvas.height = actual.height;
      canvas.getContext('2d').drawImage(image, 0, 0);
      const a = actual.getContext('2d').getImageData(0, 0, actual.width, actual.height).data;
      const b = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let differingPixels = 0; const examples = [];
      for (let i = 0; i < a.length; i += 4) if (a.slice(i, i + 4).some((value, channel) => value !== b[i + channel])) {
        differingPixels++; if (examples.length < 4) examples.push({ x: i / 4 % actual.width, y: Math.floor(i / 4 / actual.width), actual: [...a.slice(i, i + 4)], expected: [...b.slice(i, i + 4)] });
      }
      return { lowerUnchanged: d.layers.length === 2 && d.layers[0].canvas.toDataURL() === expected.lower, differingPixels, examples, bounds: expected.bounds };
    }, expectedCrop);
    check('rotated crop preserves selected artwork and crops the lower layer without rotating it',
      cropped.png === expectedCrop.composite && cropPixels.lowerUnchanged, cropPixels);
    await page.locator('#overlay').focus(); await page.keyboard.press('Control+z'); await waitPixels(beforeCrop.png);
    const uncropped = await snapshot();
    check('first Undo after rotated crop restores full canvas with committed rotated pixels and no handles',
      uncropped.width === 480 && uncropped.height === 360 && !uncropped.geometry && !uncropped.session);
    await page.keyboard.press('Control+z'); await waitPixels(layeredOriginal.png);
    check('second Undo after rotated crop restores the original unrotated layers',
      (await snapshot()).undo === layeredOriginal.undo);
  } finally {
    await page.keyboard.press('Escape'); await page.mouse.up();
    await page.evaluate(async saved => {
      await paintApp.doc.load(saved.project); Object.assign(paintApp.state, saved.state);
      document.querySelector('#layers-panel').hidden = !saved.state.layers;
      paintApp.setZoom(saved.state.zoom);
    }, initial);
    await page.waitForFunction(saved => document.querySelector('#canvas').width === saved.project.width &&
      document.querySelector('#canvas').height === saved.project.height && document.querySelector('[data-action="undo"]').disabled,
    initial, { polling: 100 });
  }
}
