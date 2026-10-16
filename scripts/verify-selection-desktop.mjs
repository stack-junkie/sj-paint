import { chooseShapeStyle } from './shape-style-controls.mjs';
// Public renderer controls and pixels only, including in packaged builds.
// This fixture leaves the initial blank canvas and brush tool restored.
export async function verifySelectionDesktop(page, check) {
  const pixels = () => page.locator('#canvas').evaluate(canvas => canvas.toDataURL());
  const waitPixels = expected => page.waitForFunction(value => document.querySelector('#canvas').toDataURL() === value,
    expected, { polling: 100 });
  const waitSelection = present => page.waitForFunction(expected =>
    Boolean(document.querySelector('#selection-size').textContent.trim()) === expected, present, { polling: 100 });
  const noControls = () => page.locator('#overlay').evaluate(canvas =>
    !canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value));
  const move = async (x, y) => {
    const bounds = await page.locator('#overlay').boundingBox();
    await page.mouse.move(bounds.x + x, bounds.y + y, { steps: 4 });
  };
  const drag = async (x1, y1, x2, y2) => {
    await move(x1, y1); await page.mouse.down(); await move(x2, y2); await page.mouse.up();
  };
  const undo = page.getByRole('button', { name: 'Undo (Ctrl+Z)', exact: true });
  check('desktop selection fixture starts without undo history', !await undo.isEnabled());
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
  await drag(30, 30, 70, 60);
  await page.locator('[data-tool="select"]').click();
  await page.waitForFunction(value => document.querySelector('#canvas').toDataURL() !== value, blank, { polling: 100 });
  const original = await pixels();
  const select = async () => {
    await drag(20, 20, 80, 70);
    await page.waitForFunction(() => document.querySelector('#selection-size').textContent.trim() === '60 × 50px',
      null, { polling: 100 });
  };
  const selectAndMove = async () => {
    await select(); await drag(50, 45, 120, 85);
    await page.waitForFunction(value => document.querySelector('#canvas').toDataURL() !== value, original, { polling: 100 });
    return pixels();
  };

  await selectAndMove();
  await page.keyboard.press('Escape'); await waitPixels(original); await waitSelection(false);
  check('desktop Escape after a released selection move restores original pixels and drops handles', await noControls());

  await select(); await drag(80, 70, 100, 90);
  await page.waitForFunction(() => document.querySelector('#selection-size').textContent.trim() === '80 × 70px',
    null, { polling: 100 });
  await page.keyboard.press('Escape'); await waitPixels(original); await waitSelection(false);
  check('desktop Escape after selection resizing restores original pixels and drops handles', await noControls());

  const moved = await selectAndMove();
  await page.keyboard.press('Control+z'); await waitPixels(original); await waitSelection(false);
  check('desktop Undo of a pending selection move restores original artwork without handles', await noControls());
  await page.keyboard.press('Control+y'); await waitPixels(moved); await waitSelection(false);
  check('desktop Redo restores the moved selection as committed pixels without handles', await noControls());
  await page.keyboard.press('Control+z'); await waitPixels(original);

  const preview = await selectAndMove();
  await move(190, 120); await page.mouse.down(); await page.mouse.up();
  await waitSelection(false); await waitPixels(preview);
  check('desktop outside click commits the moved selection and drops handles', await noControls());
  await page.keyboard.press('Control+z'); await waitPixels(original);
  check('desktop one Undo restores artwork after selection outside-click commit', await noControls());
  await page.keyboard.press('Control+y'); await waitPixels(preview);
  check('desktop one Redo restores artwork after selection outside-click commit', await noControls());
  await page.keyboard.press('Control+z'); await waitPixels(original);
  await page.keyboard.press('Control+z'); await waitPixels(blank);
  await page.waitForFunction(() => document.querySelector('[data-action="undo"]').disabled, null, { polling: 100 });
  check('desktop selection cancellation adds no extra undo entries', !await undo.isEnabled());

  await page.locator('[data-color="#000000"]').click();
  await page.locator('[data-menu="brushes"]').click();
  await page.locator('[data-command="tool:brush"]').click();
  await page.getByRole('button', { name: 'Fit to window', exact: true }).click();
  await page.waitForFunction(() => {
    const canvas = document.querySelector('#canvas');
    return Math.abs(canvas.getBoundingClientRect().width / canvas.width - Number(document.querySelector('#zoom-presets').value)) < 0.001;
  }, null, { polling: 100 });
}
