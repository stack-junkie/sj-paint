import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// These original fixtures and expected pixels come from Pillow, independently
// of the application codec. Keep their generation recipe and provenance in-tree.
export async function singleChannelTiffFixtures() {
  const document = JSON.parse(await readFile(new URL('./fixtures/tiff-single-channel.json', import.meta.url), 'utf8'));
  return document.fixtures.map(({ encodedBase64, rgbaBase64, ...fixture }) => {
    const bytes = Buffer.from(encodedBase64, 'base64'), rgba = Buffer.from(rgbaBase64, 'base64');
    if (digest(bytes) !== fixture.encodedSha256 || digest(rgba) !== fixture.rgbaSha256 || rgba.length !== fixture.width * fixture.height * 4) {
      throw new Error(`Independent TIFF fixture changed: ${fixture.name}`);
    }
    return { ...fixture, bytes, rgba };
  });
}

export async function malformedSingleChannelTiffFixtures() {
  const fixtures = await singleChannelTiffFixtures();
  const change = (name, tag, relative, value) => {
    const bytes = Buffer.from(fixtures.find(fixture => fixture.name === name).bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), little = bytes[0] === 73;
    const ifd = view.getUint32(4, little);
    for (let index = 0; index < view.getUint16(ifd, little); index++) {
      const entry = ifd + 2 + index * 12;
      if (view.getUint16(entry, little) !== tag) continue;
      view.setUint32(entry + relative, value === 'past-end' ? bytes.length - 1 : value, little);
      return bytes;
    }
    throw new Error(`Missing fixture tag ${tag}`);
  };
  return [
    { name: 'palette-short-colormap.tiff', bytes: change('palette-raw', 320, 4, 767) },
    { name: 'palette-truncated-colormap.tiff', bytes: change('palette-raw', 320, 8, 'past-end') },
    { name: 'gray-unsupported-depth.tiff', bytes: change('gray-black-packbits', 258, 8, 16) },
  ];
}
