import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeResolution, readImageResolution, readTiffMetadata, writeImageResolution, writeExifResolution } from '../src/image-metadata.js';
import { readTiff, writeTiff } from '../src/tiff.js';
import { readPaint, writePaint } from '../src/paint-format.js';
import { exportBmp, readProjectFile, saveImageFile, savePaintFile, saveProjectFile, readImageFile } from '../src/files.js';

const unknown = { xDpi: null, yDpi: null }, expected = { xDpi: 300, yDpi: 150 };
function python(mode, input) {
  const result = spawnSync(process.env.PAINT_PYTHON_PATH || 'python', [fileURLToPath(new URL('./image-metadata-fixtures.py', import.meta.url)), ...(mode ? [mode] : [])],
    { input, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, `Existing Pillow required for independent metadata checks. ${result.error || result.stderr}`);
  return JSON.parse(result.stdout);
}
const fixtures = Object.fromEntries(Object.entries(python()).map(([name, encoded]) => [name, new Uint8Array(Buffer.from(encoded, 'base64'))]));
const approximately = (actual, wanted, tolerance = 0.013) => {
  for (const axis of ['xDpi', 'yDpi']) if (wanted[axis] === null) assert.equal(actual[axis], null);
  else assert.ok(Math.abs(actual[axis] - wanted[axis]) <= tolerance, `${axis}: ${actual[axis]} != ${wanted[axis]}`);
};
const rgba = Uint8Array.from([13, 44, 78, 255, 120, 40, 70, 90]);
const canvas = { width: 2, height: 1, getContext: () => ({ getImageData: () => ({ data: rgba }) }) };

test('resolution normalization owns validation and immutable unknown axes', () => {
  assert.deepEqual(normalizeResolution(), unknown); assert.ok(Object.isFrozen(normalizeResolution(expected)));
  assert.deepEqual(normalizeResolution({ xDpi: 123.25, yDpi: null }), { xDpi: 123.25, yDpi: null });
  for (const value of [[], '96', 96, { xDpi: 0 }, { yDpi: -1 }, { xDpi: NaN }, { yDpi: Infinity }, { xDpi: '96' }]) assert.throws(() => normalizeResolution(value), /metadata/);
});

test('independent PNG/JPEG/BMP/TIFF fixtures decode physical units and oriented axes', async () => {
  for (const format of ['png', 'jpeg', 'bmp']) approximately(readImageResolution(fixtures[format]), expected);
  approximately((await readTiff(fixtures.tiff)).resolution, expected);
  for (const orientation of [1, 5, 6, 7, 8]) {
    const wanted = orientation === 1 ? { xDpi: 304.8, yDpi: 152.4 } : { xDpi: 152.4, yDpi: 304.8 };
    approximately(readImageResolution(fixtures[`jpeg-cm-${orientation}`]), wanted);
    approximately((await readTiff(fixtures[`tiff-cm-${orientation}`])).resolution, wanted);
  }
});

test('PNG/JPEG density replacement preserves pixels and independent decoder metadata', () => {
  for (const format of ['png', 'jpeg']) {
    const before = python('inspect', fixtures[format]);
    const encoded = writeImageResolution(fixtures[format], format, { xDpi: 200, yDpi: 100 });
    const after = python('inspect', encoded);
    assert.equal(after.rgba, before.rgba); assert.deepEqual(after.size, before.size);
    approximately(readImageResolution(encoded), { xDpi: 200, yDpi: 100 });
    assert.ok(Math.abs(after.dpi[0] - 200) < 0.013); assert.ok(Math.abs(after.dpi[1] - 100) < 0.013);
    assert.deepEqual(readImageResolution(writeImageResolution(encoded, format, unknown)), unknown);
    approximately(readImageResolution(writeImageResolution(encoded, format, { xDpi: 123.25, yDpi: null })), { xDpi: 123.25, yDpi: null });
  }
});

test('BMP and TIFF exports preserve known resolution and keep unknown axes unknown', async () => {
  for (const resolution of [expected, unknown, { xDpi: null, yDpi: 77.5 }]) {
    const bmp = new Uint8Array(await exportBmp(canvas, { resolution }).arrayBuffer());
    approximately(readImageResolution(bmp), resolution);
    const tiff = writeTiff({ width: 2, height: 1, rgba }, { resolution });
    const decoded = await readTiff(tiff); approximately(decoded.resolution, resolution);
    assert.deepEqual(decoded.rgba, rgba);
    const inspected = python('inspect', tiff);
    for (const [axis, tag] of [['xDpi', '282'], ['yDpi', '283']]) if (resolution[axis] !== null) assert.equal(inspected.exif[tag], resolution[axis]);
  }
});

test('Exif rational/double metadata and native .paint preserve partial and complete resolution', async () => {
  for (const resolution of [expected, unknown, { xDpi: 96.12345, yDpi: null }]) {
    for (const double of [false, true]) {
      const exif = writeExifResolution(resolution, { double });
      if (exif) approximately(readTiffMetadata(exif).resolution, resolution, 0.000001); else assert.deepEqual(resolution, unknown);
    }
    const original = { width: 2, height: 1, background: [0, 0, 0, 0], resolution,
      layers: [{ name: 'Layer', visible: true, opacity: 1, rgba }] };
    assert.deepEqual(await readPaint(await writePaint(original)), original);
  }
  assert.throws(() => readTiffMetadata(Uint8Array.of(73, 73, 42, 0, 255, 255, 255, 255)), /metadata/);
  const corrupt = writeImageResolution(fixtures.png, 'png', expected); const marker = Buffer.from(corrupt).indexOf('pHYs'); corrupt[marker + 4] ^= 1;
  assert.throws(() => readImageResolution(corrupt), /checksum/);
});

test('file boundaries report actual bytes only after successful saves and retain legacy project metadata', async () => {
  const previousWindow = globalThis.window, previousDocument = globalThis.document, previousBitmap = globalThis.createImageBitmap;
  const png = `data:image/png;base64,${Buffer.from(fixtures.png).toString('base64')}`;
  const project = { format: 'paint-linux', version: 1, width: 3, height: 2, background: null, activeLayerId: 'a',
    layers: [{ id: 'a', name: 'A', visible: true, opacity: 1, png }] };
  const serialized = JSON.stringify(project), file = new File([serialized], 'old.linuxpaint');
  const read = await readProjectFile(file); assert.equal(read.encodedBytes, file.size); assert.deepEqual(read.resolution, unknown);
  let canceled = false, saved;
  globalThis.window = { paintDesktop: {
    saveImage: value => { saved = value; return canceled ? null : { name: 'saved.png' }; },
    saveProject: value => { saved = value; return canceled ? null : { name: 'saved.sjpaint' }; },
    savePaint: value => { saved = value; return canceled ? null : { name: 'saved.paint' }; },
  } };
  try {
    const pngCanvas = { width: 3, height: 2, toBlob: done => done(new Blob([fixtures.png], { type: 'image/png' })) };
    let result = await saveImageFile(pngCanvas, 'png', 'drawing', { resolution: expected });
    assert.equal(result.encodedBytes, saved.bytes.length); approximately(readImageResolution(Uint8Array.from(saved.bytes)), expected);
    result = await saveProjectFile({ ...project, resolution: expected });
    assert.equal(result.encodedBytes, Buffer.byteLength(saved.text)); assert.deepEqual(JSON.parse(saved.text).resolution, expected);
    const doc = { width: 2, height: 1, background: null, resolution: expected, layers: [{ name: 'A', visible: true, opacity: 1, canvas }] };
    result = await savePaintFile(doc); assert.equal(result.encodedBytes, saved.bytes.length); assert.deepEqual((await readPaint(saved.bytes)).resolution, expected);
    canceled = true;
    assert.equal(await saveImageFile(pngCanvas), null); assert.equal(await saveProjectFile(project), null); assert.equal(await savePaintFile(doc), null);
    globalThis.createImageBitmap = async () => ({ width: 3, height: 2, close() {} });
    globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage() {} }) }) };
    const opened = await readImageFile(new File([fixtures.png], 'fixture.png'));
    assert.equal(opened.encodedBytes, fixtures.png.length); approximately(opened.resolution, expected);
  } finally { globalThis.window = previousWindow; globalThis.document = previousDocument; globalThis.createImageBitmap = previousBitmap; }
});
