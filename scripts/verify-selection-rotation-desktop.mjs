import { chooseShapeStyle } from './shape-style-controls.mjs';
// Packaged app coverage uses public UI and rendered pixels, without paintApp.
export async function verifySelectionRotationDesktop(page, check) {
  const pixels = () => page.locator('#canvas').evaluate(canvas => canvas.toDataURL());
  const waitPixels = expected => page.waitForFunction(value => document.querySelector('#canvas').toDataURL() === value,
    expected, { polling: 100 });
  const rotation = page.getByRole('button', { name: 'Rotate selection', exact: true });
  const waitControls = visible => page.waitForFunction(value => !document.querySelector('#selection-rotation').hidden === value,
    visible, { polling: 100 });
  const move = async (x, y) => {
    const box = await page.locator('#overlay').boundingBox();
    await page.mouse.move(box.x + x, box.y + y, { steps: 6 });
  };
  const drag = async (x1, y1, x2, y2) => {
    await move(x1, y1); await page.mouse.down(); await move(x2, y2); await page.mouse.up();
  };
  const undo = page.getByRole('button', { name: 'Undo (Ctrl+Z)', exact: true });
  check('desktop rotation fixture starts without undo history', !await undo.isEnabled());
  await page.locator('#zoom-presets').selectOption({ label: '100%' });
  await page.waitForFunction(() => {
    const canvas = document.querySelector('#canvas');
    return Math.abs(canvas.getBoundingClientRect().width - canvas.width) < 0.01;
  }, null, { polling: 100 });
  const blank = await pixels();
  await page.locator('[data-tool="rectangle"]').click();
  await page.locator('[data-color="#ed1c24"]').click();
  await chooseShapeStyle(page, 'outline', 'solid');
  await chooseShapeStyle(page, 'fillStyle', 'none');
  await drag(110, 110, 210, 170);
  await page.locator('[data-tool="select"]').click();
  await page.waitForFunction(value => document.querySelector('#canvas').toDataURL() !== value, blank, { polling: 100 });
  const original = await pixels();
  const rotate = async () => {
    await drag(100, 100, 220, 180); await waitControls(true);
    const box = await rotation.boundingBox(), canvas = await page.locator('#overlay').boundingBox();
    // Start on the button's edge, beyond the old canvas-only hit radius.
    const start = [box.x + box.width - 1, box.y + box.height / 2];
    const center = [canvas.x + 160, canvas.y + 140], radians = Math.PI / 5;
    const dx = start[0] - center[0], dy = start[1] - center[1];
    await page.mouse.move(...start); await page.mouse.down();
    await page.mouse.move(center[0] + dx * Math.cos(radians) - dy * Math.sin(radians),
      center[1] + dx * Math.sin(radians) + dy * Math.cos(radians), { steps: 8 });
    await page.waitForFunction(value => document.querySelector('#canvas').toDataURL() !== value, original, { polling: 100 });
    check('desktop rotation button transforms the selection while held', await rotation.isVisible());
    await page.mouse.up(); await waitControls(true);
    return pixels();
  };
  const preview = await rotate();
  await page.keyboard.press('Enter'); await waitPixels(preview);
  check('desktop Enter retains released selection rotation controls', await rotation.isVisible());
  await page.keyboard.press('Escape'); await waitPixels(original); await waitControls(false);
  check('desktop Escape restores original pixels after released free rotation', !await rotation.isVisible());

  const rotated = await rotate();
  await page.keyboard.press('Control+z'); await waitPixels(original); await waitControls(false);
  check('desktop Undo cancels selection rotation and removes handles', !await rotation.isVisible());
  await page.keyboard.press('Control+y'); await waitPixels(rotated); await waitControls(false);
  check('desktop Redo restores committed rotated pixels without handles', !await rotation.isVisible());
  await page.keyboard.press('Control+z'); await waitPixels(original);
  await page.keyboard.press('Control+z'); await waitPixels(blank);
  await page.waitForFunction(() => document.querySelector('[data-action="undo"]').disabled, null, { polling: 100 });
  check('desktop rotation fixture restores blank pixels without extra undo history', !await undo.isEnabled());
  await page.locator('[data-color="#000000"]').click();
  await page.locator('[data-menu="brushes"]').click();
  await page.locator('[data-command="tool:brush"]').click();
  await page.getByRole('button', { name: 'Fit to window', exact: true }).click();
  await page.waitForFunction(() => {
    const canvas = document.querySelector('#canvas');
    return Math.abs(canvas.getBoundingClientRect().width / canvas.width - Number(document.querySelector('#zoom-presets').value)) < 0.001;
  }, null, { polling: 100 });
}
