import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { exportTiff } from '../src/files.js';
import { readTiff } from '../src/tiff.js';
import { singleChannelTiffFixtures, malformedSingleChannelTiffFixtures } from './tiff-fixtures.mjs';

export async function tiffImportFixture() {
  const width = 64, height = 48, rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = x < 20 ? [20, 80, 190, 255] : x < 45 && y < 35 ? [179, 79, 39, 128] : [0, 0, 0, 0];
    rgba.set(color, (y * width + x) * 4);
  }
  const bytes = new Uint8Array(await exportTiff({ width, height, getContext: () => ({ getImageData: () => ({ data: rgba }) }) }, { compression: 'none' }).arrayBuffer());
  return { width, height, rgba, bytes };
}

function deflateFixture(bytes, trailing = false) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), ifd = view.getUint32(4, true);
  const fields = new Map();
  for (let n = 0; n < view.getUint16(ifd, true); n++) {
    const entry = ifd + 2 + 12 * n; fields.set(view.getUint16(entry, true), entry + 8);
  }
  const offset = view.getUint32(fields.get(273), true), packed = deflateSync(bytes.subarray(offset));
  const result = Buffer.concat([bytes.subarray(0, offset), packed, trailing ? Buffer.from([1, 2, 3]) : Buffer.alloc(0)]);
  result.writeUInt16LE(8, fields.get(259)); result.writeUInt32LE(result.length - offset, fields.get(279));
  return result;
}

// Compare the actual canvas representation, including its premultiplication,
// rather than accepting a blanket RGB tolerance that could hide decode errors.
export async function canvasTiffPixels(page, expected) {
  return page.evaluate(({ width, height, rgba }) => {
    const c = document.createElement('canvas'); c.width = width; c.height = height;
    c.getContext('2d').putImageData(new ImageData(Uint8ClampedArray.from(rgba), width, height), 0, 0);
    return [...c.getContext('2d').getImageData(0, 0, width, height).data];
  }, { width: expected.width, height: expected.height, rgba: [...expected.rgba] });
}

export async function optionalNativeTiffs() {
  const fixtures = [];
  for (const [name, digest] of [
    ['reference-native-colors.tif', 'e9dea64dc8bc57c6d134256a3b63cb7f1bb97133be874d3c7b10f6a8008999d5'],
    ['reference-native-alpha.tif', 'cdaddd4653fe257673a040780b40232945724326cb09546d953ea1426cb4ed45'],
  ]) {
    let bytes;
    try { bytes = await readFile(new URL(`../output/${name}`, import.meta.url)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error(`Native TIFF fixture changed: ${name}`);
    fixtures.push({ name, bytes, ...await readTiff(bytes) });
  }
  return fixtures;
}

export async function verifyTiffImport(page, check) {
  const initial = await page.evaluate(() => ({ project: paintApp.doc.serialize(), state: { ...paintApp.state } }));
  const expected = await tiffImportFixture(), encoded = Buffer.from(expected.bytes);
  const pixels = () => page.locator('#canvas').evaluate(c => [...c.getContext('2d').getImageData(0, 0, c.width, c.height).data]);
  const snapshot = () => page.evaluate(() => JSON.stringify({ data: paintApp.doc.serialize(), revision: paintApp.doc.revision,
    dirty: paintApp.doc.dirty, undo: paintApp.doc._undo.length, redo: paintApp.doc._redo.length, name: paintApp.state.name, format: paintApp.state.format }));
  // The title is updated by the same render that paints the replacement canvas.
  // Model identity can change before that frame, especially for tiny fixtures.
  const waitLoaded = name => page.waitForFunction(stem => document.title === `${stem} - Stack Junkie Paint`,
    name.replace(/\.[^.]+$/, ''), { polling: 100 });
  const choose = async (name, bytes, mimeType = 'image/tiff') => {
    const pending = page.waitForEvent('filechooser');
    await page.locator('#overlay').focus(); await page.keyboard.press('Control+o');
    const chooser = await pending;
    const accept = await chooser.element().getAttribute('accept');
    check('browser Open advertises both TIFF extensions', accept.includes('.tif') && accept.includes('.tiff'));
    await chooser.setFiles({ name, mimeType, buffer: Buffer.from(bytes) });
  };
  try {
    await page.evaluate(() => paintApp.doc.markSaved());
    const canonical = await canvasTiffPixels(page, expected);
    await choose('tiff-open.tif', encoded); await waitLoaded('tiff-open.tif');
    check('Open imports TIFF dimensions, straight alpha and canvas pixels',
      JSON.stringify(await pixels()) === JSON.stringify(canonical) && await page.evaluate(() => paintApp.doc.background === null && paintApp.state.format === 'tiff'));
    const pending = page.waitForEvent('download'); await page.locator('#overlay').focus(); await page.keyboard.press('Control+s');
    const saved = await pending, chunks = [];
    for await (const chunk of await saved.createReadStream()) chunks.push(chunk);
    const exported = Buffer.concat(chunks), decoded = await readTiff(exported);
    check('Ctrl+S after .tif Open exports actual TIFF and preserves alpha', saved.suggestedFilename() === 'tiff-open.tiff' &&
      JSON.stringify([...decoded.rgba]) === JSON.stringify(canonical));
    await choose('tiff-reopen.tiff', exported); await waitLoaded('tiff-reopen.tiff');
    check('own TIFF export reopens without pixel changes', JSON.stringify(await pixels()) === JSON.stringify(canonical));
    const transfer = await page.evaluateHandle(bytes => {
      const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(bytes)], 'tiff-magic.bin', { type: 'application/octet-stream' })); return transfer;
    }, [...encoded]);
    try { await page.dispatchEvent('#viewport', 'drop', { dataTransfer: transfer }); }
    finally { await transfer.dispose(); }
    await waitLoaded('tiff-magic.bin');
    check('drop detects TIFF magic despite unrelated extension and MIME', JSON.stringify(await pixels()) === JSON.stringify(canonical) &&
      await page.evaluate(() => paintApp.state.format === 'tiff'));
    await choose('tiff-deflate.tif', deflateFixture(encoded)); await waitLoaded('tiff-deflate.tif');
    check('browser bounded Deflate TIFF import preserves pixels', JSON.stringify(await pixels()) === JSON.stringify(canonical));
    for (const [name, bytes] of [['truncated.tif', encoded.subarray(0, 30)], ['invalid.tiff', Buffer.from('not TIFF')],
      ['tiff-mime-hint.bin', Buffer.from('not TIFF')], ['trailing-deflate.tif', deflateFixture(encoded, true)]]) {
      const before = await snapshot();
      const failed = page.waitForEvent('console', { predicate: e => e.type() === 'error' && /TIFF/.test(e.text()) });
      await choose(name, bytes); await failed;
      check(`${name} preserves document pixels, saved state and history`, await snapshot() === before);
    }
    const pastePending = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Edit', exact: true }).click(); await page.locator('[data-command="paste-from"]').click();
    await (await pastePending).setFiles({ name: 'tiff-paste.tif', mimeType: 'image/tiff', buffer: encoded });
    await page.waitForFunction(() => Boolean(paintApp.doc.selection), null, { polling: 100 });
    const pasted = await page.evaluate(() => {
      const c = paintApp.doc.selection.canvas; return [...c.getContext('2d').getImageData(0, 0, c.width, c.height).data];
    });
    check('Paste from file uses TIFF decoding and preserves selection alpha', JSON.stringify(pasted) === JSON.stringify(canonical));
    await page.keyboard.press('Escape'); await page.evaluate(() => paintApp.doc.markSaved());

    const independent = await singleChannelTiffFixtures();
    for (const sample of independent) {
      const name = `independent-${sample.name}.tiff`;
      await choose(name, sample.bytes); await waitLoaded(name);
      check(`Open matches independent ${sample.name} dimensions and RGBA`,
        JSON.stringify(await pixels()) === JSON.stringify([...sample.rgba]) && await page.locator('#canvas').evaluate((canvas, size) =>
          canvas.width === size.width && canvas.height === size.height, { width: sample.width, height: sample.height }));
    }
    const gray = independent.find(sample => sample.name === 'gray-white-lzw');
    const grayTransfer = await page.evaluateHandle(bytes => {
      const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(bytes)], 'gray-magic.bin', { type: 'application/octet-stream' })); return transfer;
    }, [...gray.bytes]);
    try { await page.dispatchEvent('#viewport', 'drop', { dataTransfer: grayTransfer }); }
    finally { await grayTransfer.dispose(); }
    await waitLoaded('gray-magic.bin');
    check('Drop recognizes grayscale TIFF by magic and applies polarity and orientation', JSON.stringify(await pixels()) === JSON.stringify([...gray.rgba]));
    const palette = independent.find(sample => sample.name === 'palette-raw');
    const palettePaste = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Edit', exact: true }).click(); await page.locator('[data-command="paste-from"]').click();
    await (await palettePaste).setFiles({ name: 'palette-paste.tiff', mimeType: 'image/tiff', buffer: palette.bytes });
    await page.waitForFunction(() => Boolean(paintApp.doc.selection), null, { polling: 100 });
    const pastedPalette = await page.evaluate(() => {
      const c = paintApp.doc.selection.canvas; return [...c.getContext('2d').getImageData(0, 0, c.width, c.height).data];
    });
    check('Paste from file expands the complete palette into selection pixels', JSON.stringify(pastedPalette) === JSON.stringify([...palette.rgba]));
    await page.keyboard.press('Escape'); await page.evaluate(() => paintApp.doc.markSaved());
    const packedGray = independent.find(sample => sample.name === 'pillow-bilevel-raw');
    const packedTransfer = await page.evaluateHandle(bytes => {
      const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(bytes)], 'packed-gray.bin', { type: 'application/octet-stream' })); return transfer;
    }, [...packedGray.bytes]);
    try { await page.dispatchEvent('#viewport', 'drop', { dataTransfer: packedTransfer }); }
    finally { await packedTransfer.dispose(); }
    await waitLoaded('packed-gray.bin');
    check('Drop reads packed bilevel TIFF with omitted bit-depth tag and padded rows', JSON.stringify(await pixels()) === JSON.stringify([...packedGray.rgba]));
    const packedPalette = independent.find(sample => sample.name === 'packed-4-palette-deflate');
    const packedPaste = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Edit', exact: true }).click(); await page.locator('[data-command="paste-from"]').click();
    await (await packedPaste).setFiles({ name: 'packed-palette.tiff', mimeType: 'image/tiff', buffer: packedPalette.bytes });
    await page.waitForFunction(() => Boolean(paintApp.doc.selection), null, { polling: 100 });
    const packedPixels = await page.evaluate(() => {
      const c = paintApp.doc.selection.canvas; return [...c.getContext('2d').getImageData(0, 0, c.width, c.height).data];
    });
    check('Paste from file expands packed palette indices after Deflate and orientation', JSON.stringify(packedPixels) === JSON.stringify([...packedPalette.rgba]));
    await page.keyboard.press('Escape'); await page.evaluate(() => paintApp.doc.markSaved());
    const malformed = await malformedSingleChannelTiffFixtures();
    for (const sample of malformed) {
      const before = await snapshot();
      const failed = page.waitForEvent('console', { predicate: e => e.type() === 'error' && /TIFF/.test(e.text()) });
      await choose(sample.name, sample.bytes); await failed;
      check(`${sample.name} preserves the current document, name and history`, await snapshot() === before);
    }
    for (const sample of [malformed[0], malformed.find(sample => sample.name === 'packed-unsupported-predictor.tiff')]) {
      const beforeFailedPaste = await snapshot(), failedPaste = page.waitForEvent('filechooser');
      const pasteError = page.waitForEvent('console', { predicate: e => e.type() === 'error' && /TIFF/.test(e.text()) });
      await page.getByRole('button', { name: 'Edit', exact: true }).click(); await page.locator('[data-command="paste-from"]').click();
      await (await failedPaste).setFiles({ name: sample.name, mimeType: 'image/tiff', buffer: sample.bytes });
      await pasteError;
      check(`Malformed ${sample.name} Paste from file preserves the current document and history`, await snapshot() === beforeFailedPaste);
    }

    const native = await optionalNativeTiffs();
    for (const sample of native) {
      await choose(sample.name, sample.bytes); await waitLoaded(sample.name);
      check(`browser opens digest-pinned native ${sample.name}`, JSON.stringify(await pixels()) === JSON.stringify(await canvasTiffPixels(page, sample)));
    }
    if (!native.length) check('native TIFF fixture coverage is optional and absent', true, { skipped: true });

    // The optional native fixtures must not determine the later gesture's bounds.
    await choose('tiff-before-delayed.tif', encoded); await waitLoaded('tiff-before-delayed.tif');

    // Delay the actual selected TIFF read, after the public chooser has returned.
    // No native dialog bridge or operating-system clipboard is replaced.
    await page.evaluate(() => {
      const descriptor = Object.getOwnPropertyDescriptor(Blob.prototype, 'arrayBuffer');
      const control = { descriptor, release: null };
      Blob.prototype.arrayBuffer = function () {
        if (this instanceof File && this.name === 'tiff-delayed.tif') {
          return new Promise((resolve, reject) => { control.release = () => descriptor.value.call(this).then(resolve, reject); });
        }
        return descriptor.value.call(this);
      };
      window.__sjTiffRead = control;
      document.querySelector('#toast').textContent = '';
    });
    try {
      await choose('tiff-delayed.tif', encoded);
      await page.waitForFunction(() => Boolean(window.__sjTiffRead.release), null, { polling: 100 });
      await page.locator('[data-tool="pencil"]').click();
      const bounds = await page.locator('#overlay').boundingBox(); await page.mouse.click(bounds.x + 5, bounds.y + 5);
      await page.waitForFunction(() => paintApp.doc.dirty, null, { polling: 100 });
      const edited = await snapshot(); await page.evaluate(() => window.__sjTiffRead.release());
      await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Open canceled'), null, { polling: 100 });
      check('delayed TIFF decode cannot replace intervening drawing edits', await snapshot() === edited);
    } finally {
      await page.evaluate(() => { const control = window.__sjTiffRead; control.release?.(); Object.defineProperty(Blob.prototype, 'arrayBuffer', control.descriptor); delete window.__sjTiffRead; });
    }
  } finally {
    if (await page.locator('#dialog').evaluate(d => d.open)) await page.locator('#dialog-cancel').click();
    await page.keyboard.press('Escape'); await page.mouse.up();
    await page.evaluate(async saved => { await paintApp.doc.load(saved.project); Object.assign(paintApp.state, saved.state);
      document.querySelector('#layers-panel').hidden = !saved.state.layers; paintApp.setZoom(saved.state.zoom); }, initial);
    await page.waitForFunction(saved => document.querySelector('#canvas').width === saved.project.width && document.querySelector('[data-action="undo"]').disabled,
      initial, { polling: 100 });
  }
}
