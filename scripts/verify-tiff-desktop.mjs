import { readTiff } from '../src/tiff.js';
import { tiffImportFixture, canvasTiffPixels, optionalNativeTiffs } from './verify-tiff-import.mjs';
import { singleChannelTiffFixtures, malformedSingleChannelTiffFixtures } from './tiff-fixtures.mjs';

// The caller owns the hidden app and its native-dialog fixtures. All writes
// stay inside that existing directory; renderer actions use public controls.
export async function verifyTiffDesktop(page, check, { main, waitForFile }) {
  const originalFile = await main('__sjPaintVerification.file');
  const expected = await tiffImportFixture(), canonical = await canvasTiffPixels(page, expected);
  const fixture = (name, bytes) => main(`(() => {
    const q = __sjPaintVerification; q.file = q.path.join(q.directory, ${JSON.stringify(name)});
    ${bytes ? `q.fs.writeFileSync(q.file, Buffer.from(${JSON.stringify(Buffer.from(bytes).toString('base64'))}, 'base64'));` : ''}
    return q.file;
  })()`);
  const bytes = async () => Buffer.from(await main('__sjPaintVerification.fs.readFileSync(__sjPaintVerification.file).toString("base64")'), 'base64');
  const pixels = () => page.locator('#canvas').evaluate(c => [...c.getContext('2d').getImageData(0, 0, c.width, c.height).data]);
  const snapshot = () => page.evaluate(() => JSON.stringify({ pixels: document.querySelector('#canvas').toDataURL(), title: document.title,
    dimensions: document.querySelector('#dimensions').textContent, undo: document.querySelector('[data-action="undo"]').disabled,
    redo: document.querySelector('[data-action="redo"]').disabled }));
  const waitLoaded = stem => page.waitForFunction(name => document.title.startsWith(`${name} - `), stem, { polling: 100 });
  const open = async (name, data) => {
    await fixture(name, data); await page.locator('#overlay').focus(); await page.keyboard.press('Control+o');
    await waitLoaded(name.replace(/\.[^.]+$/, ''));
  };
  const initialPixels = await page.locator('#canvas').evaluate(c => c.toDataURL());
  check('desktop TIFF verifier starts with the pristine blank document', await page.title() === 'Untitled - Stack Junkie Paint' &&
    !await page.getByRole('button', { name: 'Undo (Ctrl+Z)', exact: true }).isEnabled());
  try {
    await open('desktop-tiff-open.tif', expected.bytes);
    check('desktop native Open imports TIFF pixels and transparency', JSON.stringify(await pixels()) === JSON.stringify(canonical));
    const options = await main('__sjPaintVerification.lastOpenOptions');
    check('desktop native chooser includes .tif and .tiff', options.filters.some(f => f.extensions.includes('tif') && f.extensions.includes('tiff')));
    const beforeSave = await bytes(), saveDialogs = await main('__sjPaintVerification.saveDialogs');
    await page.locator('#overlay').focus(); await page.keyboard.press('Control+s');
    await waitForFile({ differentFrom: beforeSave });
    const exported = await bytes(), decoded = await readTiff(exported);
    check('desktop Ctrl+S retains TIFF after a .tif import', JSON.stringify([...decoded.rgba]) === JSON.stringify(canonical) &&
      await main('__sjPaintVerification.saveDialogs') === saveDialogs);
    await open('desktop-tiff-reopen.tiff', exported);
    check('desktop native TIFF export reopens with unchanged alpha and RGB', JSON.stringify(await pixels()) === JSON.stringify(canonical));
    for (const [name, data] of [['desktop-tiff-truncated.tif', expected.bytes.subarray(0, 30)], ['desktop-tiff-invalid.tiff', Buffer.from('not TIFF')]]) {
      const before = await snapshot(); await fixture(name, data);
      const failed = page.waitForEvent('console', { predicate: e => e.type() === 'error' && /TIFF/.test(e.text()) });
      await page.locator('#overlay').focus(); await page.keyboard.press('Control+o'); await failed;
      check(`desktop ${name} preserves the document and history controls`, before === await snapshot());
    }
    for (const sample of await singleChannelTiffFixtures()) {
      await open(`desktop-${sample.name}.tiff`, sample.bytes);
      check(`desktop native Open matches independent ${sample.name} RGBA and orientation`,
        JSON.stringify(await pixels()) === JSON.stringify([...sample.rgba]) && await page.locator('#canvas').evaluate((canvas, size) =>
          canvas.width === size.width && canvas.height === size.height, { width: sample.width, height: sample.height }));
    }
    for (const sample of await malformedSingleChannelTiffFixtures()) {
      const before = await snapshot(); await fixture(sample.name, sample.bytes);
      const failed = page.waitForEvent('console', { predicate: e => e.type() === 'error' && /TIFF/.test(e.text()) });
      await page.locator('#overlay').focus(); await page.keyboard.press('Control+o'); await failed;
      check(`desktop ${sample.name} preserves the document and history controls`, before === await snapshot());
    }
    const native = await optionalNativeTiffs();
    for (const sample of native) {
      await open(sample.name, sample.bytes);
      check(`desktop opens digest-pinned ${sample.name}`, JSON.stringify(await pixels()) === JSON.stringify(await canvasTiffPixels(page, sample)));
    }
    if (!native.length) check('desktop native TIFF fixture coverage is optional and absent', true, { skipped: true });
  } finally {
    if (await page.locator('#dialog').evaluate(d => d.open)) await page.locator('#dialog-cancel').click();
    await page.locator('#overlay').focus(); await page.keyboard.press('Control+n');
    await page.waitForFunction(() => document.title === 'Untitled - Stack Junkie Paint' && document.querySelector('#canvas').width === 1152,
      null, { polling: 100 });
    await main(`__sjPaintVerification.file = ${JSON.stringify(originalFile)}`);
  }
  check('desktop TIFF verifier restores the original blank canvas', await page.locator('#canvas').evaluate(c => c.toDataURL()) === initialPixels);
}
