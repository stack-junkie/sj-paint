// Requires an owned hidden packaged instance, pristine default document and
// configured approved EfficientSAM pair. No private document/engine, chooser,
// clipboard, launch, model download or main-process inspector is used here.
export async function verifyObjectSelectionDesktop(page, check) {
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const snapshot = () => page.evaluate(async () => {
    const canvas = document.querySelector('#canvas'), png = canvas.toDataURL();
    const image = new Image(); image.src = png; await image.decode();
    const copy = document.createElement('canvas'); copy.width = image.width; copy.height = image.height;
    const context = copy.getContext('2d', { willReadFrequently: true }); context.drawImage(image, 0, 0);
    const point = (x, y) => [...context.getImageData(x, y, 1, 1).data];
    return { png, width: image.width, height: image.height, title: document.title,
      left: point(Math.floor(image.width / 4), Math.floor(image.height / 2)),
      right: point(Math.floor(image.width * 3 / 4), Math.floor(image.height / 2)),
      undo: !document.querySelector('[data-action="undo"]').disabled,
      redo: !document.querySelector('[data-action="redo"]').disabled,
      selection: !document.querySelector('#selection-rotation').hidden };
  });
  // Capture PNGs first and decode separate canvases, so readback cannot switch
  // the live document/display raster backend and change subsequent rendering.
  const difference = (expected, actual) => page.evaluate(async ({ expected, actual }) => {
    const decode = async png => {
      const image = new Image(); image.src = png; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(image, 0, 0);
      return { width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data };
    };
    const a = await decode(expected), b = await decode(actual);
    if (a.width !== b.width || a.height !== b.height) return { equal: false, dimensions: [a.width, a.height, b.width, b.height] };
    let channels = 0, max = 0;
    for (let i = 0; i < a.data.length; i++) { const delta = Math.abs(a.data[i] - b.data[i]); if (delta) { channels++; max = Math.max(max, delta); } }
    return { equal: channels === 0, differingChannels: channels, maxAbsoluteDifference: max };
  }, { expected, actual });
  const checkPixels = async (name, expected, actual) => { const diff = await difference(expected.png, actual.png); check(name, diff.equal, diff); };
  const sameState = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const initial = await page.evaluate(() => ({
    tool: document.querySelector('[data-tool][aria-pressed="true"]')?.dataset.tool,
    label: document.querySelector('#tool-label').textContent,
    size: document.querySelector('#size-number').value, zoom: document.querySelector('#zoom-presets').value,
    scroll: [document.querySelector('#viewport').scrollLeft, document.querySelector('#viewport').scrollTop],
    defaultColors: getComputedStyle(document.querySelector('#primary')).backgroundColor === 'rgb(0, 0, 0)' &&
      getComputedStyle(document.querySelector('#secondary')).backgroundColor === 'rgb(255, 255, 255)',
    opacity: document.querySelector('#opacity').value, dialog: !!document.querySelector('dialog[open]'),
  }));
  const blank = await snapshot();
  if (blank.width !== 1152 || blank.height !== 648 || blank.title !== 'Untitled - Stack Junkie Paint' ||
      blank.undo || blank.redo || blank.selection || !initial.defaultColors || initial.opacity !== '100' || initial.dialog) {
    throw new Error('Object selection desktop checks require a pristine default Untitled document and default colors/opacity.');
  }
  const status = () => page.evaluate(() => window.paintDesktop.localAiStatus());
  const initialStatus = await status();
  check('packaged object selection is configured without an existing worker lease', initialStatus.ok &&
    initialStatus.value.features?.['efficientsam-ti']?.configured && !initialStatus.value.active &&
    !initialStatus.value.retainedSelection && !initialStatus.value.ownsProcess && !initialStatus.value.cleanupBlocked, initialStatus);
  const panel = page.getByRole('dialog', { name: 'Object select', exact: true });
  const key = async value => { await page.locator('#overlay').focus(); await page.keyboard.press(value); await frame(); };
  const clickCanvas = async (x, y) => {
    const canvas = await page.locator('#overlay').evaluate(el => ({ width: el.width, height: el.height }));
    const rect = await page.locator('#overlay').boundingBox();
    await page.mouse.click(rect.x + x * rect.width / canvas.width, rect.y + y * rect.height / canvas.height); await frame();
  };
  const fixture = async (width, height, size) => {
    await page.locator('#zoom-presets').selectOption(width > 1024 ? '.5' : '1'); await frame();
    await page.locator('#viewport').evaluate(el => { el.scrollLeft = 0; el.scrollTop = 0; });
    await page.locator('[data-tool="fill"]').click(); await page.locator('[data-color="#ffffff"]').click(); await clickCanvas(2, 2);
    await page.getByRole('button', { name: 'Brushes', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Brush', exact: true }).click();
    await page.locator('#size-number').fill(String(size)); await page.locator('#size-number').press('Tab');
    await page.locator('[data-color="#ed1c24"]').click(); await clickCanvas(width / 4, height / 2);
    const redOnly = await snapshot();
    await page.locator('[data-color="#3f48cc"]').click(); await clickCanvas(width * 3 / 4, height / 2);
    const source = await snapshot();
    check(`public brush fixture has separate red and blue subjects at ${width} by ${height}`, source.left[0] > 200 &&
      source.left[1] < 60 && source.right[2] > 150 && source.right[0] < 100 && source.left[3] === 255 && source.right[3] === 255,
    { left: source.left, right: source.right });
    return { source, redOnly };
  };
  const open = async () => {
    await page.locator('[data-menu="selection"]').click(); await page.getByRole('menuitem', { name: 'Object select', exact: true }).click();
    await panel.waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const d = document.querySelector('.object-selection-dialog');
      return d && (!d.querySelector('fieldset').disabled || /Close this dialog/i.test(d.querySelector('[role="status"]').textContent));
    }, null, { timeout: 60_000 });
    check('real packaged image preparation enables public prompt controls', await panel.getByRole('button', { name: 'Add point', exact: true }).isEnabled(), await panel.getByRole('status').textContent());
    const current = await status();
    check('real preparation retains exactly one idle image embedding', current.ok && current.value.retainedSelection &&
      current.value.ownsProcess && !current.value.active && !current.value.cleanupBlocked, current);
    return current.value.retainedSelection;
  };
  const waitPreview = async () => {
    await page.waitForFunction(() => {
      const d = document.querySelector('.object-selection-dialog');
      return d && (!d.querySelector('[type="submit"]').disabled || /Close this dialog|No object was found/i.test(d.querySelector('[role="status"]').textContent));
    }, null, { timeout: 30_000 });
    check('real packaged decoder produces an explicit selection preview', await panel.getByRole('button', { name: 'Apply', exact: true }).isEnabled(), await panel.getByRole('status').textContent());
  };
  const point = async (x, y) => {
    const overlay = page.locator('.object-selection-overlay');
    const dimensions = await overlay.evaluate(canvas => ({ width: canvas.width, height: canvas.height }));
    const bounds = await overlay.boundingBox();
    await page.mouse.click(bounds.x + (x + .25) * bounds.width / dimensions.width,
      bounds.y + (y + .25) * bounds.height / dimensions.height);
    await waitPreview();
  };
  const finish = async action => {
    await panel.getByRole('button', { name: action, exact: true }).click(); await panel.waitFor({ state: 'hidden', timeout: 45_000 }); await frame();
    const current = await status();
    check(`${action} releases the retained worker before leaving the dialog`, current.ok && !current.value.active &&
      !current.value.retainedSelection && !current.value.ownsProcess && !current.value.cleanupBlocked, current);
    check(`${action} removes the drawing prompt overlay`, await page.locator('.object-selection-overlay').count() === 0);
  };
  let owned = false;
  try {
    owned = true;
    const large = await fixture(1152, 648, 200);
    const scaled = await open();
    check('default document prepares a bounded 1024 by 576 preview with explicit scale notice', scaled.width === 1024 && scaled.height === 576 &&
      /1024 × 576.*1152 × 648/.test(await panel.locator('.object-selection-scale').textContent()), scaled);
    await point(256, 288); await finish('Apply');
    const scaledSelection = await snapshot();
    check('scaled mask becomes a normal selection on the original 1152 by 648 document', scaledSelection.selection && scaledSelection.width === 1152 && scaledSelection.height === 648);
    await checkPixels('scaled preview Apply preserves original pixels exactly', large.source, scaledSelection);
    await key('Escape'); await checkPixels('scaled selection Escape restores original pixels exactly', large.source, await snapshot());
    // Only the three owned fill/brush strokes precede this resize.
    for (let i = 0; i < 3; i++) await key('Control+z');
    await checkPixels('scaled scenario adds no content history beyond its fixture', blank, await snapshot());
    await key('Control+e');
    const properties = page.getByRole('dialog', { name: 'Image properties', exact: true });
    await properties.getByLabel('Width', { exact: true }).fill('256'); await properties.getByLabel('Height', { exact: true }).fill('128');
    await properties.getByRole('button', { name: 'OK', exact: true }).click(); await properties.waitFor({ state: 'hidden' }); await frame();
    const small = await fixture(256, 128, 64);
    await open(); await point(64, 64);
    check('point preview leaves drawing and public history untouched', sameState(small.source, await snapshot()));
    await finish('Cancel');
    check('point preview Cancel leaves drawing and public history untouched', sameState(small.source, await snapshot()));
    await key('Control+z'); await checkPixels('point Cancel adds no history entry before the blue stroke', small.redOnly, await snapshot());
    await key('Control+y'); await checkPixels('Redo after preview Cancel restores both original subjects exactly', small.source, await snapshot());
    await open(); await point(64, 64); await finish('Apply');
    check('point Apply creates a normal editable selection', (await snapshot()).selection);
    await checkPixels('point Apply keeps the original drawing pixels', small.source, await snapshot());
    await key('Shift+ArrowRight'); await key('Control+Space');
    const moved = await snapshot();
    check('real point selection can be moved with ordinary selection controls', moved.png !== small.source.png);
    await key('Control+z'); await checkPixels('one Undo restores exact pixels after real object move', small.source, await snapshot());
    await key('Control+y'); await checkPixels('one Redo restores exact pixels after real object move', moved, await snapshot());
    await key('Control+z');
    await open(); await point(64, 64); await finish('Apply');
    await key('Delete'); const deleted = await snapshot();
    check('point selection Delete removes the marked subject while retaining its neighbor', !deleted.selection &&
      deleted.left.join(',') === '255,255,255,255' && deleted.right.join(',') === small.source.right.join(','),
    { left: deleted.left, right: deleted.right });
    await key('Control+z'); await checkPixels('one Undo restores exact pixels after real object Delete', small.source, await snapshot());
    await key('Control+y'); await checkPixels('one Redo restores exact pixels after real object Delete', deleted, await snapshot());
    await key('Control+z');
    await open(); await panel.getByRole('combobox', { name: 'Prompt type', exact: true }).selectOption('box');
    for (const [label, value] of [['Box left', 24], ['Box top', 24], ['Box right', 104], ['Box bottom', 104]]) await panel.getByLabel(label, { exact: true }).fill(String(value));
    await panel.getByRole('button', { name: 'Set box', exact: true }).click(); await waitPreview(); await finish('Apply');
    check('real box prompt creates an editable selection', (await snapshot()).selection);
    await key('Delete'); const boxed = await snapshot();
    check('box selection removes the enclosed subject while retaining its neighbor', boxed.left.join(',') === '255,255,255,255' &&
      boxed.right.join(',') === small.source.right.join(','), { left: boxed.left, right: boxed.right });
    await key('Control+z'); await checkPixels('box selection Undo restores exact original pixels', small.source, await snapshot());
  } finally {
    if (await panel.count()) {
      await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
      await panel.waitFor({ state: 'hidden', timeout: 45_000 });
    }
    const finalStatus = await status();
    if (!finalStatus.ok || finalStatus.value.active || finalStatus.value.retainedSelection || finalStatus.value.ownsProcess || finalStatus.value.cleanupBlocked) {
      throw new Error(`Object selection fixture cleanup is unresolved: ${JSON.stringify(finalStatus)}`);
    }
    await page.mouse.up(); await key('Escape');
    if (owned) {
      for (let i = 0; i < 12 && await page.locator('[data-action="undo"]').isEnabled(); i++) await key('Control+z');
      if (await page.locator('[data-action="undo"]').isEnabled()) throw new Error('Object selection fixture exceeded its owned history cleanup bound.');
      await key('Control+n');
    }
    if (initial.tool) await page.locator(`[data-tool="${initial.tool}"]`).click();
    else { await page.getByRole('button', { name: 'Brushes', exact: true }).click(); await page.getByRole('menuitemradio', { name: initial.label, exact: true }).click(); }
    await page.locator('[data-color="#000000"]').click(); await page.locator('[data-color="#ffffff"]').click({ button: 'right' });
    await page.locator('#size-number').fill(initial.size); await page.locator('#size-number').press('Tab');
    await page.locator('#zoom-presets').selectOption(initial.zoom); await frame();
    await page.locator('#viewport').evaluate((el, scroll) => { [el.scrollLeft, el.scrollTop] = scroll; }, initial.scroll);
  }
  const restored = await snapshot();
  await checkPixels('object selection desktop fixture restores pristine original pixels', blank, restored);
  check('object selection desktop fixture restores empty history and saved title', !restored.undo && !restored.redo && !restored.selection && restored.title === blank.title);
}
