import test from 'node:test';
import assert from 'node:assert/strict';
import { readNativeFixture } from './native-fixtures.mjs';
import { createHash } from 'node:crypto';
import { deflateRawSync, deflateSync, inflateRawSync } from 'node:zlib';
import { readPaint, writePaint } from '../src/paint-format.js';
import { PAINT_LIMITS } from '../src/engine.js';

// Owned native fixtures are deliberately kept outside source control. Tests of
// generated documents and malformed inputs always run; fixture checks report skips.
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const doc = () => ({
  resolution: { xDpi: null, yDpi: null },
  width: 3, height: 2, background: [18, 52, 86, 128],
  layers: [
    { name: 'Lower layer', visible: true, opacity: 1, rgba: Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 127, 1, 2, 3, 4, 5, 6, 7, 8, 255, 255, 255, 255]) },
    { name: 'Upper \u2603', visible: true, opacity: 1, rgba: Uint8Array.from([0, 0, 0, 0, 180, 80, 40, 51, 30, 50, 90, 255, 5, 8, 13, 21, 34, 55, 89, 144, 233, 1, 2, 3]) },
  ],
});
const options = {
  inflate: (bytes, expected) => {
    const { buffer, engine } = inflateRawSync(bytes, { maxOutputLength: expected, info: true });
    if (engine.bytesWritten !== bytes.length) throw new Error('Trailing bytes after raw DEFLATE stream.');
    return new Uint8Array(buffer);
  },
  deflate: (bytes, cap) => {
    const result = new Uint8Array(deflateRawSync(bytes));
    assert.ok(result.length <= cap); return result;
  },
};
function findBox(bytes, type) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  function scan(start, end) {
    for (let offset = start; offset < end;) {
      const size = view.getUint32(offset), name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      if (name === type) return offset;
      const skip = { meta: 4, iinf: 6, iprp: 0, ipco: 0, iref: 4 }[name];
      if (skip !== undefined) { const found = scan(offset + 8 + skip, offset + size); if (found !== undefined) return found; }
      offset += size;
    }
  }
  const offset = scan(0, bytes.length); assert.notEqual(offset, undefined, `box ${type}`); return offset;
}
function edit(bytes, type, relative, values) {
  const result = bytes.slice(); result.set(values, findBox(result, type) + 8 + relative); return result;
}
function uint32(value) { return Uint8Array.of(value >>> 24, value >>> 16 & 255, value >>> 8 & 255, value & 255); }

test('native streams round-trip pixel alpha, layer order, names and separate background', async () => {
  const original = doc(), encoded = await writePaint(original), decoded = await readPaint(encoded);
  assert.deepEqual(decoded, original);
  assert.deepEqual(doc(), original, 'encoding must not mutate input pixels');
});

test('independent bounded zlib codec reads native-stream output and writes stream-readable output', async () => {
  const original = doc();
  assert.deepEqual(await readPaint(await writePaint(original), options), original);
  assert.deepEqual(await readPaint(await writePaint(original, options)), original);
});

test('transparent background and maximum supported layer count retain all pixel bytes', async () => {
  const original = { width: 1, height: 1, background: [0, 0, 0, 0], resolution: { xDpi: null, yDpi: null }, layers: Array.from({ length: 64 }, (_, i) => ({ name: String(i), visible: true, opacity: 1, rgba: Uint8Array.of(i, 255 - i, 100, i) })) };
  assert.deepEqual(await readPaint(await writePaint(original)), original);
  const transparent = doc(); transparent.background = null;
  assert.deepEqual((await readPaint(await writePaint(transparent))).background, [0, 0, 0, 0]);
});

test('stored-DEFLATE fallback is independently readable', async () => {
  const saved = globalThis.CompressionStream;
  let encoded;
  try { globalThis.CompressionStream = undefined; encoded = await writePaint(doc()); }
  finally { globalThis.CompressionStream = saved; }
  assert.deepEqual(await readPaint(encoded, options), doc());
});

test('multi-chunk streams and multiple stored DEFLATE blocks retain pixels', async () => {
  const original = { width: 128, height: 256, background: [0, 0, 0, 0], resolution: { xDpi: null, yDpi: null }, layers: [{ name: '', visible: true, opacity: 1, rgba: new Uint8Array(128 * 256 * 4) }] };
  let seed = 123456;
  for (let i = 0; i < original.layers[0].rgba.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; original.layers[0].rgba[i] = seed >>> 24; }
  assert.deepEqual(await readPaint(await writePaint(original)), original);
  const saved = globalThis.CompressionStream; let encoded;
  try { globalThis.CompressionStream = undefined; encoded = await writePaint(original); }
  finally { globalThis.CompressionStream = saved; }
  assert.deepEqual(await readPaint(encoded, options), original);
});

test('missing native decompression fails clearly and injected bounded decoder still works', async () => {
  const encoded = await writePaint(doc()), saved = globalThis.DecompressionStream;
  try {
    globalThis.DecompressionStream = undefined;
    await assert.rejects(readPaint(encoded), /injected bounded inflate/);
    assert.deepEqual(await readPaint(encoded, options), doc());
  } finally { globalThis.DecompressionStream = saved; }
});

test('writer rejects lossy or unrepresented document states', async () => {
  for (const change of [
    d => { d.layers[0].visible = false; }, d => { d.layers[0].opacity = 0.5; },
    d => { d.layers[0].rgba = new Uint8Array(2); }, d => { d.layers[0].name = 'bad\0name'; },
    d => { d.layers[0].name = '\ud800'; }, d => { d.background = '#fff'; },
    d => { d.background = [0, 0, 0, 0.5]; }, d => { d.width = 16385; },
    d => { d.width = 1.5; }, d => { d.layers = []; },
    d => { d.layers = Array(65).fill(d.layers[0]); },
  ]) { const invalid = doc(); change(invalid); await assert.rejects(writePaint(invalid)); }
});

test('oversized UTF-8 names fail before TextEncoder allocation', async () => {
  const invalid = doc();
  invalid.layers[0].name = '\u0800'.repeat(Math.floor(PAINT_LIMITS.maxEncodedProjectBytes / 3) + 1);
  const encode = TextEncoder.prototype.encode;
  let attemptedOversizedEncoding = false;
  try {
    TextEncoder.prototype.encode = function (value) {
      if (value === invalid.layers[0].name) { attemptedOversizedEncoding = true; throw new Error('Oversized encoding attempted.'); }
      return encode.call(this, value);
    };
    await assert.rejects(writePaint(invalid), /layer names exceed the file limit/);
    assert.equal(attemptedOversizedEncoding, false);
  } finally { TextEncoder.prototype.encode = encode; }
});

test('UTF-8 name accounting preserves all valid widths and rejects unpaired surrogates', async () => {
  const original = doc(); original.layers[0].name = 'A\u07ff\u0800\ud83c\udfa8';
  assert.deepEqual(await readPaint(await writePaint(original)), original);
  for (const name of ['\udc00', '\ud800x', '\ud800\ud800']) {
    const invalid = doc(); invalid.layers[0].name = name;
    await assert.rejects(writePaint(invalid), /not valid Unicode/);
  }
});

test('all truncated prefixes fail without inflating', async () => {
  const encoded = await writePaint(doc()); let calls = 0;
  for (let size = 0; size < encoded.length; size++) {
    await assert.rejects(readPaint(encoded.subarray(0, size), { inflate: () => { calls++; throw Error('unexpected inflate'); } }));
  }
  assert.equal(calls, 0);
});

test('unsupported structural variants fail before decompression', async () => {
  const encoded = await writePaint(doc()); let calls = 0;
  const mutations = [
    edit(encoded, 'ftyp', 0, Uint8Array.of(0, 0, 0, 0)),
    edit(encoded, 'iloc', 0, Uint8Array.of(2)),
    edit(encoded, 'iloc', 4, Uint8Array.of(0x88)),
    edit(encoded, 'iloc', 16, uint32(0xffffffff)),
    edit(encoded, 'iloc', 14, Uint8Array.of(0, 2)),
    edit(encoded, 'pitm', 4, Uint8Array.of(0, 99)),
    edit(encoded, 'infe', 3, Uint8Array.of(1)),
    edit(encoded, 'infe', 8, Uint8Array.of(104, 118, 99, 49)),
    edit(encoded, 'infe', 12, Uint8Array.of(0xff)),
    edit(encoded, 'ipma', 11, Uint8Array.of(0)),
    edit(encoded, 'dimg', 6, Uint8Array.of(0, 1)),
    edit(encoded, 'idat', 1, Uint8Array.of(1)),
    edit(encoded, 'idat', 2, Uint8Array.of(0, 1)),
    edit(encoded, 'idat', 14, Uint8Array.of(0, 1)),
    edit(encoded, 'cmpC', 4, Uint8Array.of(122, 108, 105, 98)),
    edit(encoded, 'colr', 5, Uint8Array.of(9)),
    edit(encoded, 'uncC', 33, Uint8Array.of(2)),
    edit(encoded, 'uncC', 17, Uint8Array.of(0, 2)),
    edit(encoded, 'pixi', 5, Uint8Array.of(16)),
    edit(encoded, 'ispe', 4, uint32(16385)),
  ];
  // Replacing only the major brand is valid while mif1 remains compatible.
  assert.deepEqual(await readPaint(mutations.shift()), doc());
  for (const invalid of mutations) await assert.rejects(readPaint(invalid, { inflate: () => { calls++; throw Error('unexpected inflate'); } }));
  assert.equal(calls, 0);
});

test('unknown properties and boxes fail instead of discarding possible layer semantics', async () => {
  const encoded = await writePaint(doc());
  for (const type of ['colr', 'iref', 'free']) {
    const invalid = encoded.slice(); invalid.set(new TextEncoder().encode('xxxx'), findBox(invalid, type) + 4);
    await assert.rejects(readPaint(invalid), /unsupported/);
  }
});

test('dimension and aggregate layer limits precede decompression', async () => {
  let bytes = await writePaint(doc()), calls = 0;
  bytes = edit(bytes, 'idat', 10, Uint8Array.of(0x20, 0, 0x10, 0)); // 8192x4096, two layers => 256 MiB
  await assert.rejects(readPaint(bytes, { inflate: () => { calls++; throw Error('unexpected inflate'); } }), /128 MiB/);
  assert.equal(calls, 0);
});

test('decompression bomb, truncated stream and wrapped zlib are rejected', async () => {
  const small = { width: 1, height: 1, background: [255, 255, 255, 255], layers: [{ name: '', visible: true, opacity: 1, rgba: Uint8Array.of(1, 2, 3, 4) }] };
  const bomb = await writePaint(small, { deflate: () => new Uint8Array(deflateRawSync(new Uint8Array(1024 * 1024))) });
  await assert.rejects(readPaint(bomb), /exceeds its byte limit/);
  await assert.rejects(readPaint(bomb, options));
  const short = await writePaint(small, { deflate: bytes => new Uint8Array(deflateRawSync(bytes)).subarray(0, 2) });
  await assert.rejects(readPaint(short));
  const wrapped = await writePaint(small, { deflate: bytes => new Uint8Array(deflateSync(bytes)) });
  await assert.rejects(readPaint(wrapped));
  const wrongLength = await writePaint(small, { deflate: () => new Uint8Array(deflateRawSync(Uint8Array.of(1, 2, 3))) });
  await assert.rejects(readPaint(wrongLength), /pixel length/);
});

test('bounded Node adapter rejects trailing junk and a second DEFLATE stream', async () => {
  // Chrome rejects trailing data natively. Node 24 DecompressionStream accepts it,
  // so Node verification uses zlib's consumed-input count as well as its output cap.
  for (const suffix of [Uint8Array.of(1, 2, 3), deflateRawSync(Uint8Array.of(99, 99, 99, 99))]) {
    const encoded = await writePaint(doc(), { deflate: bytes => {
      const compressed = deflateRawSync(bytes), result = new Uint8Array(compressed.length + suffix.length);
      result.set(compressed); result.set(suffix, compressed.length); return result;
    } });
    await assert.rejects(readPaint(encoded, options), /Trailing bytes after raw DEFLATE stream/);
  }
});

test('declared channel order is interpreted instead of assuming BGRA', async () => {
  const original = doc();
  const encoded = await writePaint(original, { deflate: bgra => {
    const rgba = bgra.slice(); for (let i = 0; i < rgba.length; i += 4) [rgba[i], rgba[i + 2]] = [rgba[i + 2], rgba[i]];
    return new Uint8Array(deflateRawSync(rgba));
  } });
  const rgbaDeclared = edit(edit(encoded, 'uncC', 12, Uint8Array.of(0, 0)), 'uncC', 22, Uint8Array.of(0, 2));
  assert.deepEqual(await readPaint(rgbaDeclared), original);
});

const fixtures = [
  { name: 'reference-native-single-layer.paint', layers: 1 },
  { name: 'reference-native-two-layers.paint', layers: 2 },
];
for (const fixture of fixtures) test(`owned native fixture: ${fixture.name}`, async t => {
  const bytes = await readNativeFixture(fixture.name);
  if (!bytes) { t.skip('Private fixture absent. Set SJ_PAINT_NATIVE_FIXTURE_DIR to its directory.'); return; }
  const decoded = await readPaint(bytes);
  assert.equal(decoded.width, 813); assert.equal(decoded.height, 431);
  assert.deepEqual(decoded.background, [255, 255, 255, 255]); assert.equal(decoded.layers.length, fixture.layers);
  const colors = decoded.layers.map(layer => {
    const counts = new Map(); for (let i = 0; i < layer.rgba.length; i += 4) { const color = layer.rgba.subarray(i, i + 4).join(','); counts.set(color, (counts.get(color) ?? 0) + 1); } return counts;
  });
  assert.equal(colors[0].get('237,28,36,255'), 2500); assert.equal(colors[0].get('0,0,0,0'), 347705);
  assert.equal(colors[0].get('0,0,0,255'), 194); assert.equal(colors[0].get('0,0,0,51'), 4);
  if (fixture.layers === 2) { assert.equal(colors[1].get('63,72,204,255'), 2310); assert.equal(colors[1].get('0,0,0,0'), 348093); }
  assert.deepEqual(await readPaint(await writePaint(decoded), options), decoded);
});
