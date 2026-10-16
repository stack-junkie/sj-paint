// Packaged-renderer coverage through public UI only. No development API,
// inspector calls, system clipboard access, or native dialogs are required.
export async function verifyPendingShapesDesktop(page, check) {
  const pixels = () => page.locator('#canvas').evaluate(canvas => canvas.toDataURL());
  const waitPixels = expected => page.waitForFunction(value => document.querySelector('#canvas').toDataURL() === value,
    expected, { polling: 100 });
  const controls = () => page.locator('#overlay').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return data.some((value, index) => index % 4 === 3 && value);
  });
  const waitPixel = (x, y, rgba) => page.waitForFunction(({ x, y, rgba }) => {
    const pixel = document.querySelector('#canvas').getContext('2d').getImageData(x, y, 1, 1).data;
    return rgba.every((value, index) => pixel[index] === value);
  }, { x, y, rgba }, { polling: 100 });
  const move = async (x, y) => {
    const box = await page.locator('#overlay').boundingBox();
    await page.mouse.move(box.x + x, box.y + y, { steps: 4 });
  };
  const drag = async (x1, y1, x2, y2) => {
    await move(x1, y1); await page.mouse.down(); await move(x2, y2); await page.mouse.up();
  };
  const undo = page.getByRole('button', { name: 'Undo (Ctrl+Z)', exact: true });
  check('desktop pending-shape fixture starts without undo history', !await undo.isEnabled());
  await page.locator('#zoom-presets').selectOption({ label: '100%' });
  await page.waitForFunction(() => {
    const canvas = document.querySelector('#canvas');
    return Math.abs(canvas.getBoundingClientRect().width - canvas.width) < 0.01;
  }, null, { polling: 100 });
  await page.locator('[data-tool="rectangle"]').click();
  await page.locator('[data-color="#000000"]').click();
  await page.locator('#outline').selectOption('solid');
  await page.locator('#shape-fill').selectOption('none');
  const blank = await pixels();
  await drag(40, 60, 160, 140);
  await waitPixel(80, 60, [0, 0, 0, 255]);
  // Pixels are visible during the held gesture too. Wait for the release
  // controls before deciding whether the shape remains editable.
  await page.waitForFunction(() => {
    const canvas = document.querySelector('#overlay');
    return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
      .some((value, index) => index % 4 === 3 && value);
  }, null, { polling: 100 });
  check('desktop rectangle stays editable after release', await controls() && await pixels() !== blank);
  await page.locator('[data-color="#ed1c24"]').click();
  await waitPixel(80, 60, [237, 28, 36, 255]);
  check('desktop pending outline recolors through the palette', await controls());
  await page.locator('#overlay').focus(); await page.keyboard.press('Enter');
  check('desktop Enter retains pending shape controls', await controls());
  await drag(100, 100, 120, 110);
  await waitPixel(80, 70, [237, 28, 36, 255]);
  await waitPixel(80, 60, [255, 255, 255, 255]);
  check('desktop pending rectangle moves before being committed', await controls());
  await page.keyboard.press('Escape'); await waitPixels(blank);
  await page.waitForFunction(() => document.querySelector('[data-action="undo"]').disabled, null, { polling: 100 });
  check('desktop Escape discards edited shape and restores a pristine document', !await controls() && !await undo.isEnabled());

  await page.locator('[data-color="#000000"]').click();
  await drag(40, 60, 160, 140);
  await waitPixel(80, 60, [0, 0, 0, 255]);
  await page.locator('[data-tool="pencil"]').click();
  await page.waitForFunction(() => {
    const canvas = document.querySelector('#overlay');
    return !canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value);
  }, null, { polling: 100 });
  check('desktop tool switch commits shape pixels and clears editing controls', await pixels() !== blank && await undo.isEnabled());
  await undo.click(); await waitPixels(blank);
  await page.waitForFunction(() => document.querySelector('[data-action="undo"]').disabled, null, { polling: 100 });
  check('desktop committed shape is removed by one undo', !await undo.isEnabled());

  await page.locator('[data-menu="brushes"]').click();
  await page.locator('[data-command="tool:brush"]').click();
  await page.getByRole('button', { name: 'Fit to window', exact: true }).click();
  await page.waitForFunction(() => {
    const canvas = document.querySelector('#canvas');
    return Math.abs(canvas.getBoundingClientRect().width / canvas.width - Number(document.querySelector('#zoom-presets').value)) < 0.001;
  }, null, { polling: 100 });
}
