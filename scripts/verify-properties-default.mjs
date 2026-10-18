// Public editor controls; only the OS display response and file chooser are
// deterministic fixtures. This does not claim native desktop IPC acceptance.
export async function verifyPropertiesDefault(page, check) {
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 144;
    const context = canvas.getContext('2d'); context.fillStyle = '#246ac1'; context.fillRect(3, 4, 20, 30);
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    const { writeImageResolution } = await import('/src/image-metadata.js');
    const bytes = writeImageResolution(new Uint8Array(await blob.arrayBuffer()), 'png', { xDpi: 96, yDpi: 144 });
    window.__propertiesDefault = { original: Object.getOwnPropertyDescriptor(window, 'paintDesktop'), mode: 'success', calls: 0, writes: [] };
    Object.defineProperty(window, 'paintDesktop', { configurable: true, value: {
      setTitle() {}, confirmSaveChanges: async () => 'discard',
      openImage: async () => ({ name: 'default-density.png', bytes, target: 'default-source', targetFormat: 'png' }),
      saveImage: async request => { __propertiesDefault.writes.push(request); return { name: 'default-density.png', target: 'default-saved' }; },
      primaryDisplayMetrics: async () => {
        __propertiesDefault.calls++;
        if (__propertiesDefault.mode === 'fail') throw new Error('Display query unavailable');
        if (__propertiesDefault.mode === 'delayed') return new Promise(resolve => { __propertiesDefault.resolve = resolve; });
        return { width: 2560, height: 1600 };
      },
    } });
  });
  const shortcut = async keys => { await page.locator('#overlay').focus(); await page.keyboard.press(keys); };
  const width = page.locator('#dialog [name="width"]'), height = page.locator('#dialog [name="height"]');
  const submit = page.locator('#dialog button[type="submit"]'), reset = page.locator('#properties-default');
  const mode = value => page.evaluate(value => { __propertiesDefault.mode = value; }, value);
  const settle = async () => { await page.waitForFunction(() => !document.querySelector('#properties-default').disabled); };
  const pixels = () => page.locator('#canvas').evaluate(canvas => canvas.toDataURL());
  try {
    await shortcut('Control+o'); await page.waitForFunction(() => document.title.startsWith('default-density'));
    const originalPixels = await pixels();
    await shortcut('Control+e'); await page.locator('[name="units"][value="pixels"]').check();
    await reset.click(); await settle();
    check('Default derives 1536 by 960 from the supplied primary display while leaving the drawing untouched', await width.inputValue() === '1536' && await height.inputValue() === '960' && await pixels() === originalPixels);
    await submit.click(); await page.waitForFunction(() => document.querySelector('#canvas').width === 1536);
    await shortcut('Control+s'); await page.waitForFunction(() => __propertiesDefault.writes.length === 1);
    const density = await page.evaluate(async () => (await import('/src/image-metadata.js')).readImageResolution(__propertiesDefault.writes[0].bytes));
    check('applying Default preserves imported anisotropic resolution on Save', density.xDpi === 3780 * .0254 && density.yDpi === 5669 * .0254, density);
    await shortcut('Control+z');
    check('Undo after Default restores the exact imported drawing', await pixels() === originalPixels);
    await shortcut('Control+e'); await width.fill('231'); await height.fill('177');
    await mode('fail'); await reset.click(); await settle();
    check('failed Default preserves typed dimensions, document pixels and available OK', await width.inputValue() === '231' && await height.inputValue() === '177' && await pixels() === originalPixels && await submit.isEnabled() && (await page.locator('#dialog [role="status"]').textContent()).includes('Display query unavailable'));
    await mode('delayed'); await reset.click();
    check('pending Default blocks submission while preserving Cancel and editable fields', await submit.isDisabled() && await reset.isDisabled() && await page.locator('#dialog-cancel').isEnabled() && await width.isEnabled());
    await width.fill('232'); await width.press('Enter');
    check('Enter cannot commit while display lookup is pending', await page.locator('#dialog').evaluate(dialog => dialog.open) && await pixels() === originalPixels);
    await page.evaluate(() => __propertiesDefault.resolve({ width: 2560, height: 1600 })); await settle();
    check('late Default cannot replace dimensions edited during the request', await width.inputValue() === '232' && await height.inputValue() === '177');
    await reset.click(); await page.locator('#dialog-cancel').click();
    await shortcut('Control+e'); await width.fill('333');
    await page.evaluate(() => __propertiesDefault.resolve({ width: 2560, height: 1600 }));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    check('a canceled request cannot alter a replacement Properties dialog or the document', await width.inputValue() === '333' && await height.inputValue() === '144' && await pixels() === originalPixels && await submit.isEnabled());
    await mode('success'); await reset.click(); await settle();
    check('Default recovers after a failed and canceled query', await width.inputValue() === '1536' && await height.inputValue() === '960');
    await page.locator('#dialog-cancel').click();
    await shortcut('Control+n'); await page.waitForFunction(() => document.title.startsWith('Untitled'));
  } finally {
    if (await page.locator('#dialog').evaluate(dialog => dialog.open)) await page.locator('#dialog-cancel').click();
    await page.evaluate(() => { const state = __propertiesDefault; state.resolve?.({ width: 2560, height: 1600 }); if (state.original) Object.defineProperty(window, 'paintDesktop', state.original); else delete window.paintDesktop; delete window.__propertiesDefault; });
  }
}
