import { readPaint, writePaint } from '../src/paint-format.js';
import { comparePaintProject, paintProjectFixture, unsupportedPaint } from './verify-paint-project.mjs';

// The caller owns the hidden app, inspector, native-dialog fixtures and cleanup.
// Renderer interactions use only public controls, never the development API.
export async function verifyPaintProjectDesktop(page, check, { main, waitForFile }) {
  const originalFile = await main('__sjPaintVerification.file');
  const expected = paintProjectFixture(), encoded = Buffer.from(await writePaint(expected));
  const fixture = async (name, bytes) => main(`(() => {
    const q = __sjPaintVerification; q.file = q.path.join(q.directory, ${JSON.stringify(name)});
    ${bytes ? `q.fs.writeFileSync(q.file, Buffer.from(${JSON.stringify(Buffer.from(bytes).toString('base64'))}, 'base64'));` : ''}
    return q.file;
  })()`);
  const fileBytes = async () => Buffer.from(await main('__sjPaintVerification.fs.readFileSync(__sjPaintVerification.file).toString("base64")'), 'base64');
  const command = async name => {
    await page.getByRole('button', { name: 'File', exact: true }).click();
    await page.locator(`[data-command="${name}"]`).click();
  };
  const pixels = () => page.locator('#canvas').evaluate(canvas => canvas.toDataURL());
  const snapshot = () => page.evaluate(() => ({
    pixels: document.querySelector('#canvas').toDataURL(), title: document.title,
    dimensions: document.querySelector('#dimensions').textContent,
    layers: [...document.querySelectorAll('#layer-list .layer span')].map(layer => layer.textContent),
    undo: document.querySelector('[data-action="undo"]').disabled,
    redo: document.querySelector('[data-action="redo"]').disabled,
  }));
  const waitLoaded = stem => page.waitForFunction(name => document.title.startsWith(`${name} - `), stem, { polling: 100 });
  const openSaveAs = async (name, format = 'paint') => {
    await page.locator('#overlay').focus(); await page.keyboard.press('Control+Shift+s');
    await page.locator('#dialog [name="name"]').fill(name);
    await page.locator('#dialog [name="format"]').selectOption(format);
  };
  const failure = () => page.waitForEvent('console', { predicate: event => event.type() === 'error' && /paint|layer|opacity|compress/i.test(event.text()) });
  const layersInitiallyVisible = await page.locator('#layers-panel').isVisible();
  const initialPixels = await pixels();
  check('desktop .paint fixture starts from the pristine document', await page.title() === 'Untitled - Stack Junkie Paint' &&
    !await page.getByRole('button', { name: 'Undo (Ctrl+Z)', exact: true }).isEnabled());
  try {
    await fixture('desktop-native-open.paint', encoded);
    await page.locator('#overlay').focus(); await page.keyboard.press('Control+o'); await waitLoaded('desktop-native-open');
    if (!await page.locator('#layers-panel').isVisible()) await page.getByRole('button', { name: 'Layers', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#layer-list .layer').length === 2, null, { polling: 100 });
    const imported = await pixels();
    check('desktop Ctrl+O imports native .paint as two editable layers',
      (await page.locator('#layer-list .layer span').allTextContents()).join('|') === [...expected.layers].reverse().map(layer => layer.name).join('|') &&
      await page.locator('#dimensions').textContent() === '64 × 48px');
    const options = await main('__sjPaintVerification.lastOpenOptions');
    check('desktop Open chooser advertises .paint projects', options.filters.some(filter => filter.extensions.includes('paint')));

    await fixture('desktop-native-export.paint'); await openSaveAs('suggested-but-renamed');
    await page.locator('#dialog button[type="submit"]').click(); await waitForFile(); await waitLoaded('desktop-native-export');
    const comparison = comparePaintProject(await readPaint(await fileBytes()), expected);
    check('desktop native save preserves layer names, order, background and pixels (partial RGB tolerance 1)', comparison.ok, comparison);
    const saveOptions = await main('__sjPaintVerification.lastSaveOptions');
    check('desktop .paint save uses the native extension and leaves the layered document clean',
      saveOptions.defaultPath.endsWith('.paint') && saveOptions.filters.some(filter => filter.extensions.includes('paint')) &&
      !await page.title().then(title => title.includes('•')));
    check('desktop Save As adopts the actual chooser filename', (await page.title()).startsWith('desktop-native-export - '));

    await page.locator('[data-tool="pencil"]').click();
    const bounds = await page.locator('#overlay').boundingBox(); await page.mouse.click(bounds.x + 5, bounds.y + 5);
    await page.waitForFunction(() => document.title.includes('•'), null, { polling: 100 });
    const beforeSave = await fileBytes(), dialogsBeforeSave = await main('__sjPaintVerification.saveDialogs');
    await page.keyboard.press('Control+s'); await waitForFile({ differentFrom: beforeSave });
    await page.waitForFunction(() => !document.title.includes('•'), null, { polling: 100 });
    check('desktop Ctrl+S keeps the imported native project format after drawing', (await readPaint(await fileBytes())).layers.length === 2 &&
      await main('__sjPaintVerification.saveDialogs') === dialogsBeforeSave);

    await fixture('desktop-native-project.paint', encoded); await command('open-project'); await waitLoaded('desktop-native-project');
    check('desktop Open project imports identical native pixels and editable layers', await pixels() === imported &&
      await page.locator('#layer-list .layer').count() === 2);
    for (const [name, bytes] of [['desktop-truncated.paint', encoded.subarray(0, encoded.length - 7)],
      ['desktop-unsupported.paint', unsupportedPaint(encoded)]]) {
      const before = await snapshot(); await fixture(name, bytes); const failed = failure();
      await page.locator('#overlay').focus(); await page.keyboard.press('Control+o'); await failed;
      check(`desktop ${name} leaves the current document and undo controls intact`, JSON.stringify(before) === JSON.stringify(await snapshot()));
    }

    await page.locator('[data-tool="pencil"]').click();
    const pngBounds = await page.locator('#overlay').boundingBox(); await page.mouse.click(pngBounds.x + 5, pngBounds.y + 5);
    await page.waitForFunction(() => document.title.includes('•'), null, { polling: 100 });
    const beforePng = await pixels();
    await fixture('desktop-native-to-png.png'); await openSaveAs('desktop-native-to-png', 'png');
    await page.locator('#dialog button[type="submit"]').click();
    await page.getByRole('heading', { name: 'Save as flattened image?' }).waitFor(); await page.locator('#dialog button[type="submit"]').click();
    await waitForFile();
    await page.waitForFunction(() => document.title.startsWith('desktop-native-to-png'), null, { polling: 100 });
    const pngBytes = await fileBytes();
    check('desktop Save as PNG after .paint retains layers and unsaved-change protection',
      pngBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      await pixels() === beforePng && await page.locator('#layer-list .layer').count() === 2 && (await page.title()).includes('•'));
    const pngSaveDialogs = await main('__sjPaintVerification.saveDialogs');
    await page.mouse.click(pngBounds.x + 15, pngBounds.y + 15);
    await page.waitForFunction(previous => document.querySelector('#canvas').toDataURL() !== previous, beforePng, { polling: 100 });
    const updatedPng = await pixels(); await page.locator('#overlay').focus();
    await page.keyboard.press('Control+s');
    await page.getByRole('heading', { name: 'Save as flattened image?' }).waitFor(); await page.locator('#dialog button[type="submit"]').click();
    await waitForFile({ differentFrom: pngBytes });
    const pngAgain = await fileBytes();
    check('desktop Ctrl+S after .paint to PNG export keeps PNG and the editable working layers',
      pngAgain.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      await main('__sjPaintVerification.saveDialogs') === pngSaveDialogs &&
      await pixels() === updatedPng && await page.locator('#layer-list .layer').count() === 2 && (await page.title()).includes('•'));

    await page.locator('#layer-list [data-visible]').first().click();
    // Raster export already left this layered document dirty. Wait for this
    // visibility change to render before taking the unchanged-on-error snapshot.
    await page.waitForFunction(previous =>
      document.querySelector('#layer-list [data-visible]').title === 'Show layer' &&
      document.querySelector('#canvas').toDataURL() !== previous, beforePng, { polling: 100 });
    const hidden = await snapshot(); await fixture('desktop-hidden-layer.paint');
    await openSaveAs('desktop-hidden-layer'); const failed = failure();
    await page.locator('#dialog button[type="submit"]').click(); await failed;
    const afterFailure = await snapshot();
    const wroteUnsupported = await main('__sjPaintVerification.fs.existsSync(__sjPaintVerification.file)');
    check('desktop .paint export rejects hidden layers without writing or marking the drawing saved',
      !wroteUnsupported && JSON.stringify(hidden) === JSON.stringify(afterFailure),
      { wroteUnsupported, changedFields: Object.keys(hidden).filter(key => JSON.stringify(hidden[key]) !== JSON.stringify(afterFailure[key])) });
  } finally {
    if (await page.locator('#dialog').evaluate(dialog => dialog.open)) await page.locator('#dialog-cancel').click();
    await page.locator('#overlay').focus(); await page.keyboard.press('Control+n');
    await page.waitForFunction(() => document.title === 'Untitled - Stack Junkie Paint' && document.querySelector('#canvas').width === 1152,
      null, { polling: 100 });
    if (await page.locator('#layers-panel').isVisible() !== layersInitiallyVisible) await page.getByRole('button', { name: 'Layers', exact: true }).click();
    await page.locator('[data-menu="brushes"]').click(); await page.locator('[data-command="tool:brush"]').click();
    await main(`__sjPaintVerification.file = ${JSON.stringify(originalFile)}`);
  }
  check('desktop .paint verifier restores the original blank canvas', await pixels() === initialPixels);
}
