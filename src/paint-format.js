import { PAINT_LIMITS, assertDocumentBudget } from './engine.js';
import { normalizeResolution, readTiffMetadata, writeExifResolution } from './image-metadata.js';

// Independent implementation of the subset observed in owned Paint 11.2605.81.0
// fixtures. Format reference: https://github.com/setiri/mspaintlib/blob/master/PAINT-FORMAT-SPEC.md
// No third-party source is included. This is not a general HEIF reader. Exif
// physical resolution is retained; unrelated Exif fields are not preserved.
// Layer arrays are bottom-to-top; background is straight RGBA8, separate from pixels.
const MAX_FILE = PAINT_LIMITS.maxEncodedProjectBytes;
const MAX_ITEMS = PAINT_LIMITS.maxLayers + 2;
const MAX_BOXES = MAX_ITEMS * 16;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const fail = message => { throw new Error(`Unsupported or invalid .paint file: ${message}`); };
const check = (condition, message) => { if (!condition) fail(message); };
const ascii = bytes => String.fromCharCode(...bytes);
const bytesOf = value => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError('.paint bytes must be a Uint8Array or ArrayBuffer.');
};

class Cursor {
  constructor(bytes) { this.bytes = bytes; this.position = 0; }
  take(length) {
    check(Number.isSafeInteger(length) && length >= 0 && length <= this.bytes.length - this.position, 'truncated field');
    const result = this.bytes.subarray(this.position, this.position + length);
    this.position += length;
    return result;
  }
  uint(length) { let value = 0; for (const byte of this.take(length)) value = value * 256 + byte; return value; }
  text(length) { return ascii(this.take(length)); }
  full(version = 0, flags = 0) { check(this.uint(1) === version && this.uint(3) === flags, 'unsupported box version or flags'); }
  end() { check(this.position === this.bytes.length, 'unexpected trailing fields'); }
}

function parser(bytes) {
  let count = 0;
  return (start, end) => {
    const result = [];
    while (start < end) {
      check(++count <= MAX_BOXES && end - start >= 8, 'box count or header exceeds bounds');
      const header = new Cursor(bytes.subarray(start, end));
      const size = header.uint(4), type = header.text(4);
      // Extended sizes and size-to-EOF are outside the observed bounded profile.
      check(size >= 8 && size <= end - start, `invalid ${type} box size`);
      result.push({ type, start, end: start + size, data: bytes.subarray(start + 8, start + size) });
      start += size;
    }
    return result;
  };
}

function only(boxes, allowed) {
  for (const box of boxes) check(allowed.includes(box.type), `unsupported ${box.type} box`);
}
function one(boxes, type, required = true) {
  const matches = boxes.filter(box => box.type === type);
  check(matches.length <= 1 && (!required || matches.length === 1), `missing or duplicate ${type} box`);
  return matches[0];
}
function fullChildren(box, parse, version = 0) {
  const c = new Cursor(box.data); c.full(version);
  return parse(box.start + 12, box.end);
}
function dimensions(width, height, layers = 1) {
  check(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
    width <= PAINT_LIMITS.maxDimension && height <= PAINT_LIMITS.maxDimension && width * height <= PAINT_LIMITS.maxPixels,
  'image dimensions exceed the document limits');
  assertDocumentBudget(width, height, layers);
}

// Native streams apply backpressure. Only the exact validated output buffer plus
// a native stream chunk is retained; the native implementation owns chunk sizing.
// A trusted caller may inject inflate(bytes, expectedBytes) / deflate(bytes, cap).
// An injected inflater must enforce the output cap and consume exactly one whole
// stream. Node 24's DecompressionStream accepts trailing input unlike Chromium;
// Node callers needing strict validation should inject the bounded zlib adapter.
async function transform(bytes, mode, limit, exact) {
  let stream;
  try {
    const Constructor = mode === 'inflate' ? globalThis.DecompressionStream : globalThis.CompressionStream;
    stream = new Constructor('deflate-raw');
  } catch {
    if (mode === 'deflate') return storedDeflate(bytes, limit);
    fail('this runtime needs raw DEFLATE decompression support or an injected bounded inflate codec');
  }
  let position = 0;
  const input = new ReadableStream({
    pull(controller) {
      if (position === bytes.length) { controller.close(); return; }
      const end = Math.min(position + 65536, bytes.length);
      controller.enqueue(bytes.subarray(position, end)); position = end;
    },
  });
  const reader = input.pipeThrough(stream).getReader();
  const output = exact ? new Uint8Array(limit) : [];
  let written = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      check(value.byteLength <= limit - written, `${mode} output exceeds its byte limit`);
      if (exact) output.set(value, written); else output.push(value);
      written += value.byteLength;
    }
    check(!exact || written === limit, 'decompressed pixel length does not match dimensions');
    return exact ? output : join(output, limit);
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw new Error(`Could not ${mode} .paint pixels: ${error.message}`, { cause: error });
  } finally { reader.releaseLock(); }
}

function storedDeflate(bytes, cap) {
  const length = bytes.length + Math.max(1, Math.ceil(bytes.length / 65535)) * 5;
  check(length <= cap, 'uncompressed DEFLATE fallback exceeds the file limit');
  const result = new Uint8Array(length);
  let input = 0, output = 0;
  do {
    const size = Math.min(65535, bytes.length - input), last = input + size === bytes.length;
    result[output++] = last ? 1 : 0;
    result[output++] = size & 255; result[output++] = size >>> 8;
    result[output++] = (~size) & 255; result[output++] = ((~size) >>> 8) & 255;
    result.set(bytes.subarray(input, input + size), output);
    output += size; input += size;
  } while (input < bytes.length);
  return result;
}

function imageProperties(properties, associations, itemId, layer) {
  const indices = associations.get(itemId);
  check(indices, `item ${itemId} has no property associations`);
  const chosen = indices.map(index => properties[index - 1]);
  only(chosen, layer ? ['cmpC', 'ispe', 'colr', 'cmpd', 'uncC', 'pixi'] : ['ispe', 'pixi']);
  const ispe = new Cursor(one(chosen, 'ispe').data); ispe.full();
  const width = ispe.uint(4), height = ispe.uint(4); ispe.end(); dimensions(width, height);
  const pixi = new Cursor(one(chosen, 'pixi').data); pixi.full();
  check(pixi.uint(1) === 4 && [...pixi.take(4)].every(value => value === 8), 'only four 8-bit channels are supported'); pixi.end();
  if (!layer) return { width, height };
  const cmpC = new Cursor(one(chosen, 'cmpC').data); cmpC.full();
  check(cmpC.text(4) === 'defl' && cmpC.uint(1) === 0, 'only unsegmented raw DEFLATE is supported'); cmpC.end();
  const colr = new Cursor(one(chosen, 'colr').data);
  check(colr.text(4) === 'nclx' && colr.uint(2) === 1 && colr.uint(2) === 13 && colr.uint(2) === 0 && colr.uint(1) === 128,
    'only full-range sRGB color is supported'); colr.end();
  const cmpd = new Cursor(one(chosen, 'cmpd').data);
  check(cmpd.uint(4) === 4, 'only RGBA component definitions are supported');
  const channels = Array.from({ length: 4 }, () => cmpd.uint(2)); cmpd.end();
  check(new Set(channels).size === 4 && channels.every(channel => channel >= 4 && channel <= 7), 'invalid RGBA component definitions');
  const uncC = new Cursor(one(chosen, 'uncC').data); uncC.full();
  check(uncC.text(4) === 'gene' && uncC.uint(4) === 4, 'unsupported uncompressed pixel profile');
  const swizzle = [];
  for (let byte = 0; byte < 4; byte++) {
    const index = uncC.uint(2);
    check(index < 4 && uncC.uint(1) === 7 && uncC.uint(1) === 0 && uncC.uint(1) === 0,
      'unsupported channel depth, format or alignment');
    check(swizzle[channels[index] - 4] === undefined, 'duplicate pixel channel');
    swizzle[channels[index] - 4] = byte;
  }
  check(uncC.uint(1) === 0 && uncC.uint(1) === 1 && [...uncC.take(22)].every(value => value === 0),
    'only untiled, unpacked, pixel-interleaved RGBA is supported'); uncC.end();
  return { width, height, swizzle };
}

/** Decode the observed full-canvas, visible, full-opacity .paint profile. */
export async function readPaint(input, { inflate } = {}) {
  const bytes = bytesOf(input);
  check(bytes.length > 0 && bytes.length <= MAX_FILE, 'file exceeds the encoded project limit');
  const parse = parser(bytes), top = parse(0, bytes.length);
  only(top, ['ftyp', 'meta', 'free', 'mdat']);
  const ftyp = new Cursor(one(top, 'ftyp').data), major = ftyp.text(4); ftyp.uint(4);
  const brands = [major]; while (ftyp.position < ftyp.bytes.length) brands.push(ftyp.text(4));
  check(brands.includes('mif1'), 'not a MIAF image project');
  const mdat = one(top, 'mdat'), meta = fullChildren(one(top, 'meta'), parse);
  only(meta, ['hdlr', 'pitm', 'iinf', 'iloc', 'iprp', 'iref', 'idat']);
  const handler = new Cursor(one(meta, 'hdlr').data); handler.full();
  check(handler.uint(4) === 0 && handler.text(4) === 'pict' && [...handler.take(12)].every(value => value === 0), 'unsupported metadata handler');
  check(handler.take(handler.bytes.length - handler.position).at(-1) === 0, 'unterminated handler name');
  const pitm = new Cursor(one(meta, 'pitm').data); pitm.full(); const primaryId = pitm.uint(2); pitm.end();
  const iinf = one(meta, 'iinf'), info = new Cursor(iinf.data); info.full(); const itemCount = info.uint(2);
  check(itemCount >= 2 && itemCount <= MAX_ITEMS, 'item count exceeds the supported profile');
  const entries = parse(iinf.start + 14, iinf.end); only(entries, ['infe']);
  check(entries.length === itemCount, 'item count mismatch');
  const items = new Map();
  for (const entry of entries) {
    const c = new Cursor(entry.data);
    check(c.uint(1) === 2, 'unsupported item info version'); const flags = c.uint(3);
    const id = c.uint(2); check(id > 0 && !items.has(id) && c.uint(2) === 0, 'duplicate or protected item');
    const type = c.text(4);
    check(['unci', 'iovl', 'Exif'].includes(type) && (type === 'Exif' ? flags === 1 : flags === 0), 'unsupported item type or visibility flags');
    const nameBytes = c.take(c.bytes.length - c.position);
    check(nameBytes.length > 0 && nameBytes.at(-1) === 0 && !nameBytes.subarray(0, -1).includes(0), 'invalid item name');
    let name; try { name = decoder.decode(nameBytes.subarray(0, -1)); } catch { fail('invalid UTF-8 item name'); }
    items.set(id, { id, type, name });
  }
  check(items.get(primaryId)?.type === 'iovl' && [...items.values()].filter(item => item.type === 'iovl').length === 1,
    'primary item must be the only overlay');
  const iloc = new Cursor(one(meta, 'iloc').data); iloc.full(1);
  check(iloc.uint(1) === 0x44 && iloc.uint(1) === 0 && iloc.uint(2) === items.size, 'unsupported item location layout');
  const idat = one(meta, 'idat');
  for (let index = 0; index < items.size; index++) {
    const item = items.get(iloc.uint(2)); check(item && !item.extent, 'unknown or duplicate location item');
    const method = iloc.uint(2); check((method === 0 || method === 1) && iloc.uint(2) === 0 && iloc.uint(2) === 1, 'unsupported external or fragmented item');
    const offset = iloc.uint(4), length = iloc.uint(4), start = method === 1 ? idat.start + 8 + offset : offset;
    const region = method === 1 ? idat : mdat;
    check(length > 0 && start >= region.start + 8 && start <= region.end && length <= region.end - start, 'item extent outside its data box');
    item.extent = bytes.subarray(start, start + length);
    item.range = [start, start + length];
  }
  iloc.end();
  const ranges = [...items.values()].map(item => item.range).sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < ranges.length; index++) check(ranges[index][0] >= ranges[index - 1][1], 'overlapping item extents');
  const iprp = one(meta, 'iprp'), propertyBoxes = parse(iprp.start + 8, iprp.end); only(propertyBoxes, ['ipco', 'ipma']);
  const ipco = one(propertyBoxes, 'ipco'), properties = parse(ipco.start + 8, ipco.end);
  only(properties, ['cmpC', 'ispe', 'colr', 'cmpd', 'uncC', 'pixi']);
  const ipma = new Cursor(one(propertyBoxes, 'ipma').data); ipma.full();
  const associationCount = ipma.uint(4), associations = new Map();
  check(associationCount <= items.size, 'too many property associations');
  for (let index = 0; index < associationCount; index++) {
    const id = ipma.uint(2), count = ipma.uint(1); check(items.has(id) && !associations.has(id), 'invalid property association item');
    const indices = [];
    for (let n = 0; n < count; n++) {
      const property = ipma.uint(1) & 127;
      check(property > 0 && property <= properties.length && !indices.includes(property), 'invalid property index'); indices.push(property);
    }
    associations.set(id, indices);
  }
  ipma.end();
  const references = fullChildren(one(meta, 'iref'), parse); only(references, ['dimg', 'cdsc']);
  let layerIds; const metadataIds = [];
  for (const reference of references) {
    const c = new Cursor(reference.data), from = c.uint(2), count = c.uint(2);
    check(count > 0 && count <= PAINT_LIMITS.maxLayers, 'invalid item reference count');
    const ids = Array.from({ length: count }, () => c.uint(2)); c.end();
    check(items.has(from) && ids.every(id => items.has(id)), 'reference to missing item');
    if (reference.type === 'dimg') {
      check(from === primaryId && !layerIds && new Set(ids).size === ids.length, 'unsupported overlay graph'); layerIds = ids;
    } else {
      check(items.get(from).type === 'Exif' && count === 1 && ids[0] === primaryId, 'unsupported metadata reference');
      metadataIds.push(from);
    }
  }
  check(layerIds?.length && layerIds.every(id => items.get(id).type === 'unci'), 'missing or invalid layer references');
  check([...items.values()].filter(item => item.type === 'unci').length === layerIds.length, 'unreferenced layers may encode unsupported visibility');
  const overlay = new Cursor(items.get(primaryId).extent);
  check(overlay.uint(1) === 0 && overlay.uint(1) === 0, 'unsupported overlay version or 32-bit layout');
  const background = Array.from({ length: 4 }, () => {
    const value = overlay.uint(2); check(value % 257 === 0, 'background cannot be represented losslessly as RGBA8'); return value / 257;
  });
  const width = overlay.uint(2), height = overlay.uint(2); dimensions(width, height, layerIds.length);
  for (let index = 0; index < layerIds.length; index++) check(overlay.uint(2) === 0 && overlay.uint(2) === 0, 'offset layers are not supported');
  overlay.end();
  const rootImage = imageProperties(properties, associations, primaryId, false);
  check(rootImage.width === width && rootImage.height === height, 'overlay dimensions disagree');
  const layouts = layerIds.map(id => {
    const layout = imageProperties(properties, associations, id, true);
    check(layout.width === width && layout.height === height, 'cropped or differently sized layers are not supported'); return layout;
  });
  check(metadataIds.length <= 1, 'ambiguous Exif resolution metadata');
  let resolution = normalizeResolution();
  if (metadataIds.length) {
    const metadata = items.get(metadataIds[0]).extent;
    check(metadata.length >= 4, 'truncated Exif offset');
    const offset = new DataView(metadata.buffer, metadata.byteOffset, metadata.byteLength).getUint32(0);
    check(offset <= metadata.length - 4, 'Exif offset exceeds its item');
    resolution = readTiffMetadata(metadata.subarray(4 + offset)).resolution;
  }
  // Validate the whole structure and aggregate pixel budget before any inflation.
  const layers = [];
  for (let index = 0; index < layerIds.length; index++) {
    const item = items.get(layerIds[index]), expected = width * height * 4;
    const rgba = bytesOf(inflate ? await inflate(item.extent, expected) : await transform(item.extent, 'inflate', expected, true));
    check(rgba.length === expected, 'decompressed pixel length does not match dimensions');
    const { swizzle } = layouts[index];
    for (let pixel = 0; pixel < rgba.length; pixel += 4) {
      const r = rgba[pixel + swizzle[0]], g = rgba[pixel + swizzle[1]], b = rgba[pixel + swizzle[2]], a = rgba[pixel + swizzle[3]];
      rgba[pixel] = r; rgba[pixel + 1] = g; rgba[pixel + 2] = b; rgba[pixel + 3] = a;
    }
    layers.push({ name: item.name, visible: true, opacity: 1, rgba });
  }
  return { width, height, background, layers, resolution };
}

function join(parts, cap = MAX_FILE) {
  const length = parts.reduce((sum, bytes) => sum + bytes.length, 0);
  check(length <= cap, 'encoded project exceeds the file limit');
  const result = new Uint8Array(length); let position = 0;
  for (const bytes of parts) { result.set(bytes, position); position += bytes.length; }
  return result;
}
const u8 = value => Uint8Array.of(value);
const u16 = value => Uint8Array.of(value >>> 8, value & 255);
const u32 = value => Uint8Array.of(value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
const text = value => encoder.encode(value);
const box = (type, ...parts) => { const payload = join(parts); return join([u32(payload.length + 8), text(type), payload]); };
const full = (type, version, ...parts) => box(type, u8(version), new Uint8Array(3), ...parts);

function nameByteLength(name, cap) {
  check(typeof name === 'string', 'invalid layer name');
  let length = 0;
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    check(code !== 0, 'invalid layer name');
    if (code < 0x80) length++;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = name.charCodeAt(++index);
      check(low >= 0xdc00 && low <= 0xdfff, 'layer name is not valid Unicode');
      length += 4;
    } else {
      check(code < 0xdc00 || code > 0xdfff, 'layer name is not valid Unicode');
      length += 3;
    }
    check(length <= cap, 'layer names exceed the file limit');
  }
  return length;
}

/** Encode this profile without flattening. Hidden layers or layer opacity fail. */
export async function writePaint(document, { deflate, resolution = document?.resolution } = {}) {
  check(document && Array.isArray(document.layers), 'document layers are missing');
  const { width, height, layers } = document; dimensions(width, height, layers.length);
  const background = document.background === null ? [0, 0, 0, 0] : document.background;
  check(Array.isArray(background) && background.length === 4 && background.every(value => Number.isInteger(value) && value >= 0 && value <= 255), 'background must be RGBA8');
  const names = [], pixels = []; let nameBytes = 0;
  for (const layer of layers) {
    check(layer && layer.visible === true && layer.opacity === 1, 'hidden layers and layer opacity cannot yet be encoded');
    // Count UTF-8 bytes and validate surrogate pairs before allocating the encoding.
    nameBytes += nameByteLength(layer.name, MAX_FILE - nameBytes);
    const name = text(layer.name);
    names.push(name);
    const rgba = bytesOf(layer.rgba); check(rgba.length === width * height * 4, 'layer pixel length does not match dimensions'); pixels.push(rgba);
  }
  const exifTiff = writeExifResolution(resolution, { double: true });
  const exif = exifTiff ? join([u32(0), exifTiff]) : null;
  const primary = layers.length + 1, itemCount = primary + (exif ? 1 : 0), exifId = primary + 1;
  const ftyp = box('ftyp', text('mif1'), u32(0), text('mif1gcmiisoamiaf'));
  const free = box('free', new Uint8Array(56));
  const ipco = box('ipco',
    full('cmpC', 0, text('defl'), u8(0)), full('ispe', 0, u32(width), u32(height)),
    box('colr', text('nclx'), u16(1), u16(13), u16(0), u8(128)),
    box('cmpd', u32(4), u16(4), u16(5), u16(6), u16(7)),
    full('uncC', 0, text('gene'), u32(4), ...[2, 1, 0, 3].flatMap(index => [u16(index), Uint8Array.of(7, 0, 0)]), Uint8Array.of(0, 1), new Uint8Array(22)),
    full('pixi', 0, Uint8Array.of(4, 8, 8, 8, 8)));
  const overlay = join([Uint8Array.of(0, 0), ...background.map(value => u16(value * 257)), u16(width), u16(height), new Uint8Array(layers.length * 4)]);
  const compressed = []; let payloadBytes = 0;
  const makeMeta = start => {
    let offset = start;
    const locations = compressed.map((data, index) => {
      const location = join([u16(index + 1), u16(0), u16(0), u16(1), u32(offset), u32(data.length)]);
      offset += data.length; return location;
    });
    const exifInfo = exif ? [box('infe', Uint8Array.of(2, 0, 0, 1), u16(exifId), u16(0), text('Exif'), u8(0))] : [];
    const exifLocation = exif ? [u16(exifId), u16(0), u16(0), u16(1), u32(offset), u32(exif.length)] : [];
    const exifReference = exif ? [box('cdsc', u16(exifId), u16(1), u16(primary))] : [];
    return full('meta', 0,
      full('hdlr', 0, u32(0), text('pict'), new Uint8Array(13)),
      full('pitm', 0, u16(primary)),
      full('iinf', 0, u16(itemCount), ...names.map((name, index) => full('infe', 2, u16(index + 1), u16(0), text('unci'), name, u8(0))), full('infe', 2, u16(primary), u16(0), text('iovl'), u8(0)), ...exifInfo),
      full('iloc', 1, Uint8Array.of(0x44, 0), u16(itemCount), ...locations, u16(primary), u16(1), u16(0), u16(1), u32(0), u32(overlay.length), ...exifLocation),
      box('iprp', ipco, full('ipma', 0, u32(primary), ...layers.map((_, index) => join([u16(index + 1), Uint8Array.of(6, 129, 2, 3, 132, 133, 6)])), u16(primary), Uint8Array.of(2, 2, 6))),
      full('iref', 0, box('dimg', u16(primary), u16(layers.length), ...layers.map((_, index) => u16(index + 1))), ...exifReference),
      box('idat', overlay));
  };
  // Compute exact metadata overhead with one location record for every layer.
  for (let index = 0; index < layers.length; index++) compressed.push(new Uint8Array(0));
  const headerLength = ftyp.length + makeMeta(0).length + free.length + 8;
  const overhead = headerLength + (exif?.length ?? 0);
  check(overhead < MAX_FILE, 'project metadata exceeds the file limit');
  for (let index = 0; index < pixels.length; index++) {
    const bgra = new Uint8Array(pixels[index].length), rgba = pixels[index];
    for (let pixel = 0; pixel < rgba.length; pixel += 4) {
      bgra[pixel] = rgba[pixel + 2]; bgra[pixel + 1] = rgba[pixel + 1]; bgra[pixel + 2] = rgba[pixel]; bgra[pixel + 3] = rgba[pixel + 3];
    }
    const cap = MAX_FILE - overhead - payloadBytes;
    const encoded = bytesOf(deflate ? await deflate(bgra, cap) : await transform(bgra, 'deflate', cap, false));
    check(encoded.length > 0 && encoded.length <= cap, 'compressed pixels exceed the file limit');
    compressed[index] = encoded; payloadBytes += encoded.length;
  }
  return join([ftyp, makeMeta(headerLength), free, box('mdat', ...compressed, ...(exif ? [exif] : []))]);
}
