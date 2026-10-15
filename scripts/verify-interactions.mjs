// Shared browser and packaged-renderer interaction checks. These use the public
// UI and rendered canvas, so production builds need no development-only API.
import { fileURLToPath } from 'node:url';

export async function verifyInteractions(page, check, { capturePreview = false } = {}) {
  const dimensions = () => page.locator('#canvas').evaluate(canvas => ({ width: canvas.width, height: canvas.height }));
  const same = (a, b) => a.width === b.width && a.height === b.height;
  const status = size => `${size.width} × ${size.height}px`;
  const waitDimensions = size => page.waitForFunction(expected => {
    const canvas = document.querySelector('#canvas');
    return canvas.width === expected.width && canvas.height === expected.height &&
      document.querySelector('#dimensions').textContent === `${expected.width} × ${expected.height}px`;
  }, size, { polling: 100 });
  const waitPreviewHidden = () => page.locator('#canvas-resize-preview').waitFor({ state: 'hidden' });
  const command = async (menu, action) => {
    await page.getByRole('button', { name: menu, exact: true }).click();
    await page.locator(`[data-command="${action}"]`).click();
  };
  const history = async (action, expected) => {
    await page.getByRole('button', { name: action === 'undo' ? 'Undo (Ctrl+Z)' : 'Redo (Ctrl+Y)', exact: true }).click();
    await waitDimensions(expected);
  };
  const zoomTo = async zoom => {
    await page.locator('#zoom-presets').selectOption({ label: `${zoom * 100}%` });
    await page.waitForFunction(expected => {
      const canvas = document.querySelector('#canvas');
      return Math.abs(canvas.getBoundingClientRect().width / canvas.width - expected) < 0.001;
    }, zoom, { polling: 100 });
  };
  const beginResize = async (handle, dx, dy) => {
    const target = page.locator(`.resize-handle[data-handle="${handle}"]`);
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error(`Resize handle ${handle} is not visible.`);
    const zoom = await page.locator('#canvas').evaluate(canvas => canvas.getBoundingClientRect().width / canvas.width);
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx * zoom, y + dy * zoom, { steps: 4 });
    return target;
  };
  const inspectHeld = async (before, expected) => {
    await page.waitForFunction(text => document.querySelector('#dimensions').textContent === text, status(expected), { polling: 100 });
    const preview = page.locator('#canvas-resize-preview');
    await preview.waitFor({ state: 'visible' });
    const result = await page.evaluate(() => {
      const canvas = document.querySelector('#canvas');
      const stage = document.querySelector('#stage').getBoundingClientRect();
      const preview = document.querySelector('#canvas-resize-preview').getBoundingClientRect();
      return { width: canvas.width, height: canvas.height, zoom: canvas.getBoundingClientRect().width / canvas.width,
        stageWidth: stage.width, stageHeight: stage.height, previewWidth: preview.width, previewHeight: preview.height };
    });
    return { ok: same(result, before) && Math.abs(result.stageWidth - before.width * result.zoom) <= 1 &&
      Math.abs(result.stageHeight - before.height * result.zoom) <= 1 &&
      Math.abs(result.previewWidth - expected.width * result.zoom) <= 2 &&
      Math.abs(result.previewHeight - expected.height * result.zoom) <= 2, result };
  };

  const initial = await dimensions();
  check('interaction suite starts with an untouched document', !await page.getByRole('button', { name: 'Undo (Ctrl+Z)', exact: true }).isEnabled());
  // A small canvas keeps every handle and the complete 200% preview inside the
  // test renderer. Properties exercises the same UI on browser and desktop.
  await command('File', 'properties');
  await page.locator('#dialog [name="width"]').fill('200');
  await page.locator('#dialog [name="height"]').fill('140');
  await page.locator('#dialog button[type="submit"]').click();
  const baseline = { width: 200, height: 140 };
  await waitDimensions(baseline);

  for (const zoom of [0.5, 1, 2]) {
    await zoomTo(zoom);
    const grown = { width: 240, height: 165 };
    await beginResize('se', 40, 25);
    const held = await inspectHeld(baseline, grown);
    check(`canvas resize previews live dimensions without changing pixels at ${zoom * 100}%`, held.ok, held.result);
    if (capturePreview && zoom === 1) await page.screenshot({ path: fileURLToPath(new URL('../output/resize-preview.png', import.meta.url)) });
    await page.mouse.up();
    await waitDimensions(grown);
    await waitPreviewHidden();
    check(`canvas resize commits pointer displacement at ${zoom * 100}%`, same(await dimensions(), grown));
    await history('undo', baseline);
    await history('redo', grown);
    await history('undo', baseline);
    check(`canvas resize has one reversible history step at ${zoom * 100}%`, same(await dimensions(), baseline));
  }

  await zoomTo(1);
  await beginResize('nw', -20, -15);
  const northwest = await inspectHeld(baseline, { width: 220, height: 155 });
  const northwestPosition = await page.evaluate(() => {
    const stage = document.querySelector('#stage').getBoundingClientRect();
    const preview = document.querySelector('#canvas-resize-preview').getBoundingClientRect();
    return { x: preview.left - stage.left, y: preview.top - stage.top };
  });
  check('northwest resize previews growth while preserving the opposite edges', northwest.ok &&
    Math.abs(northwestPosition.x + 20) <= 1 && Math.abs(northwestPosition.y + 15) <= 1, northwestPosition);
  await page.mouse.up();
  await waitDimensions({ width: 220, height: 155 });
  await history('undo', baseline);
  check('northwest resize commits and undoes the correct dimensions', same(await dimensions(), baseline));

  for (const [handle, dx, dy, expected] of [
    ['e', 35, 20, { width: 235, height: 140 }],
    ['s', 35, 20, { width: 200, height: 160 }],
    ['se', -30, -20, { width: 170, height: 120 }],
  ]) {
    await beginResize(handle, dx, dy);
    const held = await inspectHeld(baseline, expected);
    check(`canvas ${handle} handle previews ${dx < 0 ? 'shrinkage' : 'its allowed axis'}`, held.ok, held.result);
    await page.mouse.up();
    await waitDimensions(expected);
    await history('undo', baseline);
    check(`canvas ${handle} handle commits and undoes the correct dimensions`, same(await dimensions(), baseline));
  }

  for (const cancellation of ['Escape', 'Control+z', 'pointercancel', 'lostpointercapture']) {
    await page.locator('#zoom-presets').focus();
    const handle = await beginResize('se', 40, 25);
    await inspectHeld(baseline, { width: 240, height: 165 });
    if (cancellation === 'Escape' || cancellation === 'Control+z') await page.keyboard.press(cancellation);
    else await handle.evaluate((element, type) => {
      // Real mouse gestures establish capture. Only interruption events are
      // synthetic because browsers do not expose a portable real-device cancel.
      const pointerId = Array.from({ length: 16 }, (_, id) => id).find(id => element.hasPointerCapture(id));
      if (pointerId === undefined) throw new Error('Resize handle does not own pointer capture.');
      element.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId, pointerType: 'mouse' }));
    }, cancellation);
    await waitPreviewHidden();
    await page.mouse.up();
    await waitDimensions(baseline);
    const redoEnabled = await page.getByRole('button', { name: 'Redo (Ctrl+Y)', exact: true }).isEnabled();
    check(`canvas resize ${cancellation} restores dimensions and preserves redo`, same(await dimensions(), baseline) && redoEnabled);
  }

  // The last committed operation was the 170 x 120 shrink, now undone. A
  // no-op must preserve that redo branch and must not insert another undo item.
  await beginResize('se', 0, 0);
  await page.mouse.up();
  await waitPreviewHidden();
  check('canvas resize no-op retains the redo branch', await page.getByRole('button', { name: 'Redo (Ctrl+Y)', exact: true }).isEnabled());
  await history('redo', { width: 170, height: 120 });
  await history('undo', baseline);
  await history('undo', initial);
  check('canvas resize cancellation and no-op add no history entries', same(await dimensions(), initial));

  // Restore a pristine starting document for the existing browser and packaged
  // workflows. Undo above returns to the saved initial state, so no native
  // chooser, clipboard access, or discard confirmation is required.
  await command('File', 'new');
  await waitDimensions(initial);
  await page.waitForFunction(() => document.querySelector('[data-action="undo"]').disabled &&
    document.querySelector('[data-action="redo"]').disabled, null, { polling: 100 });
  check('interaction suite restores a pristine document', !await page.getByRole('button', { name: 'Undo (Ctrl+Z)', exact: true }).isEnabled());
}
