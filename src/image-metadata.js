// Physical resolution has one representation at every codec boundary. Unknown
// axes stay null; display defaults belong to the document/UI, never the decoder.
const unknown = () => Object.freeze({ xDpi: null, yDpi: null });
const positive = value => Number.isFinite(value) && value > 0 ? value : null;
const fail = message => { throw new Error(`Invalid image metadata: ${message}`); };
const bytesOf = input => input instanceof Uint8Array ? input : new Uint8Array(input);
const text = (bytes, start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
const viewOf = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const range = (bytes, offset, length) => { if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset > bytes.length || length > bytes.length - offset) fail('field extends beyond the file'); };
export function normalizeResolution(value) {
  if (value == null) return unknown();
  if (typeof value !== 'object' || Array.isArray(value)) fail('resolution must be an object');
  const result = { xDpi: null, yDpi: null };
  for (const axis of ['xDpi', 'yDpi']) {
    if (value[axis] != null && positive(value[axis]) === null) fail(`${axis} must be a finite positive number or null`);
    result[axis] = value[axis] ?? null;
  }
  return Object.freeze(result);
}
export function resolutionPixelsPerMetre(dpi, maximum = 0xffffffff) {
  if (dpi === null) return 0;
  const value = Math.round(dpi / 0.0254);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail('resolution cannot be represented in this format');
  return value;
}
export function resolutionRational(dpi) {
  const denominator = Math.min(1000000, Math.floor(0xffffffff / dpi)), numerator = Math.round(dpi * denominator);
  if (denominator < 1 || numerator < 1 || numerator > 0xffffffff) fail('resolution cannot be represented as a TIFF rational');
  let a = numerator, b = denominator;
  while (b) { const remainder = a % b; a = b; b = remainder; }
  return [numerator / a, denominator / a];
}
const orient = (resolution, orientation) => orientation >= 5 && orientation <= 8 ? { xDpi: resolution.yDpi, yDpi: resolution.xDpi } : resolution;

// TIFF already owns its parsed fields; callers can pass that map to avoid
// reinterpreting the directory. Exif uses the same field owner independently.
export function readTiffMetadata(input, parsed) {
  const bytes = bytesOf(input), view = viewOf(bytes);
  let fields = parsed?.fields, little = parsed?.little;
  if (!fields) {
    range(bytes, 0, 8);
    little = text(bytes, 0, 2) === 'II';
    if ((!little && text(bytes, 0, 2) !== 'MM') || view.getUint16(2, little) !== 42) fail('invalid Exif TIFF header');
    const ifd = view.getUint32(4, little); range(bytes, ifd, 2);
    const count = view.getUint16(ifd, little); range(bytes, ifd + 2, count * 12 + 4);
    fields = new Map();
    const sizes = { 3: 2, 4: 4, 5: 8, 11: 4, 12: 8 };
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12, tag = view.getUint16(entry, little);
      if (![274, 282, 283, 296].includes(tag)) continue;
      if (fields.has(tag)) fail('duplicate resolution or orientation field');
      const type = view.getUint16(entry + 2, little), count = view.getUint32(entry + 4, little);
      if (count !== 1 || !sizes[type]) fail('unsupported resolution field type/count');
      const offset = sizes[type] <= 4 ? entry + 8 : view.getUint32(entry + 8, little);
      range(bytes, offset, sizes[type]); fields.set(tag, { type, count, offset });
    }
  }
  const scalar = tag => {
    const field = fields.get(tag); if (!field) return null;
    if (field.count !== 1) fail('resolution field must contain one value');
    const { type, offset } = field;
    if (type === 3) return view.getUint16(offset, little);
    if (type === 4) return view.getUint32(offset, little);
    if (type === 5) { const denominator = view.getUint32(offset + 4, little); return denominator ? view.getUint32(offset, little) / denominator : null; }
    if (type === 11) return view.getFloat32(offset, little);
    if (type === 12) return view.getFloat64(offset, little);
    fail('unsupported numeric resolution field');
  };
  const unit = scalar(296) ?? 2, factor = unit === 2 ? 1 : unit === 3 ? 2.54 : null;
  const resolution = factor === null ? unknown() : { xDpi: positive(scalar(282) * factor), yDpi: positive(scalar(283) * factor) };
  const orientation = parsed?.orientation ?? scalar(274) ?? 1;
  return { resolution: orient(resolution, orientation), orientation };
}

export function writeExifResolution(value, { double = false } = {}) {
  const resolution = normalizeResolution(value), axes = [[282, resolution.xDpi], [283, resolution.yDpi]].filter(([, dpi]) => dpi !== null);
  if (!axes.length) return null;
  const count = axes.length + 1, dataStart = 8 + 2 + count * 12 + 4;
  const bytes = new Uint8Array(dataStart + axes.length * 8), view = viewOf(bytes);
  bytes.set([73, 73, 42, 0]); view.setUint32(4, 8, true); view.setUint16(8, count, true);
  for (let i = 0; i < axes.length; i++) {
    const [tag, dpi] = axes[i], entry = 10 + i * 12, offset = dataStart + i * 8;
    view.setUint16(entry, tag, true); view.setUint16(entry + 2, double ? 12 : 5, true);
    view.setUint32(entry + 4, 1, true); view.setUint32(entry + 8, offset, true);
    if (double) view.setFloat64(offset, dpi, true);
    else { const [numerator, denominator] = resolutionRational(dpi); view.setUint32(offset, numerator, true); view.setUint32(offset + 4, denominator, true); }
  }
  const unitEntry = 10 + axes.length * 12;
  view.setUint16(unitEntry, 296, true); view.setUint16(unitEntry + 2, 3, true); view.setUint32(unitEntry + 4, 1, true); view.setUint16(unitEntry + 8, 2, true);
  return bytes;
}

function* pngChunks(bytes) {
  const view = viewOf(bytes);
  for (let offset = 8; offset < bytes.length;) {
    range(bytes, offset, 12); const length = view.getUint32(offset); range(bytes, offset, length + 12);
    const type = text(bytes, offset + 4, 4);
    yield { type, offset, length, bytes: bytes.subarray(offset, offset + length + 12) };
    offset += length + 12;
    if (type === 'IEND') break;
  }
}
function* jpegSegments(bytes) {
  const view = viewOf(bytes);
  for (let offset = 2; offset < bytes.length;) {
    const start = offset;
    if (bytes[offset++] !== 255) fail('invalid JPEG marker');
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) { yield { marker, start, end: bytes.length }; return; }
    if (marker === 1 || marker >= 0xd0 && marker <= 0xd7) { yield { marker, start, end: offset }; continue; }
    range(bytes, offset, 2); const length = view.getUint16(offset); if (length < 2) fail('invalid JPEG segment length'); range(bytes, offset, length);
    yield { marker, start, data: offset + 2, end: offset + length };
    offset += length;
  }
}
export function readImageResolution(input) {
  const bytes = bytesOf(input), view = viewOf(bytes);
  if (text(bytes, 0, 8) === '\x89PNG\r\n\x1a\n') {
    for (const chunk of pngChunks(bytes)) if (chunk.type === 'pHYs') {
      if (chunk.length !== 9) fail('invalid PNG physical resolution length');
      if (crc32(bytes.subarray(chunk.offset + 4, chunk.offset + 17)) !== view.getUint32(chunk.offset + 17)) fail('invalid PNG physical resolution checksum');
      return bytes[chunk.offset + 16] === 1 ? { xDpi: positive(view.getUint32(chunk.offset + 8) * 0.0254), yDpi: positive(view.getUint32(chunk.offset + 12) * 0.0254) } : unknown();
    }
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    let jfif = unknown(), exif;
    for (const segment of jpegSegments(bytes)) {
      const { marker, data, end } = segment;
      if (marker === 0xe0 && end - data >= 14 && text(bytes, data, 5) === 'JFIF\0') {
        const factor = bytes[data + 7] === 1 ? 1 : bytes[data + 7] === 2 ? 2.54 : null;
        if (factor) jfif = { xDpi: positive(view.getUint16(data + 8) * factor), yDpi: positive(view.getUint16(data + 10) * factor) };
      } else if (marker === 0xe1 && text(bytes, data, 6) === 'Exif\0\0') exif = readTiffMetadata(bytes.subarray(data + 6, end));
    }
    jfif = orient(jfif, exif?.orientation);
    return { xDpi: exif?.resolution.xDpi ?? jfif.xDpi, yDpi: exif?.resolution.yDpi ?? jfif.yDpi };
  } else if (text(bytes, 0, 2) === 'BM' && bytes.length >= 46 && view.getUint32(14, true) >= 40) {
    return { xDpi: positive(view.getInt32(38, true) * 0.0254), yDpi: positive(view.getInt32(42, true) * 0.0254) };
  }
  return unknown();
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
const join = parts => { const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result; };

// Renderer encoders create fresh PNG/JPEG data. Replace their default density
// with the document's density; this does not promise general Exif preservation.
export function writeImageResolution(input, format, value) {
  const bytes = bytesOf(input), resolution = normalizeResolution(value);
  if (format === 'png') {
    const parts = [bytes.subarray(0, 8)];
    for (const chunk of pngChunks(bytes)) {
      if (chunk.type === 'pHYs') continue;
      parts.push(chunk.bytes);
      if (chunk.type === 'IHDR' && (resolution.xDpi !== null || resolution.yDpi !== null)) {
        const physical = new Uint8Array(21), view = viewOf(physical); view.setUint32(0, 9); physical.set([112, 72, 89, 115], 4);
        view.setUint32(8, resolutionPixelsPerMetre(resolution.xDpi)); view.setUint32(12, resolutionPixelsPerMetre(resolution.yDpi)); physical[16] = 1;
        view.setUint32(17, crc32(physical.subarray(4, 17))); parts.push(physical);
      }
    }
    return join(parts);
  }
  if (format === 'jpeg') {
    const parts = [bytes.subarray(0, 2)], exif = writeExifResolution(resolution);
    if (exif) { const header = Uint8Array.of(255, 225, 0, exif.length + 8, 69, 120, 105, 102, 0, 0); parts.push(header, exif); }
    for (const { marker, start, data, end } of jpegSegments(bytes)) {
      if (marker === 0xe1 && text(bytes, data, 6) === 'Exif\0\0') continue;
      if (marker === 0xe0 && end - data >= 14 && text(bytes, data, 5) === 'JFIF\0') {
        const segment = bytes.slice(start, end), relative = data - start, view = viewOf(segment);
        const known = Number.isInteger(resolution.xDpi) && Number.isInteger(resolution.yDpi) && resolution.xDpi <= 65535 && resolution.yDpi <= 65535;
        segment[relative + 7] = known ? 1 : 0;
        view.setUint16(relative + 8, known ? Math.max(1, Math.round(resolution.xDpi)) : 1);
        view.setUint16(relative + 10, known ? Math.max(1, Math.round(resolution.yDpi)) : 1); parts.push(segment);
      } else parts.push(bytes.subarray(start, end));
    }
    return join(parts);
  }
  return bytes;
}
