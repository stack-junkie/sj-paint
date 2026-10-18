import { PAINT_LIMITS, assertDocumentBudget } from './engine.js';
import PROJECT from './project-format.json' with { type: 'json' };
import { readPaint, writePaint } from './paint-format.js';
import { readTiff, writeTiff, writeTiffAsync } from './tiff.js';
import { writeGif } from './gif.js';
import { normalizeResolution, readImageResolution, writeImageResolution, resolutionPixelsPerMetre } from './image-metadata.js';

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
  return { name };
}

async function decode(blob, name) {
  if (!blob.size || blob.size > MAX_BYTES) throw new Error('Choose an image smaller than 64 MiB.');
  const bytes = new Uint8Array(await blob.arrayBuffer()), header = bytes;
  const tiffHeader = (header[0] === 73 && header[1] === 73 && [42, 43].includes(header[2]) && header[3] === 0) ||
    (header[0] === 77 && header[1] === 77 && header[2] === 0 && [42, 43].includes(header[3]));
  if (tiffHeader || /\.tiff?$/i.test(name) || /^image\/(?:x-)?tiff?(?:;|$)/i.test(blob.type)) {
    // Validate TIFF dimensions, strip expansion and supported interpretations
    // before allocating a browser canvas. Magic takes precedence over names.
    const { width, height, rgba, resolution } = await readTiff(bytes);
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height), 0, 0);
    return { canvas, name, format: 'tiff', resolution, encodedBytes: blob.size };
  }
  const resolution = readImageResolution(bytes);
  let bitmap;
  try { bitmap = await createImageBitmap(blob); }
  catch { throw new Error('This image could not be decoded. Try PNG, JPEG, WebP, BMP or supported TIFF.'); }
  try {
    dimensions(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return { canvas, name, resolution, encodedBytes: blob.size };
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
    const decoded = await (allowProjects && isProjectFile(file.name) ? readProjectFile(file) : readImageFile(file));
    return { ...decoded, ...(result.target ? { target: result.target, targetFormat: result.targetFormat } : {}) };
  }
  const projects = allowProjects ? `,.paint,${PROJECT.readableExtensions.map(extension => `.${extension}`).join(',')}` : '';
  const file = await chooseFile(`image/png,image/jpeg,image/webp,image/bmp,image/gif,image/tiff,.bmp,.tif,.tiff${projects}`);
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

export function exportBmp(canvas, { resolution: requestedResolution } = {}) {
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
  const resolution = normalizeResolution(requestedResolution);
  view.setInt32(38, resolutionPixelsPerMetre(resolution.xDpi, 0x7fffffff), true);
  view.setInt32(42, resolutionPixelsPerMetre(resolution.yDpi, 0x7fffffff), true);
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
  const rgba = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  return writeGif({ width, height, rgba }, MAX_BYTES);
}

export function exportTiff(canvas, options) {
  dimensions(canvas.width, canvas.height);
  const { width, height } = canvas;
  const rgba = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  return new Blob([writeTiff({ width, height, rgba }, options)], { type: MIME.tiff });
}

export async function exportTiffAsync(canvas, options) {
  dimensions(canvas.width, canvas.height);
  const { width, height } = canvas;
  // Own one pixel snapshot before the first yield. Later canvas edits cannot
  // change this save, and the codec does not make another full-document copy.
  const rgba = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  return new Blob([await writeTiffAsync({ width, height, rgba }, options)], { type: MIME.tiff });
}

export async function saveImageFile(canvas, format = 'png', name = 'Untitled', { target, resolution: requestedResolution } = {}) {
  dimensions(canvas.width, canvas.height);
  if (format === 'jpg') format = 'jpeg';
  if (format === 'tif') format = 'tiff';
  if (!Object.hasOwn(MIME, format)) throw new Error('Supported exports are PNG, JPEG, GIF, TIFF, WebP and BMP.');
  const resolution = normalizeResolution(requestedResolution);
  let blob = format === 'bmp' ? exportBmp(canvas, { resolution }) : format === 'gif' ? exportGif(canvas) :
    format === 'tiff' ? await exportTiffAsync(canvas, { resolution }) :
    await canvasBlob(format === 'jpeg' ? flattenedCanvas(canvas) : canvas, MIME[format]);
  if (format === 'png' || format === 'jpeg') blob = new Blob([writeImageResolution(new Uint8Array(await blob.arrayBuffer()), format, resolution)], { type: MIME[format] });
  if (blob.size > MAX_BYTES) throw new Error('The encoded image exceeds the 64 MiB file limit.');
  const suggestedName = filename(name, format === 'jpeg' ? 'jpg' : format);
  if (window.paintDesktop) {
    const result = await window.paintDesktop.saveImage({ bytes: Array.from(new Uint8Array(await blob.arrayBuffer())), suggestedName, format, ...(target !== undefined ? { target } : {}) });
    return result ? { ...result, encodedBytes: blob.size } : null;
  }
  return { ...download(blob, suggestedName), encodedBytes: blob.size };
}

function validateProject(data) {
  if (!data || !PROJECT.readableFormats.includes(data.format) || data.version !== PROJECT.schemaVersion) throw new Error('This is not a supported SJ Paint project.');
  dimensions(data.width, data.height);
  normalizeResolution(data.resolution);
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
    const decoded = await readProjectFile(new File([result.bytes], result.name));
    return { ...decoded, ...(result.target ? { target: result.target, targetFormat: result.targetFormat } : {}) };
  }
  const file = await chooseFile(`.paint,${PROJECT.readableExtensions.map(extension => `.${extension}`).join(',')},application/json`);
  return file ? readProjectFile(file) : null;
}

function parseProject(text, name) {
  if (new Blob([text]).size > PAINT_LIMITS.maxEncodedProjectBytes) throw new Error('The project exceeds the 64 MiB file limit.');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('The project does not contain valid JSON.'); }
  return { data: validateProject(data), name, format: PROJECT.extension, resolution: normalizeResolution(data.resolution) };
}

export async function readProjectFile(file) {
  if (!file || typeof file.text !== 'function' || !Number.isFinite(file.size) || file.size < 0) throw new Error('Choose a project file.');
  if (file.size > PAINT_LIMITS.maxEncodedProjectBytes) throw new Error('The project exceeds the 64 MiB file limit.');
  if (/\.paint$/i.test(file.name)) {
    const decoded = await readPaint(new Uint8Array(await file.arrayBuffer()));
    const layers = decoded.layers.map((layer, index) => ({ ...layer, id: `paint-${index}` }));
    const background = `#${decoded.background.map(value => value.toString(16).padStart(2, '0')).join('')}`;
    return { name: file.name, format: 'paint', resolution: decoded.resolution, encodedBytes: file.size, data: { ...decoded, background, layers, activeLayerId: layers.at(-1).id } };
  }
  return { ...parseProject(await file.text(), file.name), encodedBytes: file.size };
}

export async function savePaintFile(doc, name = 'Untitled', { target, resolution = doc.resolution } = {}) {
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
  const data = { width: doc.width, height: doc.height, resolution: normalizeResolution(resolution),
    background,
    layers: doc.layers.map(layer => ({ name: layer.name, visible: layer.visible, opacity: layer.opacity,
      rgba: new Uint8Array(layer.canvas.getContext('2d').getImageData(0, 0, doc.width, doc.height).data.buffer) })) };
  const bytes = await writePaint(data);
  const suggestedName = filename(name, 'paint');
  const result = window.paintDesktop ? await window.paintDesktop.savePaint({ bytes, suggestedName, ...(target !== undefined ? { target } : {}) }) :
    download(new Blob([bytes], { type: 'application/octet-stream' }), suggestedName);
  return result ? { ...result, encodedBytes: bytes.length } : null;
}

export async function saveProjectFile(data, name = 'Untitled', { target } = {}) {
  validateProject(data);
  const text = JSON.stringify({ ...data, format: PROJECT.format, version: PROJECT.schemaVersion });
  const blob = new Blob([text], { type: 'application/json' });
  if (blob.size > PAINT_LIMITS.maxEncodedProjectBytes) throw new Error('The project exceeds the 64 MiB file limit.');
  const suggestedName = filename(name, PROJECT.extension);
  const result = window.paintDesktop ? await window.paintDesktop.saveProject({ text, suggestedName, ...(target !== undefined ? { target } : {}) }) : download(blob, suggestedName);
  return result ? { ...result, encodedBytes: blob.size } : null;
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

// Both adapters use the browser's existing width-fit, height-auto pagination.
// Reset screen-only root geometry and theme at the print document boundary.
const PRINT_PAGE_STYLE = '@page{margin:12mm}html,body{margin:0!important;width:auto!important;height:auto!important;overflow:visible!important;background:#fff!important;color-scheme:light!important}img{display:block;max-width:100%;height:auto}';
let printActive = false;

export async function printCanvas(canvas) {
  dimensions(canvas.width, canvas.height);
  if (printActive) throw new Error('Finish the current print operation first.');
  printActive = true;
  const desktop = window.paintDesktop;
  let page, printable, style;
  try {
    // Desktop new windows are denied, so its owned subtree is visible only in
    // print media. Browser printing owns a separate page with the same policy.
    if (!desktop) {
      page = window.open('', '_blank');
      if (!page) throw new Error('Allow a popup to print your drawing.');
      page.opener = null;
      page.document.title = 'Print drawing';
    }
    const owner = desktop ? document : page.document;
    style = owner.createElement('style');
    style.textContent = desktop ? '#paint-print-document{display:none}@media print{' + PRINT_PAGE_STYLE +
      'body>*:not(#paint-print-document){display:none!important}#paint-print-document{display:block!important}}' : PRINT_PAGE_STYLE;
    owner.head.append(style);
    const image = owner.createElement('img');
    image.alt = 'Drawing';
    image.src = canvas.toDataURL('image/png');
    if (desktop) {
      printable = owner.createElement('div');
      printable.id = 'paint-print-document';
      printable.append(image); owner.body.append(printable);
    } else owner.body.append(image);
    await image.decode();
    if (desktop) return await desktop.print();
    page.addEventListener('afterprint', () => page.close(), { once: true });
    page.print();
    return true;
  } catch (error) {
    page?.close();
    throw error;
  } finally {
    if (desktop) { printable?.remove(); style?.remove(); }
    printActive = false;
  }
}
