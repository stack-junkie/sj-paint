import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { readTiff, writeTiff, writeTiffAsync } from '../src/tiff.js';
import { exportTiff, exportTiffAsync, saveImageFile } from '../src/files.js';
import { readPaint } from '../src/paint-format.js';
import { independentTiffFixtures, malformedTiffFixtures } from './tiff-fixtures.mjs';

const pixels = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 128, 1, 2, 3, 4, 5, 6, 7, 8, 255, 255, 255, 255]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const join = parts => { const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let p = 0; for (const part of parts) { bytes.set(part, p); p += part.length; } return bytes; };

function packCodes(codes) {
  const bytes = []; let accumulator = 0, bits = 0;
  for (const [code, width] of codes) {
    accumulator = (accumulator << width) | code; bits += width;
    while (bits >= 8) { bits -= 8; bytes.push((accumulator >>> bits) & 255); }
    accumulator &= (1 << bits) - 1;
  }
  if (bits) bytes.push(accumulator << (8 - bits));
  return Uint8Array.from(bytes);
}

// Literal-only TIFF LZW streams exercise all code widths without a test encoder
// implementing dictionary matching. EOI follows the width for the next code.
function literalLzw(bytes) {
  const codes = [[256, 9]];
  const width = count => count < 254 ? 9 : count < 766 ? 10 : count < 1790 ? 11 : 12;
  for (let index = 0; index < bytes.length; index++) codes.push([bytes[index], width(index)]);
  codes.push([257, width(bytes.length)]); return packCodes(codes);
}
function literalPackBits(bytes) {
  const parts = [Uint8Array.of(128)];
  for (let start = 0; start < bytes.length; start += 128) {
    const chunk = bytes.subarray(start, start + 128); parts.push(Uint8Array.of(chunk.length - 1), chunk);
  }
  return join(parts);
}

function fixture({ width = 3, height = 2, samples = 4, raw = pixels, little = true, compression = 1,
  predictor = 1, orientation = 1, rowsPerStrip = height, alpha = 2, photometric = 2, bits = 8, overrides = [], stripData } = {}) {
  const strips = [];
  const rowBytes = Math.ceil(width * samples * bits / 8);
  for (let row = 0; row < height; row += rowsPerStrip) {
    const rows = Math.min(rowsPerStrip, height - row), data = raw.slice(row * rowBytes, (row + rows) * rowBytes);
    if (predictor === 2) for (let y = 0; y < rows; y++) {
      const start = y * width * samples;
      for (let pos = start + width * samples - 1; pos >= start + samples; pos--) data[pos] = (data[pos] - data[pos - samples]) & 255;
    }
    strips.push(stripData ? stripData(data, strips.length) : compression === 5 ? literalLzw(data) :
      compression === 32773 ? literalPackBits(data) : [8, 32946].includes(compression) ? new Uint8Array(deflateSync(data)) : data);
  }
  const tags = new Map([
    [256, [4, [width]]], [257, [4, [height]]], [258, [3, Array(samples).fill(bits)]], [259, [3, [compression]]],
    [262, [3, [photometric]]], [273, [4, Array(strips.length).fill(0)]], [274, [3, [orientation]]], [277, [3, [samples]]],
    [278, [4, [rowsPerStrip]]], [279, [4, strips.map(strip => strip.length)]], [284, [3, [1]]], [317, [3, [predictor]]],
  ]);
  if (samples === 4) tags.set(338, [3, [alpha]]);
  for (const [tag, value] of overrides) { if (value === null) tags.delete(tag); else tags.set(tag, value); }
  const fields = [...tags].sort((a, b) => a[0] - b[0]);
  const tableEnd = 8 + 2 + fields.length * 12 + 4;
  const metadataBytes = fields.reduce((sum, [, [type, values]]) => sum + (values.length * (type === 3 ? 2 : 4) > 4 ? values.length * (type === 3 ? 2 : 4) : 0), 0);
  let stripOffset = tableEnd + metadataBytes;
  if (!overrides.some(([tag]) => tag === 273)) for (let index = 0; index < strips.length; index++) { tags.get(273)[1][index] = stripOffset; stripOffset += strips[index].length; }
  const result = new Uint8Array(tableEnd + metadataBytes + strips.reduce((sum, strip) => sum + strip.length, 0));
  const view = new DataView(result.buffer), u16 = (offset, value) => view.setUint16(offset, value, little), u32 = (offset, value) => view.setUint32(offset, value, little);
  result.set(little ? [73, 73] : [77, 77]); u16(2, 42); u32(4, 8); u16(8, fields.length);
  let metadata = tableEnd;
  fields.forEach(([tag, [type, values]], index) => {
    const offset = 10 + index * 12, step = type === 3 ? 2 : 4, length = values.length * step;
    u16(offset, tag); u16(offset + 2, type); u32(offset + 4, values.length);
    const target = length > 4 ? metadata : offset + 8;
    if (length > 4) { u32(offset + 8, metadata); metadata += length; }
    values.forEach((value, n) => type === 3 ? u16(target + n * step, value) : u32(target + n * step, value));
  });
  let target = tableEnd + metadataBytes;
  for (const strip of strips) { result.set(strip, target); target += strip.length; }
  return result;
}

const boundedZlib = (bytes, expected) => {
  const { buffer, engine } = inflateSync(bytes, { maxOutputLength: expected, info: true });
  assert.equal(engine.bytesWritten, bytes.length, 'trailing bytes after zlib stream'); return new Uint8Array(buffer);
};
function fieldOffset(bytes, tag) {
  const little = bytes[0] === 73, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), ifd = view.getUint32(4, little);
  for (let index = 0; index < view.getUint16(ifd, little); index++) {
    const offset = ifd + 2 + index * 12; if (view.getUint16(offset, little) === tag) return offset;
  }
  throw new Error(`missing test tag ${tag}`);
}
function change(bytes, tag, relative, value, size = 4) {
  const result = bytes.slice(), view = new DataView(result.buffer), little = result[0] === 73;
  if (size === 4) view.setUint32(fieldOffset(result, tag) + relative, value, little);
  else view.setUint16(fieldOffset(result, tag) + relative, value, little);
  return result;
}

test('both byte orders and all supported compression schemes preserve RGBA and predictor rows', async () => {
  for (const little of [true, false]) for (const compression of [1, 5, 8, 32946, 32773]) for (const predictor of [1, 2]) {
    const decoded = await readTiff(fixture({ little, compression, predictor, rowsPerStrip: 1 }));
    assert.deepEqual(decoded, { width: 3, height: 2, rgba: pixels });
  }
});

test('8-bit grayscale imports both polarities with opaque alpha', async () => {
  const raw = Uint8Array.of(0, 17, 127, 128, 254, 255);
  for (const photometric of [0, 1]) {
    const expected = Uint8Array.from([...raw].flatMap(value => {
      const gray = photometric === 0 ? 255 - value : value;
      return [gray, gray, gray, 255];
    }));
    assert.deepEqual(await readTiff(fixture({ samples: 1, raw, photometric })), { width: 3, height: 2, rgba: expected });
  }
});

test('packed samples honor row padding, both byte orders, polarity and exact palette entries across codecs', async () => {
  for (const bits of [1, 2, 4]) {
    const width = 7, height = 5, levels = 2 ** bits, rowBytes = Math.ceil(width * bits / 8);
    const indexes = Array.from({ length: width * height }, (_, i) => i % levels);
    const raw = new Uint8Array(rowBytes * height).fill(255); // Unused row bits must be ignored.
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const shift = 8 - bits - x * bits % 8, offset = y * rowBytes + Math.floor(x * bits / 8);
      raw[offset] = (raw[offset] & ~((levels - 1) << shift)) | indexes[y * width + x] << shift;
    }
    const palette = Array.from({ length: levels * 3 }, (_, i) => ((i * 43) & 255) * 256 + 127);
    for (const photometric of [0, 1, 3]) for (const little of [true, false]) for (const compression of [1, 5, 8, 32946, 32773]) {
      const expected = Uint8Array.from(indexes.flatMap(index => photometric === 3 ?
        [palette[index] >>> 8, palette[levels + index] >>> 8, palette[levels * 2 + index] >>> 8, 255] :
        Array(3).fill((photometric === 0 ? levels - 1 - index : index) * 255 / (levels - 1)).concat(255)));
      const overrides = photometric === 3 ? [[320, [3, palette]]] : [];
      const encoded = fixture({ width, height, bits, samples: 1, raw, photometric, little, compression, rowsPerStrip: 2, overrides });
      const before = encoded.slice();
      assert.deepEqual(await readTiff(encoded, { inflate: boundedZlib }), { width, height, rgba: expected });
      assert.deepEqual(encoded, before);
    }
  }
});

test('packed grayscale defaults to one bit and shares all orientation mappings', async () => {
  const grids = [[0, 1, 0, 1, 0, 1], [0, 1, 0, 1, 0, 1], [1, 0, 1, 0, 1, 0], [1, 0, 1, 0, 1, 0],
    [0, 1, 1, 0, 0, 1], [1, 0, 0, 1, 1, 0], [1, 0, 0, 1, 1, 0], [0, 1, 1, 0, 0, 1]];
  for (let orientation = 1; orientation <= 8; orientation++) {
    const decoded = await readTiff(fixture({ bits: 1, samples: 1, photometric: 1, raw: Uint8Array.of(0x40, 0xa0), orientation,
      overrides: [[258, null], [277, null]] }));
    assert.equal(decoded.width, orientation >= 5 ? 2 : 3); assert.equal(decoded.height, orientation >= 5 ? 3 : 2);
    assert.deepEqual([...decoded.rgba].filter((_, i) => i % 4 === 0), grids[orientation - 1].map(i => i * 255));
  }
});

test('packed interpretation and malformed ColorMap fail before inflation; decompression uses padded row size', async () => {
  let calls = 0;
  for (const bits of [1, 2, 4]) {
    const options = { bits, samples: 1, photometric: 1, raw: new Uint8Array(2 * Math.ceil(3 * bits / 8)), compression: 8 };
    for (const overrides of [[[317, [3, [2]]]], [[266, [3, [2]]]], [[258, [3, [3]]]], [[338, [3, [2]]]]]) {
      await assert.rejects(readTiff(fixture({ ...options, overrides }), { inflate: () => { calls++; throw new Error('unexpected inflation'); } }), /Unsupported or invalid TIFF/);
    }
    const count = 3 * 2 ** bits;
    for (const field of [[3, Array(count - 1).fill(0)], [3, Array(count + 1).fill(0)], [4, Array(count).fill(0)]]) {
      await assert.rejects(readTiff(fixture({ ...options, photometric: 3, overrides: [[320, field]] }),
        { inflate: () => { calls++; throw new Error('unexpected inflation'); } }), /Unsupported or invalid TIFF/);
    }
    for (const compression of [1, 5, 8, 32773]) for (const delta of [-1, 1]) {
      const stripData = data => {
        const wrong = new Uint8Array(data.length + delta);
        return compression === 5 ? literalLzw(wrong) : compression === 8 ? new Uint8Array(deflateSync(wrong)) :
          compression === 32773 ? literalPackBits(wrong) : wrong;
      };
      await assert.rejects(readTiff(fixture({ ...options, compression, stripData }), { inflate: boundedZlib }));
    }
  }
  assert.equal(calls, 0);
});

test('single-channel TIFF reuses strip codecs, predictor rows and both byte orders', async () => {
  const raw = Uint8Array.of(0, 17, 127, 128, 254, 255);
  const palette = Array.from({ length: 768 }, (_, index) => ((index * 37) & 255) * 256 + (index & 255));
  palette[255] = 65535;
  for (const photometric of [0, 1, 3]) for (const little of [true, false]) {
    const expected = Uint8Array.from([...raw].flatMap(index => photometric === 3 ?
      [palette[index] >>> 8, palette[256 + index] >>> 8, palette[512 + index] >>> 8, 255] :
      [0, 0, 0].map(() => photometric === 0 ? 255 - index : index).concat(255)));
    for (const compression of [1, 5, 8, 32946, 32773]) for (const predictor of [1, 2]) {
      const overrides = photometric === 3 ? [[320, [3, palette]]] : [];
      const decoded = await readTiff(fixture({ samples: 1, raw, photometric, little, compression, predictor, rowsPerStrip: 1, overrides }));
      assert.deepEqual(decoded, { width: 3, height: 2, rgba: expected });
    }
  }
});

test('palette indexes cover all 256 entries and retain high channel bytes', async () => {
  const raw = Uint8Array.from({ length: 256 }, (_, index) => index);
  const palette = [...raw].map(value => value * 256).concat([...raw].map(value => 65535 - value * 257), [...raw].map(value => value * 257));
  const decoded = await readTiff(fixture({ width: 256, height: 1, samples: 1, raw, photometric: 3, overrides: [[320, [3, palette]]] }));
  assert.deepEqual(decoded.rgba, Uint8Array.from([...raw].flatMap(value => [value, 255 - value, value, 255])));
});

test('single-channel orientations share the RGB coordinate mapping', async () => {
  const raw = Uint8Array.of(1, 2, 3, 4, 5, 6);
  const grids = [[1, 2, 3, 4, 5, 6], [3, 2, 1, 6, 5, 4], [6, 5, 4, 3, 2, 1], [4, 5, 6, 1, 2, 3],
    [1, 4, 2, 5, 3, 6], [4, 1, 5, 2, 6, 3], [6, 3, 5, 2, 4, 1], [3, 6, 2, 5, 1, 4]];
  const palette = Array.from({ length: 768 }, (_, index) => (index & 255) * 257);
  for (const photometric of [0, 1, 3]) for (let orientation = 1; orientation <= 8; orientation++) {
    const decoded = await readTiff(fixture({ samples: 1, raw, photometric, orientation, overrides: photometric === 3 ? [[320, [3, palette]]] : [] }));
    assert.equal(decoded.width, orientation >= 5 ? 2 : 3); assert.equal(decoded.height, orientation >= 5 ? 3 : 2);
    assert.deepEqual([...decoded.rgba].filter((_, index) => index % 4 === 0), grids[orientation - 1].map(value => photometric === 0 ? 255 - value : value));
  }
});

test('single-channel interpretation rejects malformed or conflicting fields before inflation', async () => {
  const raw = Uint8Array.of(0, 17, 127, 128, 254, 255), palette = Array(768).fill(0);
  let calls = 0;
  const cases = [
    fixture({ samples: 1, raw, photometric: 3 }),
    ...[[3, palette.slice(1)], [3, [...palette, 0]], [4, palette]].map(field => fixture({ samples: 1, raw, photometric: 3, compression: 8, overrides: [[320, field]] })),
    ...[0, 1, 2].map(photometric => fixture({ samples: photometric === 2 ? 4 : 1, photometric, compression: 8, overrides: [[320, [3, palette]]] })),
    ...[0, 1, 3].flatMap(photometric => [
      fixture({ samples: 1, raw, photometric, compression: 8, overrides: [[258, [3, [16]]]] }),
      fixture({ samples: 1, raw, photometric, compression: 8, overrides: [[338, [3, [2]]]] }),
      fixture({ samples: 1, raw, photometric, compression: 8, overrides: [[339, [3, [2]]]] }),
      fixture({ samples: 2, raw: new Uint8Array(12), photometric, compression: 8 }),
    ]),
  ];
  const valid = fixture({ samples: 1, raw, photometric: 3, compression: 8, overrides: [[320, [3, palette]]] });
  cases.push(change(valid, 320, 4, 0xffffffff), change(valid, 320, 8, valid.length - 1));
  for (const bytes of cases) await assert.rejects(readTiff(bytes, { inflate: () => { calls++; throw new Error('unexpected inflation'); } }), /Unsupported or invalid TIFF/);
  assert.equal(calls, 0);
  const withoutSamples = fixture({ samples: 1, raw, photometric: 1, overrides: [[277, null]] });
  assert.deepEqual((await readTiff(withoutSamples)).rgba, Uint8Array.from([...raw].flatMap(value => [value, value, value, 255])));
});

test('independent Pillow grayscale, palette and gray-alpha fixtures match exact oriented RGBA', async () => {
  for (const fixture of await independentTiffFixtures()) {
    const decoded = await readTiff(fixture.bytes);
    assert.equal(decoded.width, fixture.width, fixture.name); assert.equal(decoded.height, fixture.height, fixture.name);
    assert.equal(digest(decoded.rgba), fixture.rgbaSha256, fixture.name);
  }
});

test('existing SJ TIFF exporter round-trips exact unassociated-alpha bytes', async () => {
  const canvas = { width: 3, height: 2, getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(pixels) }) }) };
  const blob = exportTiff(canvas);
  assert.deepEqual(await readTiff(await blob.arrayBuffer()), { width: 3, height: 2, rgba: pixels });
});

test('default TIFF export uses LZW and horizontal prediction, with explicit uncompressed compatibility', async () => {
  const canvas = { width: 3, height: 2, getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(pixels) }) }) };
  for (const compression of ['lzw', 'none']) {
    const bytes = new Uint8Array(await exportTiff(canvas, { compression }).arrayBuffer());
    const view = new DataView(bytes.buffer);
    assert.equal(view.getUint16(fieldOffset(bytes, 259) + 8, true), compression === 'lzw' ? 5 : 1);
    if (compression === 'lzw') assert.equal(view.getUint16(fieldOffset(bytes, 317) + 8, true), 2);
    else assert.equal(digest(bytes), '64bebe9261c60a100139ad45cec77528819b6707a03a9709c53b2d3350455cde',
      'explicit uncompressed output retains the prior exporter bytes');
    assert.deepEqual(await readTiff(bytes), { width: 3, height: 2, rgba: pixels });
  }
  const bytes = new Uint8Array(await exportTiff(canvas).arrayBuffer());
  assert.equal(new DataView(bytes.buffer).getUint16(fieldOffset(bytes, 259) + 8, true), 5);
});

function noise(length) {
  let state = 0x713b6a49;
  return Uint8Array.from({ length }, () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return state >>> 24;
  });
}

test('actual TIFF save yields while encoding and keeps its captured pixels and target', async () => {
  const width = 1024, height = 2048, original = noise(width * height * 4), current = original.slice();
  const originalWindow = globalThis.window, OriginalBlob = globalThis.Blob;
  let ticks = 0, ticksBeforeBlob = 0, snapshotReads = 0, request;
  const canvas = { width, height, getContext: () => ({ getImageData: () => {
    snapshotReads++; return { data: new Uint8ClampedArray(current) };
  } }) };
  globalThis.Blob = class extends OriginalBlob {
    constructor(parts, options) {
      if (options?.type === 'image/tiff') ticksBeforeBlob = ticks;
      super(parts, options);
    }
  };
  globalThis.window = { paintDesktop: { saveImage: value => { request = value; return { name: 'saved.tiff' }; } } };
  const timer = setInterval(() => { ticks++; if (ticks === 1) current.fill(0); }, 1);
  try {
    assert.deepEqual(await saveImageFile(canvas, 'tiff', 'snapshot.png', { target: 'original-target' }), { name: 'saved.tiff' });
    assert.ok(ticksBeforeBlob > 1, 'event-loop tasks must run during encoding, before Blob/IPC conversion');
    assert.equal(snapshotReads, 1); assert.equal(request.target, 'original-target');
    assert.equal(request.suggestedName, 'snapshot.tiff'); assert.equal(request.format, 'tiff');
    assert.deepEqual((await readTiff(Uint8Array.from(request.bytes))).rgba, original);
    assert.ok(current.every(value => value === 0), 'intervening edits actually occurred');
  } finally {
    clearInterval(timer); globalThis.Blob = OriginalBlob;
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  }
});

test('TIFF encoder preserves noisy and repetitive RGBA at dictionary boundaries and resets', async () => {
  // Sweep near each early-width boundary, including final-code/EOI transitions.
  for (const center of [64, 192, 448, 1024]) for (let width = center - 8; width <= center + 8; width++) {
    const rgba = noise(width * 4), bytes = writeTiff({ width, height: 1, rgba });
    assert.deepEqual((await readTiff(bytes)).rgba, rgba, `noisy ${width} pixel row`);
  }
  for (const width of [1, 257, 16384]) for (const repeated of [false, true]) {
    const rgba = repeated ? new Uint8Array(width * 4).fill(65) : noise(width * 4);
    assert.deepEqual((await readTiff(writeTiff({ width, height: 1, rgba }))).rgba, rgba);
  }
});

test('TIFF encoder uses bounded whole-row strips including a short last strip', async () => {
  const width = 257, height = 130, rgba = noise(width * height * 4), before = rgba.slice();
  const bytes = writeTiff({ width, height, rgba }), view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(fieldOffset(bytes, 278) + 8, true), 63);
  assert.equal(view.getUint32(fieldOffset(bytes, 273) + 4, true), 3);
  const offsets = view.getUint32(fieldOffset(bytes, 273) + 8, true);
  const lengths = view.getUint32(fieldOffset(bytes, 279) + 8, true);
  for (let index = 0; index < 3; index++) {
    const start = view.getUint32(offsets + index * 4, true), length = view.getUint32(lengths + index * 4, true);
    const end = index === 2 ? bytes.length : view.getUint32(offsets + (index + 1) * 4, true);
    assert.equal(start + length, end);
    assert.equal(bytes[start], 128, 'every MSB-first strip starts with clear code 256');
  }
  assert.deepEqual(await readTiff(bytes), { width, height, rgba });
  assert.deepEqual(rgba, before, 'prediction must not change caller pixels');
  assert.deepEqual(writeTiff({ width, height, rgba }), bytes, 'encoding is deterministic');
  const padded = new Uint8Array(rgba.length + 11); padded.set(rgba, 7);
  assert.deepEqual(writeTiff({ width, height, rgba: padded.subarray(7, 7 + rgba.length) }), bytes);
});

test('cooperative TIFF export is byte-identical to synchronous export', async () => {
  for (const [width, height] of [[3, 2], [257, 130], [16384, 2]]) {
    const padded = noise(width * height * 4 + 11), rgba = padded.subarray(7, 7 + width * height * 4), original = padded.slice();
    for (const compression of ['lzw', 'none']) {
      const options = { compression }, image = { width, height, rgba };
      assert.deepEqual(await writeTiffAsync(image, options), writeTiff(image, options));
      const canvas = { width, height, getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(rgba) }) }) };
      assert.deepEqual(await (await exportTiffAsync(canvas, options)).arrayBuffer(), await exportTiff(canvas, options).arrayBuffer());
      assert.deepEqual(padded, original);
    }
  }
});

test('cooperative TIFF save propagates codec and destination failures without retrying', async () => {
  await assert.rejects(writeTiffAsync({ width: 3, height: 2, rgba: pixels }, { compression: 'zip' }), /compression/);
  const originalWindow = globalThis.window; let writes = 0;
  const failure = new Error('destination unavailable');
  globalThis.window = { paintDesktop: { saveImage: () => { writes++; throw failure; } } };
  try {
    const invalid = { width: 3, height: 2, getContext: () => ({ getImageData: () => ({ data: pixels.subarray(1) }) }) };
    await assert.rejects(saveImageFile(invalid, 'tiff'), /pixel length/);
    assert.equal(writes, 0, 'failed encoding never reaches the save destination');
    const valid = { width: 3, height: 2, getContext: () => ({ getImageData: () => ({ data: pixels }) }) };
    await assert.rejects(saveImageFile(valid, 'tiff'), error => error === failure);
    assert.equal(writes, 1);
  } finally {
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  }
});

test('TIFF encoder rejects invalid dimensions, buffers and unsupported options', () => {
  const valid = { width: 3, height: 2, rgba: pixels };
  for (const width of [0, -1, 1.5, NaN, 16385]) assert.throws(() => writeTiff({ ...valid, width }), /dimensions/);
  assert.throws(() => writeTiff({ ...valid, width: 16384, height: 16384 }), /dimensions/);
  assert.throws(() => writeTiff({ ...valid, rgba: pixels.subarray(1) }), /pixel length/);
  assert.throws(() => writeTiff(valid, { compression: 'zip' }), /compression/);
});

test('TIFF encoder enforces the encoded budget for uncompressed and expanding cooperative LZW output', async () => {
  const width = 4096, height = 4096, rgba = new Uint8Array(width * height * 4);
  assert.throws(() => writeTiff({ width, height, rgba }, { compression: 'none' }), /file limit/);
  const strip = noise(65536);
  for (let offset = 0; offset < rgba.length; offset += strip.length) rgba.set(strip, offset);
  await assert.rejects(writeTiffAsync({ width, height, rgba }), /file limit/);
});

test('RGB expands alpha and all eight orientations map asymmetric pixels correctly', async () => {
  const raw = Uint8Array.from([1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0, 5, 0, 0, 6, 0, 0]);
  const grids = [[1, 2, 3, 4, 5, 6], [3, 2, 1, 6, 5, 4], [6, 5, 4, 3, 2, 1], [4, 5, 6, 1, 2, 3],
    [1, 4, 2, 5, 3, 6], [4, 1, 5, 2, 6, 3], [6, 3, 5, 2, 4, 1], [3, 6, 2, 5, 1, 4]];
  for (let orientation = 1; orientation <= 8; orientation++) {
    const decoded = await readTiff(fixture({ samples: 3, raw, orientation }));
    assert.equal(decoded.width, orientation >= 5 ? 2 : 3); assert.equal(decoded.height, orientation >= 5 ? 3 : 2);
    assert.deepEqual([...decoded.rgba].filter((_, i) => i % 4 === 0), grids[orientation - 1]);
    assert.ok([...decoded.rgba].filter((_, i) => i % 4 === 3).every(value => value === 255));
  }
});

test('associated alpha is unpremultiplied while zero alpha is well-defined', async () => {
  const decoded = await readTiff(fixture({ width: 2, height: 1, raw: Uint8Array.of(64, 32, 0, 128, 0, 0, 0, 0), alpha: 1 }));
  assert.deepEqual([...decoded.rgba], [128, 64, 0, 128, 0, 0, 0, 0]);
});

test('LZW early width transitions through 12 bits and full dictionary remain bounded', async () => {
  const raw = Uint8Array.from({ length: 5000 }, (_, index) => (index * 37) & 255);
  const decoded = await readTiff(fixture({ width: 1250, height: 1, raw, compression: 5 }));
  assert.deepEqual(decoded.rgba, raw);
});

test('LZW handles dictionary self-reference and reset, PackBits handles runs and no-ops', async () => {
  const raw = new Uint8Array(12).fill(65);
  const lzwStrip = packCodes([[256, 9], [65, 9], [258, 9], [259, 9], [256, 9], [65, 9], [258, 9], [259, 9], [257, 9]]);
  assert.deepEqual((await readTiff(fixture({ width: 3, height: 1, raw, compression: 5, stripData: () => lzwStrip }))).rgba, raw);
  const runs = Uint8Array.of(128, 245, 65, 128);
  assert.deepEqual((await readTiff(fixture({ width: 3, height: 1, raw, compression: 32773, stripData: () => runs }))).rgba, raw);
});

test('multi-chunk Deflate is checked by native and independent bounded codecs', async () => {
  const raw = Uint8Array.from({ length: 128 * 256 * 4 }, (_, index) => index * 53 & 255);
  const encoded = fixture({ width: 128, height: 256, raw, compression: 8, predictor: 2 });
  assert.deepEqual((await readTiff(encoded)).rgba, raw);
  assert.deepEqual((await readTiff(encoded, { inflate: boundedZlib })).rgba, raw);
});

test('every truncated prefix fails', async () => {
  const bytes = fixture();
  for (let end = 0; end < bytes.length; end++) await assert.rejects(readTiff(bytes.subarray(0, end)));
});

test('unsupported TIFF variants and interpretations fail explicitly', async () => {
  const cases = [
    [[258, [3, [16, 16, 16, 16]]]], [[259, [3, [7]]]], [[262, [3, [3]]]], [[274, [3, [9]]]],
    [[284, [3, [2]]]], [[266, [3, [2]]]], [[317, [3, [3]]]], [[338, [3, [0]]]],
    [[339, [3, [3, 3, 3, 3]]]], [[34675, [4, [1]]]], [[322, [4, [16]]]], [[330, [4, [8]]]],
    [[254, [4, [1]]]], [[297, [3, [0, 2]]]], [[258, null]], [[338, null]], [[278, [4, [0]]]],
  ];
  for (const overrides of cases) await assert.rejects(readTiff(fixture({ overrides })), /Unsupported or invalid TIFF/);
  const big = fixture(); new DataView(big.buffer).setUint16(2, 43, true); await assert.rejects(readTiff(big), /BigTIFF/);
  const pages = fixture(), view = new DataView(pages.buffer); view.setUint32(10 + view.getUint16(8, true) * 12, 8, true);
  await assert.rejects(readTiff(pages), /multiple pages/);
});

test('malformed tag counts, types, strip ranges, overlap and duplicate tags fail before inflation', async () => {
  const bytes = fixture({ compression: 8, rowsPerStrip: 1 }); let calls = 0;
  const cases = [change(bytes, 258, 4, 0xffffffff), change(bytes, 258, 8, 0xffffffff), change(bytes, 258, 2, 99, 2),
    change(bytes, 259, 0, 258, 2), change(bytes, 273, 4, 1), change(bytes, 273, 8, 0xffffffff), change(bytes, 279, 4, 0)];
  const overlapping = bytes.slice(), view = new DataView(overlapping.buffer), offsetTable = view.getUint32(fieldOffset(overlapping, 273) + 8, true);
  view.setUint32(offsetTable + 4, view.getUint32(offsetTable, true), true); cases.push(overlapping);
  for (const invalid of cases) await assert.rejects(readTiff(invalid, { inflate: () => { calls++; throw new Error('unexpected inflate'); } }));
  assert.equal(calls, 0);
});

test('dimension limits are enforced before allocating or inflating pixels', async () => {
  const bytes = fixture({ compression: 8 }); let calls = 0;
  for (const invalid of [change(bytes, 256, 8, 0), change(bytes, 256, 8, 16385), change(change(bytes, 256, 8, 16384), 257, 8, 16384)]) {
    await assert.rejects(readTiff(invalid, { inflate: () => { calls++; throw new Error('unexpected inflate'); } }), /dimensions/);
  }
  assert.equal(calls, 0);
});

test('strip codecs reject truncated, short and excessive expansion', async () => {
  const options = { width: 1, height: 1, raw: Uint8Array.of(1, 2, 3, 4) };
  for (const encoded of [
    fixture({ ...options, compression: 32773, stripData: () => Uint8Array.of(3, 1) }),
    fixture({ ...options, compression: 32773, stripData: () => Uint8Array.of(252, 1) }),
    fixture({ ...options, compression: 32773, stripData: () => Uint8Array.of(255) }),
    fixture({ ...options, compression: 32773, stripData: () => Uint8Array.of(0, 1) }),
    fixture({ ...options, compression: 5, stripData: () => packCodes([[256, 9], [65, 9], [258, 9], [259, 9], [257, 9]]) }),
    fixture({ ...options, compression: 5, stripData: () => packCodes([[256, 9], [258, 9], [257, 9]]) }),
    fixture({ ...options, compression: 5, stripData: () => packCodes([[256, 9], [1, 9]]) }),
    fixture({ ...options, compression: 5, stripData: () => packCodes([[256, 9], [1, 9], [257, 9]]) }),
    fixture({ ...options, compression: 8, stripData: () => new Uint8Array(deflateSync(new Uint8Array(1024 * 1024))) }),
    fixture({ ...options, compression: 8, stripData: () => new Uint8Array(deflateSync(Uint8Array.of(1, 2, 3))) }),
  ]) await assert.rejects(readTiff(encoded));
});

test('bounded Node Deflate adapter rejects trailing compressed data', async () => {
  const encoded = fixture({ compression: 8, stripData: bytes => join([new Uint8Array(deflateSync(bytes)), Uint8Array.of(1, 2, 3)]) });
  await assert.rejects(readTiff(encoded, { inflate: boundedZlib }), /trailing bytes/);
});

test('input views preserve byte offset and decoding does not mutate source', async () => {
  const encoded = fixture({ predictor: 2 }), padded = new Uint8Array(encoded.length + 12); padded.set(encoded, 7);
  const before = padded.slice(); assert.deepEqual((await readTiff(padded.subarray(7, 7 + encoded.length))).rgba, pixels);
  assert.deepEqual(padded, before);
});

test('owned native Paint LZW+predictor TIFF matches its independently saved .paint pixels', async t => {
  let bytes;
  try { bytes = await readFile(new URL('../output/reference-native-colors.tif', import.meta.url)); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('owned native fixture is not present'); return; } throw error; }
  assert.equal(digest(bytes), 'e9dea64dc8bc57c6d134256a3b63cb7f1bb97133be874d3c7b10f6a8008999d5');
  const decoded = await readTiff(bytes);
  assert.equal(decoded.width, 128); assert.equal(decoded.height, 128);
  assert.equal(digest(decoded.rgba), '8bd1c0687e45a45225da08f8ae5ff861aeb58142150adb8626001dcf5b655f30');
  let paint;
  try { paint = await readFile(new URL('../output/reference-eraser-tolerance-fine-result.paint', import.meta.url)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const source = await readPaint(paint); assert.equal(source.layers.length, 1); assert.deepEqual(decoded.rgba, source.layers[0].rgba);
});

test('owned native alpha TIFF matches Paint PNG export pixels, including native RGB rounding', async t => {
  let bytes;
  try { bytes = await readFile(new URL('../output/reference-native-alpha.tif', import.meta.url)); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('owned native alpha fixture is not present'); return; } throw error; }
  assert.equal(digest(bytes), 'cdaddd4653fe257673a040780b40232945724326cb09546d953ea1426cb4ed45');
  const decoded = await readTiff(bytes);
  assert.equal(decoded.width, 200); assert.equal(decoded.height, 100);
  // Independently established with Pillow from reference-alpha-export.png.
  // Native TIFF and PNG agree byte-for-byte; both differ from the original
  // .paint RGBA [180,80,40,128] by one RGB unit after Paint's rendering step.
  assert.equal(digest(decoded.rgba), '4a98f30e7eb6f3c5d328f1b80d4ed2f6a2f9e52ad18d0e4845825b5337bcf536');
  assert.deepEqual([...decoded.rgba.subarray((50 * 200 + 100) * 4, (50 * 200 + 100) * 4 + 4)], [179, 79, 39, 128]);
  assert.deepEqual([...decoded.rgba.subarray(0, 4)], [0, 0, 0, 0]);
  try {
    const png = await readFile(new URL('../output/reference-alpha-export.png', import.meta.url));
    assert.equal(digest(png), 'd1dff4385862ca4efcc3dc7b179cf70b1afd1b0b7e1f41fd67536547736e2ef1');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
});

test('malformed and unsupported gray-alpha imports remain rejected', async () => {
  for (const fixture of (await malformedTiffFixtures()).filter(f => f.name.startsWith('gray-alpha'))) await assert.rejects(readTiff(fixture.bytes), /TIFF/, fixture.name);
});
