import { PAINT_LIMITS, assertDocumentBudget } from './engine.js';

// Independent classic TIFF reader for the observed Paint 11.2605.81.0 profile
// and SJ Paint's RGBA export. No third-party implementation is included.
// Reference: TIFF 6.0 sections 7, 8, 9, 13 and 14 (RGB, PackBits and TIFF LZW).
// https://libtiff.gitlab.io/libtiff/specification/index.html
// This API returns pixels only. Resolution, descriptive metadata and Exif are
// not preserved; unsupported pixel/color interpretations fail explicitly.
const MAX_BYTES = PAINT_LIMITS.maxEncodedProjectBytes;
const fail = message => { throw new Error(`Unsupported or invalid TIFF: ${message}`); };
const check = (condition, message) => { if (!condition) fail(message); };
const bytesOf = input => {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError('TIFF input must be a Uint8Array or ArrayBuffer.');
};

function packBits(input, expected) {
  const output = new Uint8Array(expected);
  let source = 0, target = 0;
  while (source < input.length) {
    const header = input[source++];
    if (header === 128) continue; // Defined no-op.
    const count = header < 128 ? header + 1 : 257 - header;
    check(count <= expected - target, 'PackBits expansion exceeds the strip size');
    if (header < 128) {
      check(count <= input.length - source, 'truncated PackBits literal');
      output.set(input.subarray(source, source + count), target); source += count;
    } else {
      check(source < input.length, 'truncated PackBits run');
      output.fill(input[source++], target, target + count);
    }
    target += count;
  }
  check(target === expected, 'PackBits strip is shorter than its dimensions');
  return output;
}

function lzw(input, expected) {
  const output = new Uint8Array(expected);
  const prefixes = new Uint16Array(4096), suffixes = new Uint8Array(4096), stack = new Uint8Array(4096);
  let bit = 0, width = 9, next = 258, previous = -1, written = 0;
  const code = () => {
    check(bit + width <= input.length * 8, 'truncated LZW code or missing end marker');
    let value = 0;
    for (let n = 0; n < width; n++, bit++) value = value * 2 + ((input[bit >>> 3] >>> (7 - (bit & 7))) & 1);
    return value;
  };
  check(code() === 256, 'TIFF LZW must begin with a clear code');
  while (true) {
    const current = code();
    if (current === 256) { width = 9; next = 258; previous = -1; continue; }
    if (current === 257) break;
    check(current < next || (current === next && previous !== -1 && next < 4096), 'invalid LZW dictionary reference');
    if (previous === -1) check(current < 256, 'LZW stream must start with a literal after clear');
    const special = current === next;
    let cursor = special ? previous : current, length = 0;
    while (cursor >= 258) {
      check(cursor < next && length < stack.length - 1, 'invalid or cyclic LZW dictionary');
      stack[length++] = suffixes[cursor]; cursor = prefixes[cursor];
    }
    check(cursor < 256, 'reserved code inside LZW dictionary');
    const first = cursor; stack[length++] = first;
    check(length + Number(special) <= expected - written, 'LZW expansion exceeds the strip size');
    for (let n = length - 1; n >= 0; n--) output[written++] = stack[n];
    if (special) output[written++] = first;
    if (previous !== -1 && next < 4096) {
      prefixes[next] = previous; suffixes[next] = first; next++;
      // TIFF uses early code-width changes, unlike GIF's LZW convention.
      if (width < 12 && next === (1 << width) - 1) width++;
    }
    previous = current;
  }
  check(written === expected, 'LZW strip is shorter than its dimensions');
  check(input.length * 8 - bit < 8, 'extra data after LZW end marker');
  while (bit < input.length * 8) { check(((input[bit >>> 3] >>> (7 - (bit & 7))) & 1) === 0, 'nonzero LZW padding'); bit++; }
  return output;
}

async function inflateStrip(input, expected) {
  // Chromium rejects trailing compressed input. Some Node versions accept it;
  // Node validation needing strict consumption must inject a bounded inflater.
  let stream;
  try { stream = new DecompressionStream('deflate'); }
  catch { fail('this runtime needs zlib decompression support or an injected bounded inflate codec'); }
  let position = 0;
  const source = new ReadableStream({ pull(controller) {
    if (position === input.length) { controller.close(); return; }
    const end = Math.min(position + 65536, input.length);
    controller.enqueue(input.subarray(position, end)); position = end;
  } });
  const reader = source.pipeThrough(stream).getReader(), output = new Uint8Array(expected);
  let written = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      check(value.length <= expected - written, 'Deflate expansion exceeds the strip size');
      output.set(value, written); written += value.length;
    }
    check(written === expected, 'Deflate strip is shorter than its dimensions');
    return output;
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw new Error(`Could not decompress TIFF strip: ${error.message}`, { cause: error });
  } finally { reader.releaseLock(); }
}

/**
 * Read one classic TIFF image: chunky RGB/RGBA8, strips, orientations 1-8,
 * uncompressed/PackBits/TIFF-LZW/zlib-Deflate, predictor 1 or 2.
 * Optional trusted inflate(bytes, expectedBytes) must cap expansion and reject
 * trailing streams. Native stream chunk allocation is implementation-controlled.
 */
export async function readTiff(input, { inflate } = {}) {
  const bytes = bytesOf(input);
  check(bytes.length >= 8 && bytes.length <= MAX_BYTES, 'input exceeds the file limit or has no complete header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = bytes[0] === 73 && bytes[1] === 73;
  check(little || (bytes[0] === 77 && bytes[1] === 77), 'invalid byte order');
  const range = (start, length) => check(Number.isSafeInteger(start) && Number.isSafeInteger(length) && start >= 0 && length >= 0 &&
    start <= bytes.length && length <= bytes.length - start, 'field or strip lies outside the file');
  const u16 = offset => { range(offset, 2); return view.getUint16(offset, little); };
  const u32 = offset => { range(offset, 4); return view.getUint32(offset, little); };
  check(u16(2) === 42, 'BigTIFF and non-classic headers are not supported');
  const ifd = u32(4); check(ifd >= 8, 'invalid image directory offset');
  const count = u16(ifd); range(ifd + 2, count * 12 + 4);
  check(u32(ifd + 2 + count * 12) === 0, 'multiple pages and linked image directories are not supported');
  const fields = new Map(), typeSize = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
  // Unknown extensions can change pixel interpretation; accept only known image
  // tags and ancillary text/resolution/Exif pointers that this pixel-only API ignores.
  const allowed = new Set([254, 255, 256, 257, 258, 259, 262, 266, 269, 270, 271, 272, 273, 274, 277, 278, 279,
    282, 283, 284, 285, 286, 287, 296, 297, 305, 306, 315, 316, 317, 338, 339, 34665, 34853]);
  for (let index = 0; index < count; index++) {
    const entry = ifd + 2 + index * 12, tag = u16(entry), type = u16(entry + 2), values = u32(entry + 4);
    check(allowed.has(tag), `tag ${tag} is outside the supported pixel profile`);
    check(!fields.has(tag) && type > 0 && type < typeSize.length && values > 0, 'duplicate tag or invalid field type/count');
    const length = values * typeSize[type], offset = length <= 4 ? entry + 8 : u32(entry + 8); range(offset, length);
    fields.set(tag, { type, count: values, offset });
  }
  const values = (tag, length, fallback) => {
    const field = fields.get(tag);
    if (!field) { check(fallback !== undefined, `required tag ${tag} is missing`); return fallback; }
    check((field.type === 3 || field.type === 4) && field.count === length, `invalid values for tag ${tag}`);
    return Array.from({ length }, (_, index) => field.type === 3 ? u16(field.offset + index * 2) : u32(field.offset + index * 4));
  };
  const scalar = (tag, fallback) => values(tag, 1, fallback === undefined ? undefined : [fallback])[0];
  const width = scalar(256), height = scalar(257);
  check(width > 0 && height > 0 && width <= PAINT_LIMITS.maxDimension && height <= PAINT_LIMITS.maxDimension &&
    width * height <= PAINT_LIMITS.maxPixels, 'image dimensions exceed the document limits');
  assertDocumentBudget(width, height, 1);
  check(scalar(254, 0) === 0 && scalar(255, 1) === 1, 'reduced images, masks and page subfiles are not supported');
  if (fields.has(297)) check(values(297, 2)[0] === 0 && values(297, 2)[1] === 1, 'multiple TIFF pages are not supported');
  const samples = scalar(277, 1);
  check(scalar(262) === 2 && (samples === 3 || samples === 4), 'only RGB and RGBA images are supported');
  check(values(258, samples).every(value => value === 8), 'only 8-bit channels are supported');
  check(values(339, samples, Array(samples).fill(1)).every(value => value === 1), 'only unsigned integer samples are supported');
  check(scalar(266, 1) === 1 && scalar(284, 1) === 1, 'reversed fill order and planar channels are not supported');
  const alpha = samples === 4 ? scalar(338) : 0;
  check(samples === 4 ? alpha === 1 || alpha === 2 : !fields.has(338), 'extra channels must declare associated or unassociated alpha');
  const orientation = scalar(274, 1), predictor = scalar(317, 1), compression = scalar(259, 1);
  check(orientation >= 1 && orientation <= 8, 'invalid image orientation');
  check(predictor === 1 || predictor === 2, 'unsupported predictor');
  check([1, 5, 8, 32946, 32773].includes(compression), `compression ${compression} is not supported`);
  const rowsPerStrip = scalar(278, 0xffffffff); check(rowsPerStrip > 0, 'zero rows per strip');
  const stripCount = Math.ceil(height / rowsPerStrip), offsets = values(273, stripCount), lengths = values(279, stripCount);
  for (let index = 0; index < stripCount; index++) {
    check(lengths[index] > 0, 'empty image strip'); range(offsets[index], lengths[index]);
    const expected = width * Math.min(rowsPerStrip, height - index * rowsPerStrip) * samples;
    if (compression === 1) check(lengths[index] === expected, 'uncompressed strip length does not match dimensions');
  }
  const spans = offsets.map((offset, index) => [offset, offset + lengths[index]]).sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < spans.length; index++) check(spans[index][0] >= spans[index - 1][1], 'overlapping image strips');
  // All tags, file ranges, dimensions and strip counts are validated before allocation.
  const outputWidth = orientation >= 5 ? height : width, outputHeight = orientation >= 5 ? width : height;
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < stripCount; index++) {
    const rows = Math.min(rowsPerStrip, height - index * rowsPerStrip), expected = width * rows * samples;
    const encoded = bytes.subarray(offsets[index], offsets[index] + lengths[index]);
    let decoded;
    if (compression === 1) decoded = predictor === 2 ? encoded.slice() : encoded;
    else if (compression === 32773) decoded = packBits(encoded, expected);
    else if (compression === 5) decoded = lzw(encoded, expected);
    else decoded = bytesOf(inflate ? await inflate(encoded, expected) : await inflateStrip(encoded, expected));
    check(decoded.length === expected, 'decoded strip length does not match dimensions');
    if (predictor === 2) {
      for (let row = 0; row < rows; row++) {
        const start = row * width * samples, end = start + width * samples;
        for (let pos = start + samples; pos < end; pos++) decoded[pos] = (decoded[pos] + decoded[pos - samples]) & 255;
      }
    }
    for (let row = 0; row < rows; row++) for (let x = 0; x < width; x++) {
      const y = index * rowsPerStrip + row;
      let ox = x, oy = y;
      if (orientation === 2) ox = width - 1 - x;
      else if (orientation === 3) { ox = width - 1 - x; oy = height - 1 - y; }
      else if (orientation === 4) oy = height - 1 - y;
      else if (orientation === 5) { ox = y; oy = x; }
      else if (orientation === 6) { ox = height - 1 - y; oy = x; }
      else if (orientation === 7) { ox = height - 1 - y; oy = width - 1 - x; }
      else if (orientation === 8) { ox = y; oy = width - 1 - x; }
      const source = (row * width + x) * samples, target = (oy * outputWidth + ox) * 4;
      const a = samples === 4 ? decoded[source + 3] : 255;
      for (let channel = 0; channel < 3; channel++) rgba[target + channel] = alpha === 1 ?
        (a === 0 ? 0 : Math.min(255, Math.round(decoded[source + channel] * 255 / a))) : decoded[source + channel];
      rgba[target + 3] = a;
    }
  }
  return { width: outputWidth, height: outputHeight, rgba };
}
