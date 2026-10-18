import { DEFAULT_DOCUMENT_SIZE, PAINT_LIMITS, defaultDimensionsForDisplay } from './engine.js';
import './image-properties.css';

export function fileSizeLabel(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return 'Not Available';
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  const index = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1024)) - 1, units.length - 1));
  return `${(bytes / 1024 ** (index + 1)).toLocaleString(undefined, { maximumFractionDigits: 1 })}${units[index]}`;
}

export async function imageProperties({ doc, fileInfo, dialog, getDisplayMetrics, units = 'pixels', onUnitsChange = () => {} }) {
  const target = doc.captureEditTarget(), { xDpi } = doc.resolution;
  const known = xDpi !== null;
  const resolution = known ? `${xDpi.toLocaleString(undefined, { maximumFractionDigits: 0 })} DPI` : 'Unknown';
  const pending = dialog('Image properties', `<dl class="image-information"><dt>Resolution:</dt><dd>${resolution}</dd><dt>Size on disk:</dt><dd>${fileSizeLabel(fileInfo?.encodedBytes)}</dd></dl><fieldset class="property-units"><legend>Units</legend><label><input type="radio" name="units" value="inches" ${known ? '' : 'disabled'}>Inches</label><label><input type="radio" name="units" value="centimeters" ${known ? '' : 'disabled'}>Centimeters</label><label><input type="radio" name="units" value="pixels" checked>Pixels</label></fieldset><div class="two-columns image-properties"><label>Width<input name="width" type="number" min="1" max="${PAINT_LIMITS.maxDimension}" step="any" value="${doc.width}" required></label><label>Height<input name="height" type="number" min="1" max="${PAINT_LIMITS.maxDimension}" step="any" value="${doc.height}" required></label></div><button type="button" id="properties-default">Default</button><p class="hint" role="status">${known ? 'Changes canvas dimensions without scaling the image.' : 'Physical units require known image resolution. Changes resize the canvas without scaling the image.'}</p>`);
  const form = document.querySelector('#dialog form'), width = form.elements.namedItem('width'), height = form.elements.namedItem('height');
  let unit = known && ['inches', 'centimeters'].includes(units) ? units : 'pixels', pixels = { width: doc.width, height: doc.height };
  let closed = false, querying = false, formRevision = 0;
  // Paint's Properties fields use horizontal density for both dimensions. Keep
  // this presentation choice separate from the document's two stored axes.
  const factor = () => unit === 'pixels' ? 1 : xDpi / (unit === 'centimeters' ? 2.54 : 1);
  const display = () => {
    for (const [axis, input] of [['width', width], ['height', height]]) {
      const scale = factor(), minimum = 1 / scale, maximum = PAINT_LIMITS.maxDimension / scale;
      input.min = String(minimum); input.max = String(maximum);
      const value = pixels[axis] / scale;
      // Retained native fields round to two decimals, with a third trailing
      // place for inches. This is presentation only: unit switches and an
      // untouched OK keep the canonical pixels and original density.
      const formatted = unit === 'pixels' ? String(value) : Number(value.toFixed(2)).toFixed(unit === 'inches' ? 3 : 2);
      // At a physical range boundary, keep enough digits for native number
      // validation. Do not loosen the range to accommodate a rounded label.
      input.value = Number(formatted) < minimum || Number(formatted) > maximum ? String(value) : formatted;
    }
  };
  form.querySelector(`[name="units"][value="${unit}"]`).checked = true;
  display();
  width.oninput = () => { formRevision++; pixels.width = Number(width.value) * factor(); };
  height.oninput = () => { formRevision++; pixels.height = Number(height.value) * factor(); };
  for (const radio of form.querySelectorAll('[name="units"]')) radio.onchange = () => { formRevision++; unit = radio.value; display(); };
  const defaultButton = form.querySelector('#properties-default'), submit = form.querySelector('button[type="submit"]'), status = form.querySelector('[role="status"]');
  const guardSubmit = event => { if (querying) { event.preventDefault(); event.stopImmediatePropagation(); } };
  form.addEventListener('submit', guardSubmit, true);
  defaultButton.onclick = async () => {
    if (querying || closed) return;
    const revision = formRevision;
    querying = true; defaultButton.disabled = true; submit.disabled = true;
    status.textContent = 'Reading primary display dimensions…';
    try {
      // Browser development has no desktop display adapter. Its existing
      // default remains explicit; a desktop query failure never uses it.
      const next = getDisplayMetrics ? defaultDimensionsForDisplay(await getDisplayMetrics()) : { ...DEFAULT_DOCUMENT_SIZE };
      if (closed || !form.isConnected) return;
      if (!doc.matchesEditTarget(target)) { status.textContent = 'The drawing changed. Reopen Image properties to use Default.'; return; }
      if (revision !== formRevision) { status.textContent = 'Dimensions were edited while reading the display. Your entries were kept.'; return; }
      pixels = next; display(); status.textContent = 'Dimensions set to default values.';
    } catch (error) {
      if (!closed && form.isConnected) status.textContent = error.message || 'The primary display dimensions could not be read. Your entries were kept.';
    } finally {
      querying = false;
      if (!closed && form.isConnected) { defaultButton.disabled = false; submit.disabled = false; }
    }
  };
  const answer = await pending.finally(() => { closed = true; form.removeEventListener('submit', guardSubmit, true); });
  if (!answer) return false;
  if (!doc.matchesEditTarget(target)) throw new Error('The drawing changed while Image properties was open.');
  doc.resize(Math.round(pixels.width), Math.round(pixels.height), { scale: false, target: 'document' });
  onUnitsChange(unit);
  return true;
}
