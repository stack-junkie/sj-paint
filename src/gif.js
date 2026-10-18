// Independent GIF89a encoder: adaptive palette, one frame, binary transparency.
// https://www.w3.org/Graphics/GIF/spec-gif89a.txt (color tables and Appendix F).
// Palette work is bounded to 32768 histogram bins and 256 colors; LZW retains
// at most 4096 entries. Hidden RGB never participates in palette construction.
const rgbKey = (pixels, offset) => pixels[offset] * 65536 + pixels[offset + 1] * 256 + pixels[offset + 2];
const binKey = (pixels, offset) => (pixels[offset] >> 3) * 1024 + (pixels[offset + 1] >> 3) * 32 + (pixels[offset + 2] >> 3);

function paletteFor(pixels, width) {
  const count = new Uint32Array(32768), sums = [new Float64Array(32768), new Float64Array(32768), new Float64Array(32768)];
  let exact = new Map(), transparent = false;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] < 128) { transparent = true; continue; }
    if (exact) { exact.set(rgbKey(pixels, offset), 0); if (exact.size > 256) exact = null; }
    const bin = binKey(pixels, offset); count[bin]++;
    for (let channel = 0; channel < 3; channel++) sums[channel][bin] += pixels[offset + channel];
  }
  const maximum = transparent ? 255 : 256;
  let colors, lookup;
  if (exact && exact.size <= maximum) {
    colors = [...exact.keys()].sort((a, b) => a - b).map((key, index) => {
      exact.set(key, index); return [key >> 16, key >> 8 & 255, key & 255];
    });
    lookup = offset => exact.get(rgbKey(pixels, offset));
  } else {
    const bins = [];
    for (let id = 0; id < count.length; id++) if (count[id]) bins.push({ id, count: count[id], rgb: sums.map(sum => sum[id] / count[id]) });
    const box = entries => {
      const weight = entries.reduce((sum, bin) => sum + bin.count, 0), average = [0, 0, 0], variance = [0, 0, 0];
      for (const bin of entries) for (let c = 0; c < 3; c++) average[c] += bin.rgb[c] * bin.count / weight;
      for (const bin of entries) for (let c = 0; c < 3; c++) variance[c] += (bin.rgb[c] - average[c]) ** 2 * bin.count;
      return { entries, weight, average, variance, error: variance.reduce((a, b) => a + b, 0) };
    };
    const boxes = [box(bins)];
    while (boxes.length < maximum) {
      let selected = -1;
      for (let i = 0; i < boxes.length; i++) if (boxes[i].entries.length > 1 &&
        (selected < 0 || boxes[i].error > boxes[selected].error)) selected = i;
      if (selected < 0) break;
      const current = boxes[selected], axis = current.variance.indexOf(Math.max(...current.variance));
      current.entries.sort((a, b) => a.rgb[axis] - b.rgb[axis] || a.id - b.id);
      let split = 0, weight = 0;
      while (split < current.entries.length - 1 && weight < current.weight / 2) weight += current.entries[split++].count;
      boxes.splice(selected, 1, box(current.entries.slice(0, split)), box(current.entries.slice(split)));
    }
    colors = boxes.map(item => item.average.map(Math.round));
    // Floyd-Steinberg diffusion smooths gradients without changing an exact
    // source palette. Two error rows and a 32768-bin lookup bound working memory.
    // Cache by the adjusted color bin, including bins absent from the source.
    const indices = new Int16Array(count.length).fill(-1), paletteSize = colors.length;
    let row = new Float32Array((width + 2) * 3), next = new Float32Array(row.length);
    lookup = offset => {
      const x = offset / 4 % width, slot = (x + 1) * 3;
      if (x === 0) { [row, next] = [next, row]; next.fill(0); }
      if (pixels[offset + 3] < 128) return -1;
      const red = Math.max(0, Math.min(255, pixels[offset] + row[slot]));
      const green = Math.max(0, Math.min(255, pixels[offset + 1] + row[slot + 1]));
      const blue = Math.max(0, Math.min(255, pixels[offset + 2] + row[slot + 2]));
      const bin = (red >> 3) * 1024 + (green >> 3) * 32 + (blue >> 3);
      if (indices[bin] < 0) {
        const r = (bin >> 10) * 8 + 3.5, g = (bin >> 5 & 31) * 8 + 3.5, b = (bin & 31) * 8 + 3.5;
        let best = Infinity;
        for (let index = 0; index < paletteSize; index++) {
          const color = colors[index], error = (r - color[0]) ** 2 + (g - color[1]) ** 2 + (b - color[2]) ** 2;
          if (error < best) { best = error; indices[bin] = index; }
        }
      }
      const selected = indices[bin];
      // Transparent pixels neither receive nor relay error, including hidden RGB.
      const below = offset + width * 4;
      const right = x + 1 < width && pixels[offset + 7] >= 128;
      const down = below < pixels.length && pixels[below + 3] >= 128;
      const downLeft = x > 0 && below < pixels.length && pixels[below - 1] >= 128;
      const downRight = x + 1 < width && below < pixels.length && pixels[below + 7] >= 128;
      for (let channel = 0; channel < 3; channel++) {
        const error = (channel === 0 ? red : channel === 1 ? green : blue) - colors[selected][channel];
        if (right) row[slot + 3 + channel] += error * 7 / 16;
        if (downLeft) next[slot - 3 + channel] += error * 3 / 16;
        if (down) next[slot + channel] += error * 5 / 16;
        if (downRight) next[slot + 3 + channel] += error / 16;
      }
      return selected;
    };
  }
  const transparentIndex = transparent ? colors.length : -1;
  if (transparent) colors.push([0, 0, 0]);
  // Call lookup even on transparency so the streaming quantizer advances rows.
  return { colors, transparentIndex, index: offset => { const selected = lookup(offset); return pixels[offset + 3] < 128 ? transparentIndex : selected; } };
}

export function writeGif({ width, height, rgba }, maximumBytes) {
  const { colors, transparentIndex, index } = paletteFor(rgba, width);
  const colorBits = Math.max(1, Math.ceil(Math.log2(colors.length))), minimumCodeSize = Math.max(2, colorBits);
  const parts = []; let chunk = new Uint8Array(16384), position = 0, length = 0;
  const byte = value => {
    if (++length > maximumBytes) throw new Error('The GIF exceeds the 64 MiB file limit.');
    if (position === chunk.length) { parts.push(chunk); chunk = new Uint8Array(16384); position = 0; }
    chunk[position++] = value;
  };
  const word = value => { byte(value & 255); byte(value >> 8); };
  for (const value of 'GIF89a') byte(value.charCodeAt(0));
  word(width); word(height); byte(0xf0 | colorBits - 1); byte(0); byte(0);
  for (let color = 0; color < 1 << colorBits; color++) for (const value of colors[color] || [0, 0, 0]) byte(value);
  if (transparentIndex >= 0) for (const value of [0x21, 0xf9, 4, 1, 0, 0, transparentIndex, 0]) byte(value);
  byte(0x2c); word(0); word(0); word(width); word(height); byte(0); byte(minimumCodeSize);
  const block = new Uint8Array(255); let blockLength = 0, bits = 0, accumulator = 0, dataCodes = 0;
  const flush = () => { if (blockLength) { byte(blockLength); for (let i = 0; i < blockLength; i++) byte(block[i]); blockLength = 0; } };
  const dataByte = value => { block[blockLength++] = value; if (blockLength === 255) flush(); };
  const clear = 1 << minimumCodeSize, end = clear + 1;
  const code = value => {
    // The decoder adds an entry after each data code except its first. This
    // clock also handles a width transition immediately before the final EOI.
    const width = Math.min(12, Math.max(minimumCodeSize + 1, Math.floor(Math.log2(clear + dataCodes + 1)) + 1));
    accumulator |= value << bits; bits += width;
    while (bits >= 8) { dataByte(accumulator & 255); accumulator >>>= 8; bits -= 8; }
    if (value === clear) dataCodes = 0; else if (value !== end) dataCodes++;
  };
  const dictionary = new Map(); let next = end + 1, prefix = index(0);
  code(clear);
  for (let offset = 4; offset < rgba.length; offset += 4) {
    const value = index(offset), key = prefix * 256 + value, found = dictionary.get(key);
    if (found !== undefined) { prefix = found; continue; }
    code(prefix);
    if (next === 4096) { code(clear); dictionary.clear(); next = end + 1; }
    else dictionary.set(key, next++);
    prefix = value;
  }
  code(prefix); code(end);
  if (bits) dataByte(accumulator & 255);
  flush(); byte(0); byte(0x3b); parts.push(chunk.subarray(0, position));
  return new Blob(parts, { type: 'image/gif' });
}
