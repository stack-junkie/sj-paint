import { PAINT_LIMITS, assertDocumentBudget } from './engine.js';
import PROJECT from './project-format.json' with { type: 'json' };
import { readPaint, writePaint } from './paint-format.js';

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_SIDE = PAINT_LIMITS.maxDimension;
const MAX_PIXELS = PAINT_LIMITS.maxPixels;
const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif', tiff: 'image/tiff' };

function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new Error('Images must fit within 16384 pixels per side and 32 million total pixels.');
  }
}

function filename(name, extension) {
  let stem = String(name || 'Untitled').replace(/^.*[/\\]/, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '');
  const suffix = stem.slice(stem.lastIndexOf('.') + 1).toLowerCase();
  if (stem.includes('.') && ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'paint', ...PROJECT.readableExtensions].includes(suffix)) stem = stem.slice(0, stem.lastIndexOf('.'));
  stem = stem.replace(/[. ]+$/g, '') || 'Untitled';
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
  return `${stem}.${extension}`;
}

function chooseFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.append(input);
    let done = false;
    let timer;
    const finish = (file) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(file || null);
    };
    // The cancel event is supported by current Chromium. Focus is a fallback
    // for older browsers that return without a change or cancel event.
    const onFocus = () => { timer = setTimeout(() => finish(input.files?.[0]), 1000); };
    input.addEventListener('change', () => finish(input.files?.[0]), { once: true });
    input.addEventListener('cancel', () => finish(null), { once: true });
    window.addEventListener('focus', onFocus, { once: true });
    input.click();
  });
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return true;
}

async function decode(blob, name) {
  if (!blob.size || blob.size > MAX_BYTES) throw new Error('Choose an image smaller than 64 MiB.');
  let bitmap;
  try { bitmap = await createImageBitmap(blob); }
  catch { throw new Error('This image could not be decoded. Try PNG, JPEG, WebP or BMP.'); }
  try {
    dimensions(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return { canvas, name };
  } finally { bitmap.close(); }
}

export async function readImageFile(file) {
  return decode(file, file.name || 'Clipboard.png');
}

export function isProjectFile(name) {
  return ['paint', ...PROJECT.readableExtensions].includes(String(name).split('.').at(-1).toLowerCase());
}

export async function openImageFile({ allowProjects = false } = {}) {
  if (window.paintDesktop) {
    const result = await window.paintDesktop.openImage({ allowProjects });
    if (!result) return null;
    const file = new File([result.bytes], result.name);
    return allowProjects && isProjectFile(file.name) ? readProjectFile(file) : readImageFile(file);
  }
  const projects = allowProjects ? `,.paint,${PROJECT.readableExtensions.map(extension => `.${extension}`).join(',')}` : '';
  const file = await chooseFile(`image/png,image/jpeg,image/webp,image/bmp,image/gif,.bmp${projects}`);
  return file ? allowProjects && isProjectFile(file.name) ? readProjectFile(file) : readImageFile(file) : null;
}

function canvasBlob(canvas, type, quality = 0.92) {
  dimensions(canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => {
    if (!blob || blob.type !== type) reject(new Error(`This browser cannot encode ${type}.`));
    else if (blob.size > MAX_BYTES) reject(new Error('The encoded image exceeds the 64 MiB file limit.'));
    else resolve(blob);
  }, type, quality));
}

function flattenedCanvas(canvas) {
  const flat = document.createElement('canvas');
  flat.width = canvas.width;
  flat.height = canvas.height;
  const context = flat.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, flat.width, flat.height);
  context.drawImage(canvas, 0, 0);
  return flat;
}

export function exportBmp(canvas) {
  dimensions(canvas.width, canvas.height);
  const { width, height } = canvas;
  const stride = Math.ceil(width * 3 / 4) * 4;
  const imageBytes = stride * height;
  if (54 + imageBytes > MAX_BYTES) throw new Error('The BMP exceeds the 64 MiB file limit.');
  const bytes = new Uint8Array(54 + imageBytes);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x42;
  bytes[1] = 0x4d;
  view.setUint32(2, bytes.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, imageBytes, true);
  view.setInt32(38, 2835, true);
  view.setInt32(42, 2835, true);
  const rgba = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * 4;
      const target = 54 + (height - 1 - y) * stride + x * 3;
      const alpha = rgba[source + 3] / 255;
      bytes[target] = Math.round(rgba[source + 2] * alpha + 255 * (1 - alpha));
      bytes[target + 1] = Math.round(rgba[source + 1] * alpha + 255 * (1 - alpha));
      bytes[target + 2] = Math.round(rgba[source] * alpha + 255 * (1 - alpha));
    }
  }
  return new Blob([bytes], { type: MIME.bmp });
}

export function exportGif(canvas) {
  dimensions(canvas.width, canvas.height);
  const { width, height } = canvas;
  const pixels = width * height;
  // Literal LZW codes reset before the dictionary reaches a 10-bit code.
  // This bounds encoder memory and avoids a document-sized dictionary.
  const codeCount = pixels + Math.ceil(pixels / 250) + 1;
  const compressedSize = Math.ceil(codeCount * 9 / 8);
  const fileSize = 800 + compressedSize + Math.ceil(compressedSize / 255) + 2;
  if (fileSize > MAX_BYTES) throw new Error('The GIF exceeds the 64 MiB file limit.');
  const bytes = new Uint8Array(fileSize);
  let offset = 0;
  const byte = value => { bytes[offset++] = value; };
  const word = value => { byte(value & 255); byte(value >> 8); };
  for (const value of 'GIF89a') byte(value.charCodeAt(0));
  word(width); word(height);
  byte(0xf7); byte(0); byte(0); // Global 256-entry color table, 8-bit color resolution.
  const palette = new Uint8Array(256 * 3);
  for (let red = 0; red < 6; red++) {
    for (let green = 0; green < 6; green++) {
      for (let blue = 0; blue < 6; blue++) {
        const index = (red * 36 + green * 6 + blue) * 3;
        palette[index] = red * 51;
        palette[index + 1] = green * 51;
        palette[index + 2] = blue * 51;
      }
    }
  }
  for (let gray = 0; gray < 39; gray++) palette.fill(Math.round(gray * 255 / 38), (216 + gray) * 3, (217 + gray) * 3);
  bytes.set(palette, offset); offset += palette.length;
  // A single frame with binary transparency, index 255 reserved for alpha < 128.
  for (const value of [0x21, 0xf9, 4, 1, 0, 0, 255, 0, 0x2c]) byte(value);
  word(0); word(0); word(width); word(height); byte(0); byte(8);
  const rgba = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  let blockSizeOffset = offset++;
  let blockLength = 0;
  let bitBuffer = 0;
  let bitCount = 0;
  const dataByte = value => {
    if (blockLength === 255) {
      bytes[blockSizeOffset] = blockLength;
      blockSizeOffset = offset++;
      blockLength = 0;
    }
    byte(value);
    blockLength++;
  };
  const code = value => {
    bitBuffer |= value << bitCount;
    bitCount += 9;
    while (bitCount >= 8) {
      dataByte(bitBuffer & 255);
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  };
  for (let pixel = 0; pixel < pixels; pixel++) {
    if (pixel % 250 === 0) code(256);
    const source = pixel * 4;
    let index = 255;
    if (rgba[source + 3] >= 128) {
      const red = rgba[source], green = rgba[source + 1], blue = rgba[source + 2];
      index = Math.round(red / 51) * 36 + Math.round(green / 51) * 6 + Math.round(blue / 51);
      const grayIndex = 216 + Math.round((red + green + blue) / 3 * 38 / 255);
      const cubeError = (red - palette[index * 3]) ** 2 + (green - palette[index * 3 + 1]) ** 2 + (blue - palette[index * 3 + 2]) ** 2;
      const gray = palette[grayIndex * 3];
      const grayError = (red - gray) ** 2 + (green - gray) ** 2 + (blue - gray) ** 2;
      if (grayError < cubeError) index = grayIndex;
    }
    code(index);
  }
  code(257);
  if (bitCount) dataByte(bitBuffer & 255);
  bytes[blockSizeOffset] = blockLength;
  byte(0); byte(0x3b);
  return new Blob([bytes.subarray(0, offset)], { type: MIME.gif });
}

export function exportTiff(canvas) {
  dimensions(canvas.width, canvas.height);
  const { width, height } = canvas;
  const entryCount = 14;
  const bitsOffset = 8 + 2 + entryCount * 12 + 4;
  const resolutionOffset = bitsOffset + 8;
  const pixelOffset = resolutionOffset + 16;
  const pixelBytes = width * height * 4;
  if (pixelOffset + pixelBytes > MAX_BYTES) throw new Error('The TIFF exceeds the 64 MiB file limit.');
  const header = new Uint8Array(pixelOffset);
  const view = new DataView(header.buffer);
  header.set([0x49, 0x49, 42, 0]);
  view.setUint32(4, 8, true);
  view.setUint16(8, entryCount, true);
  let offset = 10;
  const tag = (id, type, count, value) => {
    view.setUint16(offset, id, true);
    view.setUint16(offset + 2, type, true);
    view.setUint32(offset + 4, count, true);
    if (type === 3 && count === 1) view.setUint16(offset + 8, value, true);
    else view.setUint32(offset + 8, value, true);
    offset += 12;
  };
  tag(256, 4, 1, width);
  tag(257, 4, 1, height);
  tag(258, 3, 4, bitsOffset);
  tag(259, 3, 1, 1); // No compression.
  tag(262, 3, 1, 2); // RGB photometric interpretation.
  tag(273, 4, 1, pixelOffset);
  tag(277, 3, 1, 4);
  tag(278, 4, 1, height);
  tag(279, 4, 1, pixelBytes);
  tag(282, 5, 1, resolutionOffset);
  tag(283, 5, 1, resolutionOffset + 8);
  tag(284, 3, 1, 1); // Interleaved RGBA samples.
  tag(296, 3, 1, 2); // Resolution in inches.
  tag(338, 3, 1, 2); // Unassociated alpha matches canvas ImageData.
  for (let channel = 0; channel < 4; channel++) view.setUint16(bitsOffset + channel * 2, 8, true);
  view.setUint32(resolutionOffset, 96, true);
  view.setUint32(resolutionOffset + 4, 1, true);
  view.setUint32(resolutionOffset + 8, 96, true);
  view.setUint32(resolutionOffset + 12, 1, true);
  const rgba = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  return new Blob([header, rgba], { type: MIME.tiff });
}

export async function saveImageFile(canvas, format = 'png', name = 'Untitled') {
  dimensions(canvas.width, canvas.height);
  if (format === 'jpg') format = 'jpeg';
  if (format === 'tif') format = 'tiff';
  if (!Object.hasOwn(MIME, format)) throw new Error('Supported exports are PNG, JPEG, GIF, TIFF, WebP and BMP.');
  const blob = format === 'bmp' ? exportBmp(canvas) : format === 'gif' ? exportGif(canvas) :
    format === 'tiff' ? exportTiff(canvas) :
    await canvasBlob(format === 'jpeg' ? flattenedCanvas(canvas) : canvas, MIME[format]);
  const suggestedName = filename(name, format === 'jpeg' ? 'jpg' : format);
  if (window.paintDesktop) {
    return window.paintDesktop.saveImage({ bytes: Array.from(new Uint8Array(await blob.arrayBuffer())), suggestedName, format });
  }
  return download(blob, suggestedName);
}

function validateProject(data) {
  if (!data || !PROJECT.readableFormats.includes(data.format) || data.version !== PROJECT.schemaVersion) throw new Error('This is not a supported SJ Paint project.');
  dimensions(data.width, data.height);
  if ((data.background !== null && typeof data.background !== 'string') ||
      !Array.isArray(data.layers) || data.layers.length < 1 || data.layers.length > PAINT_LIMITS.maxLayers) {
    throw new Error('Invalid project background or layer count.');
  }
  assertDocumentBudget(data.width, data.height, data.layers.length);
  const ids = new Set();
  for (const layer of data.layers) {
    if (!layer || typeof layer.id !== 'string' || !layer.id || ids.has(layer.id) ||
        typeof layer.name !== 'string' || typeof layer.visible !== 'boolean' ||
        !Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1 ||
        typeof layer.png !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]*={0,2}$/.test(layer.png)) {
      throw new Error('Invalid project layer data.');
    }
    ids.add(layer.id);
    const encoded = layer.png.slice(layer.png.indexOf(',') + 1);
    // Inspect the PNG IHDR before the consumer allocates decoded layer canvases.
    if (encoded.length < 44) throw new Error('A project layer has incomplete PNG data.');
    const header = Uint8Array.from(atob(encoded.slice(0, 44)), char => char.charCodeAt(0));
    const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
    if (!pngSignature.every((value, index) => header[index] === value)) throw new Error('A project layer is not PNG data.');
    const view = new DataView(header.buffer);
    if (view.getUint32(16) !== data.width || view.getUint32(20) !== data.height) {
      throw new Error('Project layer dimensions do not match the canvas.');
    }
  }
  if (!ids.has(data.activeLayerId)) throw new Error('The active project layer is missing.');
  return data;
}

export async function openProjectFile() {
  if (window.paintDesktop) {
    const result = await window.paintDesktop.openProject();
    if (!result) return null;
    return readProjectFile(new File([result.bytes], result.name));
  }
  const file = await chooseFile(`.paint,${PROJECT.readableExtensions.map(extension => `.${extension}`).join(',')},application/json`);
  return file ? readProjectFile(file) : null;
}

function parseProject(text, name) {
  if (new Blob([text]).size > PAINT_LIMITS.maxEncodedProjectBytes) throw new Error('The project exceeds the 64 MiB file limit.');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('The project does not contain valid JSON.'); }
  return { data: validateProject(data), name, format: PROJECT.extension };
}

export async function readProjectFile(file) {
  if (!file || typeof file.text !== 'function' || !Number.isFinite(file.size) || file.size < 0) throw new Error('Choose a project file.');
  if (file.size > PAINT_LIMITS.maxEncodedProjectBytes) throw new Error('The project exceeds the 64 MiB file limit.');
  if (/\.paint$/i.test(file.name)) {
    const decoded = await readPaint(new Uint8Array(await file.arrayBuffer()));
    const layers = decoded.layers.map((layer, index) => ({ ...layer, id: `paint-${index}` }));
    const background = `#${decoded.background.map(value => value.toString(16).padStart(2, '0')).join('')}`;
    return { name: file.name, format: 'paint', data: { ...decoded, background, layers, activeLayerId: layers.at(-1).id } };
  }
  return parseProject(await file.text(), file.name);
}

export async function savePaintFile(doc, name = 'Untitled') {
  // Capture before awaiting compression or a dialog so the saved revision and
  // pixels describe the same drawing even if the user continues editing.
  let background = [0, 0, 0, 0];
  if (/^#[\da-f]{6}([\da-f]{2})?$/i.test(doc.background)) {
    background = doc.background.slice(1).match(/../g).map(value => parseInt(value, 16));
    if (background.length === 3) background.push(255);
  } else if (doc.background !== null) {
    const swatch = document.createElement('canvas');
    swatch.width = swatch.height = 1;
    const ctx = swatch.getContext('2d');
    ctx.fillStyle = doc.background; ctx.fillRect(0, 0, 1, 1);
    background = [...ctx.getImageData(0, 0, 1, 1).data];
  }
  const data = { width: doc.width, height: doc.height,
    background,
    layers: doc.layers.map(layer => ({ name: layer.name, visible: layer.visible, opacity: layer.opacity,
      rgba: new Uint8Array(layer.canvas.getContext('2d').getImageData(0, 0, doc.width, doc.height).data.buffer) })) };
  const bytes = await writePaint(data);
  const suggestedName = filename(name, 'paint');
  return window.paintDesktop ? window.paintDesktop.savePaint({ bytes, suggestedName }) :
    download(new Blob([bytes], { type: 'application/octet-stream' }), suggestedName);
}

export async function saveProjectFile(data, name = 'Untitled') {
  validateProject(data);
  const text = JSON.stringify({ ...data, format: PROJECT.format, version: PROJECT.schemaVersion });
  const blob = new Blob([text], { type: 'application/json' });
  if (blob.size > PAINT_LIMITS.maxEncodedProjectBytes) throw new Error('The project exceeds the 64 MiB file limit.');
  const suggestedName = filename(name, PROJECT.extension);
  return window.paintDesktop ? window.paintDesktop.saveProject({ text, suggestedName }) : download(blob, suggestedName);
}

export async function copyCanvas(canvas) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Image clipboard access is unavailable in this browser.');
  // Promise-valued clipboard items preserve the initiating user gesture.
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': canvasBlob(canvas, 'image/png') })]);
  return true;
}

export async function pasteImage() {
  if (!navigator.clipboard?.read) throw new Error('Use the keyboard Paste command or open an image file in this browser.');
  for (const item of await navigator.clipboard.read()) {
    const type = item.types.find(value => value.startsWith('image/'));
    if (type) return (await decode(await item.getType(type), 'Clipboard.png')).canvas;
  }
  return null;
}

export async function printCanvas(canvas) {
  dimensions(canvas.width, canvas.height);
  if (window.paintDesktop) {
    // Desktop printing uses the existing document because new windows are denied.
    const printable = document.createElement('div');
    printable.id = 'paint-print-document';
    const image = document.createElement('img');
    image.src = canvas.toDataURL('image/png');
    image.alt = 'Drawing';
    printable.append(image);
    const style = document.createElement('style');
    style.textContent = '#paint-print-document{display:none}@media print{body>*:not(#paint-print-document){display:none!important}#paint-print-document{display:block!important}#paint-print-document img{display:block;max-width:100%;max-height:100%;object-fit:contain}}';
    document.head.append(style);
    document.body.append(printable);
    try { await image.decode(); return await window.paintDesktop.print(); }
    finally { printable.remove(); style.remove(); }
  }
  const page = window.open('', '_blank');
  if (!page) throw new Error('Allow a popup to print your drawing.');
  page.opener = null;
  page.document.title = 'Print drawing';
  const style = page.document.createElement('style');
  style.textContent = 'body{margin:0}img{display:block;max-width:100%;height:auto}@page{margin:12mm}';
  page.document.head.append(style);
  const image = page.document.createElement('img');
  image.alt = 'Drawing';
  image.src = canvas.toDataURL('image/png');
  page.document.body.append(image);
  await image.decode();
  page.addEventListener('afterprint', () => page.close(), { once: true });
  page.print();
  return true;
}
