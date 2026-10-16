// One dialog-local color owns every representation. Incomplete text remains
// editable and invalid until corrected; it never replaces the last valid color.
let fullValueSpectrum;
function spectrumBitmap() {
  // Hue/saturation bounds and 256-pixel geometry are fixed. This theme-neutral
  // image belongs to the renderer lifetime, not an individual dialog.
  if (fullValueSpectrum) return fullValueSpectrum;
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
  const context = canvas.getContext('2d'), bitmap = context.createImageData(256, 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const offset = (y * 256 + x) * 4, rgb = hsvToRgb([x / 255 * 359, 1 - y / 255, 1]);
    bitmap.data[offset] = rgb[0]; bitmap.data[offset + 1] = rgb[1]; bitmap.data[offset + 2] = rgb[2]; bitmap.data[offset + 3] = 255;
  }
  context.putImageData(bitmap, 0, 0); fullValueSpectrum = canvas;
  return canvas;
}
export function colorDialogMarkup(color) {
  return `<div class="color-picker"><div class="color-picker-top"><div><canvas class="color-spectrum" width="256" height="256" role="group" tabindex="0" aria-label="Color spectrum" aria-describedby="color-spectrum-help"></canvas><label>Value<input name="color-value" type="range" min="0" max="100" step="1" aria-label="Color value"></label><p id="color-spectrum-help" class="hint">Arrow keys adjust hue and saturation. HSV fields also provide keyboard entry.</p></div><div><div class="color-preview" role="img" aria-label="Color preview"></div><input type="hidden" name="color" value="${color}"><label>Hex<input id="hex" value="${color}" pattern="#[0-9a-fA-F]{6}" maxlength="7" required spellcheck="false"></label><label>Color model<select name="color-model"><option value="rgb">RGB</option><option value="hsv">HSV</option></select></label><fieldset class="color-channels" data-color-model="rgb"><legend>RGB channels</legend>${['Red','Green','Blue'].map(name=>`<label>${name}<input type="number" name="${name.toLowerCase()}" min="0" max="255" step="1" required></label>`).join('')}</fieldset><fieldset class="color-channels" data-color-model="hsv" hidden disabled><legend>HSV channels</legend>${[['Hue',359],['Saturation',100],['Value',100]].map(([name,max])=>`<label>${name}<input type="number" name="${name.toLowerCase()}" min="0" max="${max}" step="1" required></label>`).join('')}</fieldset><p class="hint">RGB: 0 to 255. Hue: 0 to 359 degrees. Saturation and value: 0 to 100 percent.</p></div></div><div class="color-palette-groups"><section role="group" aria-label="Basic colors"><h3>Basic colors</h3><div class="dialog-basic-colors"></div></section><section role="group" aria-label="Custom colors"><div class="color-palette-heading"><h3>Custom colors</h3><button type="button" class="add-custom-color" aria-label="Add color" title="Add color">+</button></div><div class="dialog-custom-colors"></div></section></div></div>`;
}

export function bindColorInputs(root, { basicColors = [], customColors = [] } = {}) {
  const canonical = root.querySelector('[name="color"]');
  const hex = root.querySelector('#hex');
  const channels = ['red', 'green', 'blue'].map(name => root.querySelector(`[name="${name}"]`));
  const hsvInputs = ['hue', 'saturation', 'value'].map(name => root.querySelector(`[name="${name}"]`));
  const model = root.querySelector('[name="color-model"]');
  const surface = root.querySelector('.color-spectrum'), slider = root.querySelector('[name="color-value"]');
  const preview = root.querySelector('.color-preview'), context = surface.getContext('2d');
  const base = spectrumBitmap();
  const abort = new AbortController(), listen = (node, name, handler) => node.addEventListener(name, handler, { signal: abort.signal });
  let draftColors = [...customColors], gesture = null;
  let hsv = [0, 0, 0], shownHsv = [0, 0, 0];
  const draw = () => {
    context.drawImage(base, 0, 0);
    const x = hsv[0] / 359 * 255, y = (1 - hsv[1]) * 255;
    context.beginPath(); context.arc(x, y, 5, 0, Math.PI * 2); context.lineWidth = 3; context.strokeStyle = '#fff'; context.stroke();
    context.lineWidth = 1; context.strokeStyle = '#000'; context.stroke();
    surface.setAttribute('aria-description', `Hue ${Math.round(hsv[0])} degrees, saturation ${Math.round(hsv[1] * 100)} percent.`);
    slider.value = Math.round(hsv[2] * 100);
    preview.style.background = canonical.value; preview.setAttribute('aria-label', `Color preview ${canonical.value}`);
  };
  const synchronize = (color, source, fromHsv = false) => {
    canonical.value = color.toLowerCase();
    if (source !== hex) hex.value = canonical.value;
    const rgb = channels.map((_, index) => parseInt(color.slice(1 + index * 2, 3 + index * 2), 16));
    channels.forEach((input, index) => {
      if (source !== input) input.value = rgb[index];
    });
    if (!fromHsv) hsv = rgbToHsv(rgb, hsv);
    hsvInputs.forEach((input, index) => { if (source !== input) input.value = index === 0 ? Math.min(359, Math.round(hsv[0])) : Math.round(hsv[index] * 100); });
    shownHsv = hsvInputs.map(input => input.valueAsNumber);
    draw();
  };
  synchronize(canonical.value);
  listen(model, 'change', () => {
    // Switching representation alone preserves exact RGB bytes. Discard
    // incomplete text in the old representation before disabling its fields.
    synchronize(canonical.value, null, true);
    for (const group of root.querySelectorAll('[data-color-model]')) {
      group.hidden = group.disabled = group.dataset.colorModel !== model.value;
    }
  });
  listen(root, 'input', event => {
    const source = event.target;
    if (source === slider) { hsv[2] = slider.valueAsNumber / 100; synchronize(hsvToHex(hsv), null, true); }
    else if (source === canonical) synchronize(canonical.value, source);
    else if (source === hex && hex.validity.valid) synchronize(hex.value, source);
    else if (channels.includes(source) && channels.every(input => input.validity.valid)) {
      synchronize('#' + channels.map(input => input.valueAsNumber.toString(16).padStart(2, '0')).join(''), source);
    } else if (hsvInputs.includes(source) && hsvInputs.every(input => input.validity.valid)) {
      // Display rounding must not become a new edit to untouched channels.
      // Also include valid edits held back while another channel was invalid.
      hsv = hsvInputs.map((input, index) => input.valueAsNumber === shownHsv[index] ? hsv[index] : input.valueAsNumber / (index === 0 ? 1 : 100));
      synchronize(hsvToHex(hsv), source, true);
    }
  });
  const updatePoint = event => {
    const rect = surface.getBoundingClientRect();
    hsv[0] = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * 359;
    hsv[1] = 1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    synchronize(hsvToHex(hsv), null, true);
  };
  const finish = cancel => {
    if (!gesture) return;
    const owned = gesture; gesture = null;
    if (cancel) { hsv = owned.hsv; synchronize(owned.color, null, true); }
    if (surface.hasPointerCapture(owned.id)) surface.releasePointerCapture(owned.id);
  };
  listen(surface, 'pointerdown', event => {
    if (gesture || event.button !== 0) return;
    event.preventDefault(); surface.focus({ preventScroll: true });
    gesture = { id: event.pointerId, hsv: [...hsv], color: canonical.value };
    surface.setPointerCapture(event.pointerId); updatePoint(event);
  });
  listen(surface, 'pointermove', event => { if (gesture?.id === event.pointerId) updatePoint(event); });
  listen(surface, 'pointerup', event => { if (gesture?.id === event.pointerId) { updatePoint(event); finish(false); } });
  for (const event of ['pointercancel', 'lostpointercapture']) listen(surface, event, e => { if (gesture?.id === e.pointerId) finish(true); });
  listen(surface, 'contextmenu', event => event.preventDefault());
  listen(window, 'blur', () => finish(true));
  listen(surface, 'keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
    event.preventDefault(); finish(false);
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') hsv[0] = Math.max(0, Math.min(359, hsv[0] + (event.key === 'ArrowRight' ? 1 : -1)));
    else hsv[1] = Math.max(0, Math.min(1, hsv[1] + (event.key === 'ArrowUp' ? .01 : -.01)));
    synchronize(hsvToHex(hsv), null, true);
  });
  const swatch = () => { const button = document.createElement('button'); button.type = 'button'; return button; };
  const setSwatch = (button, color, index) => {
    button.style.background = color || 'transparent'; button.disabled = !color;
    button.setAttribute('aria-label', color || `Empty custom color ${index + 1}`); button.title = color || 'Empty custom color';
    if (color) button.dataset.dialogColor = color; else delete button.dataset.dialogColor;
  };
  const basic = root.querySelector('.dialog-basic-colors');
  basic.replaceChildren(...basicColors.map((color, index) => { const button = swatch(); setSwatch(button, color, index); return button; }));
  const custom = root.querySelector('.dialog-custom-colors'), slots = Array.from({ length: 10 }, swatch);
  custom.replaceChildren(...slots);
  const refreshCustom = () => slots.forEach((button, index) => setSwatch(button, draftColors[index], index));
  refreshCustom();
  listen(root, 'click', event => {
    const button = event.target.closest('[data-dialog-color]');
    if (button) synchronize(button.dataset.dialogColor);
  });
  listen(root.querySelector('.add-custom-color'), 'click', () => {
    if (!root.reportValidity()) return;
    draftColors = [canonical.value, ...draftColors.filter(color => color !== canonical.value)].slice(0, 10); refreshCustom();
  });
  return { get customColors() { return [...draftColors]; }, dispose() { finish(true); abort.abort(); } };
}

function rgbToHsv(bytes, previous) {
  const [r, g, b] = bytes.map(value => value / 255), high = Math.max(r, g, b), low = Math.min(r, g, b), delta = high - low;
  // Hue has no RGB representation in gray; saturation also disappears at
  // black. Keep those editing choices until a chromatic color replaces them.
  let hue = previous[0];
  if (delta) hue = ((high === r ? (g - b) / delta : high === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60 + 360) % 360;
  return [hue, high ? delta / high : previous[1], high];
}

function hsvToHex([hue, saturation, value]) {
  return '#' + hsvToRgb([hue, saturation, value]).map(component => component.toString(16).padStart(2, '0')).join('');
}

function hsvToRgb([hue, saturation, value]) {
  const chroma = value * saturation, sector = hue / 60, second = chroma * (1 - Math.abs(sector % 2 - 1));
  const components = sector < 1 ? [chroma, second, 0] : sector < 2 ? [second, chroma, 0] : sector < 3 ? [0, chroma, second]
    : sector < 4 ? [0, second, chroma] : sector < 5 ? [second, 0, chroma] : [chroma, 0, second];
  return components.map(component => Math.round((component + value - chroma) * 255));
}
