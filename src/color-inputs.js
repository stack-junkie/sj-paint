// One dialog-local color owns every representation. Incomplete text remains
// editable and invalid until corrected; it never replaces the last valid color.
export function bindColorInputs(root) {
  const spectrum = root.querySelector('[name="color"]');
  const hex = root.querySelector('#hex');
  const channels = ['red', 'green', 'blue'].map(name => root.querySelector(`[name="${name}"]`));
  const hsvInputs = ['hue', 'saturation', 'value'].map(name => root.querySelector(`[name="${name}"]`));
  const model = root.querySelector('[name="color-model"]');
  let hsv = [0, 0, 0], shownHsv = [0, 0, 0];
  const synchronize = (color, source, fromHsv = false) => {
    spectrum.value = color.toLowerCase();
    if (source !== hex) hex.value = spectrum.value;
    const rgb = channels.map((_, index) => parseInt(color.slice(1 + index * 2, 3 + index * 2), 16));
    channels.forEach((input, index) => {
      if (source !== input) input.value = rgb[index];
    });
    if (!fromHsv) hsv = rgbToHsv(rgb, hsv);
    hsvInputs.forEach((input, index) => { if (source !== input) input.value = index === 0 ? Math.min(359, Math.round(hsv[0])) : Math.round(hsv[index] * 100); });
    shownHsv = hsvInputs.map(input => input.valueAsNumber);
  };
  synchronize(spectrum.value);
  model.addEventListener('change', () => {
    // Switching representation alone preserves exact RGB bytes. Discard
    // incomplete text in the old representation before disabling its fields.
    synchronize(spectrum.value, null, true);
    for (const group of root.querySelectorAll('[data-color-model]')) {
      group.hidden = group.disabled = group.dataset.colorModel !== model.value;
    }
  });
  root.addEventListener('input', event => {
    const source = event.target;
    if (source === spectrum) synchronize(spectrum.value, source);
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
  const chroma = value * saturation, sector = hue / 60, second = chroma * (1 - Math.abs(sector % 2 - 1));
  const components = sector < 1 ? [chroma, second, 0] : sector < 2 ? [second, chroma, 0] : sector < 3 ? [0, chroma, second]
    : sector < 4 ? [0, second, chroma] : sector < 5 ? [second, 0, chroma] : [chroma, 0, second];
  return '#' + components.map(component => Math.round((component + value - chroma) * 255).toString(16).padStart(2, '0')).join('');
}
