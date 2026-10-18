// Public controls with deterministic chooser responses; no host files or dialogs.
export async function verifyFileInformation(page, check) {
  await page.evaluate(async () => {
    const { writeImageResolution } = await import('/src/image-metadata.js');
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 144;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#237ac1'; ctx.fillRect(12, 20, 30, 40);
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    const bytes = writeImageResolution(new Uint8Array(await blob.arrayBuffer()), 'png', { xDpi: 96, yDpi: 144 });
    window.__fileInfo = { bytes, writes: [], nextSave: 'success', original: Object.getOwnPropertyDescriptor(window, 'paintDesktop') };
    Object.defineProperty(window, 'paintDesktop', { configurable: true, value: {
      setTitle() {}, confirmSaveChanges: async () => 'discard',
      primaryDisplayMetrics: async () => ({ width: 1920, height: 1080 }),
      openImage: async () => ({ bytes: __fileInfo.bytes, name: __fileInfo.openName || 'resolution.png', target: 'opened', targetFormat: 'png' }),
      saveImage: async request => {
        __fileInfo.writes.push(request);
        if (__fileInfo.nextSave === 'cancel') return false;
        if (__fileInfo.nextSave === 'fail') throw new Error('Injected destination write failure');
        return { name: 'resolution.png', target: 'saved' };
      },
    } });
  });
  const shortcut = async keys => { await page.locator('#overlay').focus(); await page.keyboard.press(keys); };
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const expectedSize = bytes => `${(bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })}KB`;
  const pixels = () => page.locator('#canvas').evaluate(canvas => canvas.toDataURL());
  try {
    const labels = await page.evaluate(async () => { const { fileSizeLabel } = await import('/src/image-properties.js'); return [fileSizeLabel(891), fileSizeLabel(4671), fileSizeLabel(null)]; });
    check('Properties size labels match native 891-byte, 4671-byte and unsaved observations', labels[0] === '0.9KB' && labels[1] === '4.6KB' && labels[2] === 'Not Available', labels);
    await shortcut('Control+o'); await page.waitForFunction(() => document.title.startsWith('resolution'));
    await frame();
    const encodedLength = await page.evaluate(() => __fileInfo.bytes.length);
    check('file size reports the actual successfully opened encoded bytes', (await page.locator('#file-size').textContent()).includes(expectedSize(encodedLength)));
    await shortcut('Control+e');
    // PNG stores integer pixels per metre: 96/144 DPI encode as 3780/5669.
    // Display rounding must not become the density used for physical conversion.
    const xDpi = 3780 * 0.0254;
    const information = await page.locator('.image-information').textContent();
    check('Properties displays rounded horizontal DPI while retaining anisotropic metadata', information.includes('96 DPI'), information);
    check('Properties initially selects pixels', await page.locator('[name="units"][value="pixels"]').isChecked());
    await page.locator('[name="units"][value="centimeters"]').check();
    await page.locator('#dialog-cancel').click(); await shortcut('Control+e');
    check('Cancel does not commit a changed unit preference', await page.locator('[name="units"][value="pixels"]').isChecked());
    await page.locator('[name="units"][value="inches"]').check();
    check('Properties formats inches with the observed three-place presentation', await page.locator('#dialog [name="width"]').inputValue() === '1.000' && await page.locator('#dialog [name="height"]').inputValue() === '1.500');
    await page.locator('[name="units"][value="centimeters"]').check();
    check('Properties formats centimeters with two places and horizontal density on both axes', await page.locator('#dialog [name="width"]').inputValue() === '2.54' && await page.locator('#dialog [name="height"]').inputValue() === '3.81');
    await page.locator('[name="units"][value="inches"]').check();
    // This value rounds to 193 pixels with the file's actual 96.012 DPI,
    // but only 192 if the displayed 96-DPI label becomes conversion input.
    await page.locator('#dialog [name="width"]').fill('2.00515');
    await page.locator('#dialog button[type="submit"]').click(); await frame();
    check('physical width edit uses original density without scaling height', await page.locator('#canvas').evaluate(canvas => canvas.width === 193 && canvas.height === 144));
    const changed = await pixels();
    await shortcut('Control+e');
    check('accepted units persist on reopening Properties', await page.locator('[name="units"][value="inches"]').isChecked());
    await page.locator('[name="units"][value="centimeters"]').check(); await page.locator('#dialog-cancel').click();
    await shortcut('Control+e');
    check('later Cancel preserves the last accepted unit preference', await page.locator('[name="units"][value="inches"]').isChecked());
    await page.locator('#dialog-cancel').click();
    await shortcut('Control+s'); await page.waitForFunction(() => __fileInfo.writes.length === 1); await frame();
    const saved = await page.evaluate(() => __fileInfo.writes[0].bytes.length);
    check('successful Save updates encoded file size', (await page.locator('#file-size').textContent()).includes(expectedSize(saved)));
    const savedDensity = await page.evaluate(async () => (await import('/src/image-metadata.js')).readImageResolution(__fileInfo.writes[0].bytes));
    check('Properties horizontal-density presentation preserves both raw PNG density axes on Save', savedDensity.xDpi === xDpi && savedDensity.yDpi === 5669 * 0.0254, savedDensity);
    await shortcut('Control+z'); await frame();
    check('Undo restores original dimensions and dirty state after Save', await page.locator('#canvas').evaluate(canvas => canvas.width === 96) && (await page.title()).includes('•'));
    await shortcut('Control+y'); await frame();
    check('Redo restores the saved pixels and saved state', await pixels() === changed && !(await page.title()).includes('•'));
    const successfulSize = await page.locator('#file-size').textContent();
    await page.evaluate(() => { __fileInfo.nextSave = 'cancel'; });
    await shortcut('Control+s'); await page.waitForFunction(() => __fileInfo.writes.length === 2); await frame();
    check('canceled Save preserves the successful file-size receipt and pixels', await page.locator('#file-size').textContent() === successfulSize && await pixels() === changed);
    await page.evaluate(() => { __fileInfo.nextSave = 'fail'; });
    await shortcut('Control+s'); await page.locator('#toast').filter({ hasText: 'Injected destination write failure' }).waitFor();
    check('failed Save preserves the last successful file-size receipt and pixels', await page.locator('#file-size').textContent() === successfulSize && await pixels() === changed);
    await shortcut('Control+o'); await page.waitForFunction(() => document.querySelector('#canvas').width === 96); await frame();
    await shortcut('Control+e');
    check('accepted units persist across files', await page.locator('[name="units"][value="inches"]').isChecked());
    const beforeUnitOnly = await pixels(), beforeUnitTitle = await page.title();
    await page.locator('[name="units"][value="centimeters"]').check(); await page.locator('#dialog button[type="submit"]').click(); await frame();
    check('accepting only a unit preference leaves pixels and saved identity unchanged', await pixels() === beforeUnitOnly && await page.title() === beforeUnitTitle && await page.locator('[data-action="undo"]').isDisabled());
    // The changed title is a public completion signal for asynchronous Open.
    // Two animation frames alone do not guarantee image decoding has finished.
    await page.evaluate(() => { __fileInfo.bytes = new Uint8Array(__fileInfo.writes[0].bytes); __fileInfo.openName = 'saved-resolution.png'; });
    await shortcut('Control+o'); await page.waitForFunction(() => document.title.startsWith('saved-resolution -')); await frame();
    const reopenedSize = await page.locator('#file-size').textContent(), reopenedPixels = await pixels();
    check('saved PNG reopens with the exact pixels produced by Properties', reopenedPixels === changed);
    // Malformed Open is caught at the application boundary and keeps its drawing.
    await page.evaluate(() => { __fileInfo.bytes = new Uint8Array([1, 2, 3, 4]); });
    await shortcut('Control+o'); await page.locator('#toast').filter({ hasText: 'could not be decoded' }).waitFor();
    check('malformed Open preserves pixels and file information', await page.locator('#file-size').textContent() === reopenedSize && await pixels() === reopenedPixels);
    await shortcut('Control+e'); await page.locator('[name="units"][value="pixels"]').check();
    await page.locator('#dialog [name="width"]').fill('1'); await page.locator('#dialog button[type="submit"]').click(); await frame();
    check('minimum-width fixture is established through Properties', await page.locator('#canvas').evaluate(canvas => canvas.width === 1 && canvas.height === 144));
    const minimumPixels = await pixels(), minimumTitle = await page.title();
    await shortcut('Control+e'); await page.locator('[name="units"][value="inches"]').check();
    check('one-pixel physical width remains valid for unchanged OK', await page.locator('#dialog [name="width"]').evaluate(input => input.validity.valid));
    await page.locator('#dialog button[type="submit"]').click(); await page.waitForFunction(() => !document.querySelector('#dialog').open); await frame();
    check('accepting one-pixel physical dimensions preserves pixels and dirty identity', await pixels() === minimumPixels && await page.title() === minimumTitle);
    await shortcut('Control+z'); await frame();
    check('one Undo reverses the resize without a unit-only history entry', await pixels() === reopenedPixels);
    await shortcut('Control+e'); await page.locator('[name="units"][value="pixels"]').check();
    await page.locator('#dialog [name="width"]').fill('16384'); await page.locator('#dialog [name="height"]').fill('1');
    await page.locator('#dialog button[type="submit"]').click(); await frame();
    check('maximum-width fixture is established without a large-area allocation', await page.locator('#canvas').evaluate(canvas => canvas.width === 16384 && canvas.height === 1));
    const maximumPixels = await pixels(), maximumTitle = await page.title();
    await shortcut('Control+e'); await page.locator('[name="units"][value="inches"]').check();
    check('maximum-width and one-pixel-height physical fields both remain valid', await page.locator('#dialog form').evaluate(form => form.checkValidity()));
    await page.locator('#dialog button[type="submit"]').click(); await page.waitForFunction(() => !document.querySelector('#dialog').open); await frame();
    check('accepting physical boundary dimensions preserves exact pixels and dirty identity', await pixels() === maximumPixels && await page.title() === maximumTitle);
    await shortcut('Control+z'); await frame();
    check('upper-bound resize retains one-step Undo after a unit-only acceptance', await pixels() === reopenedPixels);
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 400;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#237ac1'; ctx.fillRect(12, 20, 30, 40);
      const blob = await new Promise(resolve => canvas.toBlob(resolve));
      const { writeImageResolution } = await import('/src/image-metadata.js');
      __fileInfo.bytes = writeImageResolution(new Uint8Array(await blob.arrayBuffer()), 'png', { xDpi: 96, yDpi: 144 });
      __fileInfo.openName = 'physical-presentation.png';
    });
    await shortcut('Control+o'); await page.waitForFunction(() => document.title.startsWith('physical-presentation -')); await frame();
    const presentationPixels = await pixels(), presentationTitle = await page.title();
    await shortcut('Control+e'); await page.locator('[name="units"][value="inches"]').check();
    check('640 by 400 inch labels match retained native 6.670 and 4.170 values', await page.locator('#dialog [name="width"]').inputValue() === '6.670' && await page.locator('#dialog [name="height"]').inputValue() === '4.170');
    await page.locator('[name="units"][value="centimeters"]').check();
    // Native recorded 16.94 for width. Preserve this file's raw-DPI conversion
    // (16.93) until that separate numeric discrepancy is explained.
    check('compact centimeter labels retain source density rather than rounded inch labels', await page.locator('#dialog [name="width"]').inputValue() === '16.93' && await page.locator('#dialog [name="height"]').inputValue() === '10.58');
    await page.locator('[name="units"][value="inches"]').check();
    await page.locator('#dialog button[type="submit"]').click(); await frame();
    check('rounded physical display and unit round trip preserve exact pixels, saved identity and history', await pixels() === presentationPixels && await page.title() === presentationTitle && await page.locator('[data-action="undo"]').isDisabled());
    await shortcut('Control+n'); await page.waitForFunction(() => document.title.startsWith('Untitled')); await frame();
    check('New does not display the previous document file size', await page.locator('#file-size').textContent() === '');
    await shortcut('Control+e');
    check('unsaved Properties uses Not Available for disk size', (await page.locator('.image-information').textContent()).includes('Not Available'));
    check('unknown resolution remains explicit instead of an invented DPI', (await page.locator('.image-information').textContent()).includes('Unknown') && await page.locator('[name="units"][value="inches"]').isDisabled());
    await page.locator('#dialog [name="width"]').fill('200'); await page.locator('#properties-default').click();
    await page.locator('#properties-default').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#properties-default').disabled);
    check('Default uses the explicitly supplied primary display fixture', await page.locator('#dialog [name="width"]').inputValue() === '1152' && await page.locator('#dialog [name="height"]').inputValue() === '648');
    await page.locator('#dialog-cancel').click();
    check('canceling Properties leaves the new drawing clean', !(await page.title()).includes('•'));
  } finally {
    if (await page.locator('#dialog').evaluate(dialog => dialog.open)) await page.locator('#dialog-cancel').click();
    await page.evaluate(() => { const saved = __fileInfo.original; if (saved) Object.defineProperty(window, 'paintDesktop', saved); else delete window.paintDesktop; delete window.__fileInfo; });
  }
}
