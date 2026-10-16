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

// TIFF 6.0 section 13: MSB-first codes, early width changes, and an
// independent dictionary for each strip. No third-party encoder is included.
function encodeLzw(input, cap) {
  // At most one data code per input byte, a clear per 3837 data codes,
  // the initial clear and EOI, all conservatively charged at 12 bits.
  const bound = Math.ceil((input.length + Math.ceil(input.length / 3837) + 2) * 12 / 8);
  const output = new Uint8Array(Math.min(bound, cap));
  const dictionary = new Map();
  let position = 0, accumulator = 0, bits = 0, dataCodes = 0, next = 258;
  const byte = value => {
    check(position < output.length, 'encoded image exceeds the file limit');
    output[position++] = value;
  };
  const code = value => {
    // Count emitted data codes, which is also the decoder's dictionary clock.
    // This includes the final data code before EOI, even without a new encoder
    // dictionary entry. Its early width transition must still apply to EOI.
    const width = dataCodes < 254 ? 9 : dataCodes < 766 ? 10 : dataCodes < 1790 ? 11 : 12;
    accumulator = (accumulator << width) | value; bits += width;
    while (bits >= 8) { bits -= 8; byte((accumulator >>> bits) & 255); }
    accumulator &= (1 << bits) - 1;
    if (value === 256) dataCodes = 0;
    else if (value !== 257) dataCodes++;
  };
  code(256);
  let prefix = input[0];
  for (let index = 1; index < input.length; index++) {
    const value = input[index], key = prefix * 256 + value, found = dictionary.get(key);
    if (found !== undefined) { prefix = found; continue; }
    code(prefix);
    if (next === 4094) {
      code(256); dictionary.clear(); next = 258;
    } else dictionary.set(key, next++);
    prefix = value;
  }
  code(prefix); code(257);
  if (bits) byte(accumulator << (8 - bits));
  // Retain only actual encoded bytes, not each strip's worst-case capacity.
  return output.slice(0, position);
}

// One producer owns encoding for both synchronous fixtures and cooperative saves.
function* encodeTiff({ width, height, rgba }, { compression = 'lzw' } = {}) {
  check(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
    width <= PAINT_LIMITS.maxDimension && height <= PAINT_LIMITS.maxDimension && width * height <= PAINT_LIMITS.maxPixels,
  'image dimensions exceed the document limits');
  assertDocumentBudget(width, height, 1);
  check(compression === 'lzw' || compression === 'none', 'unsupported export compression');
  const pixels = rgba instanceof Uint8ClampedArray ? new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength) : bytesOf(rgba);
  check(pixels.length === width * height * 4, 'pixel length does not match dimensions');
  const compressed = compression === 'lzw', rowBytes = width * 4;
  // A complete row always fits in 64 KiB under the shared dimension limit.
  // Uncompressed mode retains the original one-strip TIFF representation.
  const rowsPerStrip = compressed ? Math.min(height, Math.max(1, Math.floor(65536 / rowBytes))) : height;
  const stripCount = Math.ceil(height / rowsPerStrip), entryCount = compressed ? 15 : 14;
  const bitsOffset = 8 + 2 + entryCount * 12 + 4, resolutionOffset = bitsOffset + 8;
  const offsetsOffset = resolutionOffset + 16, lengthsOffset = offsetsOffset + (stripCount > 1 ? stripCount * 4 : 0);
  const headerLength = lengthsOffset + (stripCount > 1 ? stripCount * 4 : 0);
  check(compressed || headerLength + pixels.length <= MAX_BYTES, 'encoded image exceeds the file limit');
  const strips = []; let totalBytes = headerLength;
  for (let row = 0; row < height; row += rowsPerStrip) {
    const end = Math.min(row + rowsPerStrip, height), source = pixels.subarray(row * rowBytes, end * rowBytes);
    let encoded = source;
    if (compressed) {
      const predicted = source.slice();
      for (let start = 0; start < predicted.length; start += rowBytes) {
        for (let pos = start + rowBytes - 1; pos >= start + 4; pos--) predicted[pos] = (predicted[pos] - predicted[pos - 4]) & 255;
      }
      encoded = encodeLzw(predicted, MAX_BYTES - totalBytes);
    }
    check(encoded.length <= MAX_BYTES - totalBytes, 'encoded image exceeds the file limit');
    strips.push(encoded); totalBytes += encoded.length;
    yield;
  }
  // Retained encoded strips and the final output are each capped at 64 MiB;
  // temporary prediction/code buffers are bounded by one 64 KiB input strip.
  const result = new Uint8Array(totalBytes), view = new DataView(result.buffer);
  result.set([73, 73, 42, 0]); view.setUint32(4, 8, true); view.setUint16(8, entryCount, true);
  let entry = 10;
  const tag = (id, type, count, value) => {
    view.setUint16(entry, id, true); view.setUint16(entry + 2, type, true); view.setUint32(entry + 4, count, true);
    if (type === 3 && count === 1) view.setUint16(entry + 8, value, true);
    else view.setUint32(entry + 8, value, true);
    entry += 12;
  };
  tag(256, 4, 1, width); tag(257, 4, 1, height); tag(258, 3, 4, bitsOffset);
  tag(259, 3, 1, compressed ? 5 : 1); tag(262, 3, 1, 2);
  tag(273, 4, stripCount, stripCount === 1 ? headerLength : offsetsOffset);
  tag(277, 3, 1, 4); tag(278, 4, 1, rowsPerStrip);
  tag(279, 4, stripCount, stripCount === 1 ? strips[0].length : lengthsOffset);
  tag(282, 5, 1, resolutionOffset); tag(283, 5, 1, resolutionOffset + 8);
  tag(284, 3, 1, 1); tag(296, 3, 1, 2);
  if (compressed) tag(317, 3, 1, 2);
  tag(338, 3, 1, 2); // Unassociated alpha, including RGB under zero alpha.
  for (let channel = 0; channel < 4; channel++) view.setUint16(bitsOffset + channel * 2, 8, true);
  for (const offset of [resolutionOffset, resolutionOffset + 8]) {
    view.setUint32(offset, 96, true); view.setUint32(offset + 4, 1, true);
  }
  let offset = headerLength;
  for (let index = 0; index < strips.length; index++) {
    const strip = strips[index];
    if (stripCount > 1) {
      view.setUint32(offsetsOffset + index * 4, offset, true);
      view.setUint32(lengthsOffset + index * 4, strip.length, true);
    }
    result.set(strip, offset); offset += strip.length;
    yield;
  }
  return result;
}

/** Encode RGBA8 classic TIFF; compression is 'lzw' (predictor 2) or 'none'. */
export function writeTiff(image, options) {
  const producer = encodeTiff(image, options);
  let step;
  do { step = producer.next(); } while (!step.done);
  return step.value;
}

/**
 * Encode the same bytes while allowing event-loop tasks between bounded strips.
 * The caller must keep its RGBA snapshot unchanged until the promise settles.
 * Canvas readback, final allocation and Blob/IPC conversion remain synchronous.
 */
export async function writeTiffAsync(image, options) {
  const producer = encodeTiff(image, options);
  let sliceStart = performance.now();
  try {
    while (true) {
      const step = producer.next();
      if (step.done) return step.value;
      if (performance.now() - sliceStart >= 8) {
        await new Promise(resolve => setTimeout(resolve, 0));
        sliceStart = performance.now();
      }
    }
  } finally { producer.return(); }
}

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
 * Read one classic TIFF image: chunky RGB/RGBA8 or single-channel grayscale/
 * palette at 1/2/4/8 bits, strips, orientations 1-8,
 * uncompressed/PackBits/TIFF-LZW/zlib-Deflate. Predictor 2 requires 8-bit samples.
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
    282, 283, 284, 285, 286, 287, 296, 297, 305, 306, 315, 316, 317, 320, 338, 339, 34665, 34853]);
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
  const samples = scalar(277, 1), photometric = scalar(262);
  check(photometric === 2 ? samples === 3 || samples === 4 : [0, 1, 3].includes(photometric) && samples === 1,
    'only RGB/RGBA and single-channel grayscale/palette images are supported');
  const depths = values(258, samples, Array(samples).fill(1)), bits = depths[0];
  check(samples === 1 ? [1, 2, 4, 8].includes(bits) : depths.every(value => value === 8),
    'only 1/2/4/8-bit grayscale/palette and 8-bit RGB/RGBA channels are supported');
  // TIFF pads each packed scanline separately, including the last row of a strip.
  // This layout owns both expansion limits and sample addressing below.
  const rowBytes = Math.ceil(width * samples * bits / 8), levels = 2 ** bits;
  check(values(339, samples, Array(samples).fill(1)).every(value => value === 1), 'only unsigned integer samples are supported');
  check(scalar(266, 1) === 1 && scalar(284, 1) === 1, 'reversed fill order and planar channels are not supported');
  const alpha = samples === 4 ? scalar(338) : 0;
  check(samples === 4 ? alpha === 1 || alpha === 2 : !fields.has(338), 'extra channels must declare associated or unassociated alpha');
  // Normalize single-channel interpretation once, before any strip inflation.
  // ColorMap contains separate 16-bit R/G/B tables. The RGBA8 engine retains
  // their high bytes, matching Pillow's palette conversion, not higher precision.
  let colorTable;
  if (photometric === 3) check(fields.get(320)?.type === 3, 'palette ColorMap must contain SHORT values');
  else check(!fields.has(320), 'ColorMap is only supported for palette images');
  if (samples === 1) {
    const palette = photometric === 3 ? values(320, 3 * levels) : null;
    colorTable = new Uint8Array(levels * 4);
    for (let index = 0; index < levels; index++) {
      const gray = (photometric === 0 ? levels - 1 - index : index) * 255 / (levels - 1);
      for (let channel = 0; channel < 3; channel++) colorTable[index * 4 + channel] = palette ? palette[channel * levels + index] >>> 8 : gray;
      colorTable[index * 4 + 3] = 255;
    }
  }
  const orientation = scalar(274, 1), predictor = scalar(317, 1), compression = scalar(259, 1);
  check(orientation >= 1 && orientation <= 8, 'invalid image orientation');
  check(predictor === 1 || predictor === 2, 'unsupported predictor');
  check(bits === 8 || predictor === 1, 'packed samples require predictor 1');
  check([1, 5, 8, 32946, 32773].includes(compression), `compression ${compression} is not supported`);
  const rowsPerStrip = scalar(278, 0xffffffff); check(rowsPerStrip > 0, 'zero rows per strip');
  const stripCount = Math.ceil(height / rowsPerStrip), offsets = values(273, stripCount), lengths = values(279, stripCount);
  for (let index = 0; index < stripCount; index++) {
    check(lengths[index] > 0, 'empty image strip'); range(offsets[index], lengths[index]);
    const expected = rowBytes * Math.min(rowsPerStrip, height - index * rowsPerStrip);
    if (compression === 1) check(lengths[index] === expected, 'uncompressed strip length does not match dimensions');
  }
  const spans = offsets.map((offset, index) => [offset, offset + lengths[index]]).sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < spans.length; index++) check(spans[index][0] >= spans[index - 1][1], 'overlapping image strips');
  // All tags, file ranges, dimensions and strip counts are validated before pixel allocation.
  const outputWidth = orientation >= 5 ? height : width, outputHeight = orientation >= 5 ? width : height;
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < stripCount; index++) {
    const rows = Math.min(rowsPerStrip, height - index * rowsPerStrip), expected = rowBytes * rows;
    const encoded = bytes.subarray(offsets[index], offsets[index] + lengths[index]);
    let decoded;
    if (compression === 1) decoded = predictor === 2 ? encoded.slice() : encoded;
    else if (compression === 32773) decoded = packBits(encoded, expected);
    else if (compression === 5) decoded = lzw(encoded, expected);
    else decoded = bytesOf(inflate ? await inflate(encoded, expected) : await inflateStrip(encoded, expected));
    check(decoded.length === expected, 'decoded strip length does not match dimensions');
    if (predictor === 2) {
      for (let row = 0; row < rows; row++) {
        const start = row * rowBytes, end = start + rowBytes;
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
      const target = (oy * outputWidth + ox) * 4;
      if (colorTable) {
        const bit = x * bits, source = row * rowBytes + (bit >>> 3);
        const color = ((decoded[source] >>> (8 - bits - (bit & 7))) & (levels - 1)) * 4;
        for (let channel = 0; channel < 4; channel++) rgba[target + channel] = colorTable[color + channel];
        continue;
      }
      const source = row * rowBytes + x * samples;
      const a = samples === 4 ? decoded[source + 3] : 255;
      for (let channel = 0; channel < 3; channel++) rgba[target + channel] = alpha === 1 ?
        (a === 0 ? 0 : Math.min(255, Math.round(decoded[source + channel] * 255 / a))) : decoded[source + channel];
      rgba[target + 3] = a;
    }
  }
  return { width: outputWidth, height: outputHeight, rgba };
}
