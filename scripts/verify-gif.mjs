import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exportGif } from '../src/files.js';
import { writeGif } from '../src/gif.js';

const canvas = (width, height, rgba) => ({ width, height, getContext: () => ({ getImageData: () => ({ data: rgba }) }) });
const image = (width, height, pixel) => {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set(pixel(i), i * 4);
  return { width, height, rgba };
};
const encode = async ({ width, height, rgba }) => Buffer.from(await exportGif(canvas(width, height, rgba)).arrayBuffer());
function decode(bytes) {
  const result = spawnSync(process.env.PAINT_PYTHON_PATH || 'python', [fileURLToPath(new URL('./inspect-gif.py', import.meta.url))],
    { input: bytes, windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, `Independent GIF decoder failed. Select an existing Pillow installation with PAINT_PYTHON_PATH. ${result.error || result.stderr}`);
  const decoded = JSON.parse(result.stdout);
  assert.equal(decoded.format, 'GIF'); assert.equal(decoded.frames, 1);
  return { ...decoded, rgba: Buffer.from(decoded.rgba, 'base64') };
}
const paletteColor = i => [i, i * 67 % 256, i * 157 % 256, 255];

test('GIF preserves all 256 opaque source colors exactly', async () => {
  const fixture = image(256, 2, i => paletteColor(i % 256));
  const result = decode(await encode(fixture));
  assert.equal(result.width, fixture.width); assert.equal(result.height, fixture.height);
  assert.ok(result.rgba.equals(Buffer.from(fixture.rgba)), 'Independent decoder must retain every source RGB byte');
});

test('GIF reserves transparency only when needed and ignores hidden RGB', async () => {
  const fixture = image(17, 5, i => i % 4 === 0 ? [i, 254 - i, 17, 0] : i % 4 === 1 ? [18, 39, 73, 127] : [19, 41, 79, i % 4 === 2 ? 128 : 255]);
  const bytes = await encode(fixture), result = decode(bytes);
  for (let i = 0; i < fixture.rgba.length; i += 4) {
    if (fixture.rgba[i + 3] < 128) {
      assert.equal(result.rgba[i + 3], 0);
      fixture.rgba.set([255, 0, 211], i);
    } else assert.deepEqual([...result.rgba.slice(i, i + 4)], [19, 41, 79, 255]);
  }
  assert.deepEqual(await encode(fixture), bytes);
  const transparent = decode(await encode(image(1, 1, () => [139, 17, 251, 0])));
  assert.equal(transparent.rgba[3], 0);
});

test('adaptive GIF palette preserves a narrow multicolor gradient without cube banding', async t => {
  const fixture = image(256, 64, i => [80 + i % 96, 40 + Math.floor(i / 256) % 48, 90 + Math.floor(i / 37) % 40, 255]);
  const bytes = await encode(fixture), result = decode(bytes);
  let error = 0;
  for (let i = 0; i < fixture.rgba.length; i++) if (i % 4 !== 3) error += (fixture.rgba[i] - result.rgba[i]) ** 2;
  const mse = error / (fixture.width * fixture.height * 3);
  assert.ok(mse < 20, `Gradient RGB mean-square error ${mse} exceeds 20`);
  t.diagnostic(JSON.stringify({ decoder: result.decoder, width: fixture.width, height: fixture.height, rgbMeanSquareError: mse, encodedBytes: bytes.length }));
  assert.deepEqual(await encode(fixture), bytes, 'Same pixels must produce deterministic bytes');
});

test('GIF LZW compresses repeated pixels and independently decodes dictionary growth and resets', async t => {
  const flat = image(256, 256, () => [43, 111, 197, 255]), compressed = await encode(flat);
  assert.ok(compressed.length < 600, `Flat GIF used ${compressed.length} bytes`);
  assert.ok(decode(compressed).rgba.equals(Buffer.from(flat.rgba)), 'Repeated-color stream must decode exactly');
  t.diagnostic(JSON.stringify({ flatImagePixels: 65536, encodedBytes: compressed.length }));
  for (const colors of [4, 256]) {
    let seed = 0x13579bdf;
    const noise = image(512, 256, () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return paletteColor((seed & 255) % colors); });
    assert.ok(decode(await encode(noise)).rgba.equals(Buffer.from(noise.rgba)), `${colors}-color dictionary transitions/reset must decode exactly`);
  }
});

test('quantized GIF dithering smooths area colors and cannot cross transparent boundaries', async t => {
  // Two identical complex-color islands separated by a transparent row. The
  // final transparent column also catches accidental diffusion across row ends.
  const fixture = image(257, 257, i => {
    const x = i % 257, y = Math.floor(i / 257);
    if (x === 256 || y === 128) return [17, 241, 119, i % 2 ? 127 : 0];
    const localY = y % 129;
    return [x, localY * 2, (x * 3 + localY * 5) % 256, (x + y) % 2 ? 128 : 255];
  });
  const bytes = await encode(fixture), result = decode(bytes);
  for (let y = 0; y < 128; y++) {
    const first = y * 257 * 4, second = (y + 129) * 257 * 4;
    assert.deepEqual(result.rgba.subarray(first, first + 257 * 4), result.rgba.subarray(second, second + 257 * 4),
      'A transparent separator must prevent error leaking into the next identical island');
  }
  for (let offset = 0; offset < fixture.rgba.length; offset += 4) {
    assert.equal(result.rgba[offset + 3], fixture.rgba[offset + 3] < 128 ? 0 : 255);
    if (fixture.rgba[offset + 3] < 128) fixture.rgba.set([255, 0, 255], offset);
  }
  assert.deepEqual(await encode(fixture), bytes, 'Hidden RGB must affect neither palette nor neighboring dithered pixels');
  // An area-color bound complements the existing per-pixel MSE bound. It catches
  // visible gradient banding; neither measure alone establishes visual quality.
  let total = 0;
  for (let y = 0; y < 128; y += 8) for (let x = 0; x < 256; x += 8) for (let channel = 0; channel < 3; channel++) {
    let sum = 0;
    for (let dy = 0; dy < 8; dy++) for (let dx = 0; dx < 8; dx++) {
      const offset = ((y + dy) * 257 + x + dx) * 4 + channel;
      sum += fixture.rgba[offset] - result.rgba[offset];
    }
    total += Math.abs(sum / 64);
  }
  const areaError = total / (16 * 32 * 3);
  assert.ok(areaError < 1.5, `8x8 mean RGB error ${areaError} exceeds 1.5`);
  t.diagnostic(JSON.stringify({ decoder: result.decoder, areaError, encodedBytes: bytes.length }));
});

test('GIF keeps 255 opaque colors beside transparency and enforces its output bound', async () => {
  const fixture = image(256, 1, i => i === 255 ? [0, 0, 0, 0] : paletteColor(i));
  assert.ok(decode(await encode(fixture)).rgba.equals(Buffer.from(fixture.rgba)));
  assert.throws(() => writeGif(fixture, 20), /file limit/);
});
