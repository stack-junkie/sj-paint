import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Private reference files are read in place, never copied into the repository.
const defaultDirectory = fileURLToPath(new URL('../output/', import.meta.url));
export const NATIVE_FIXTURES = Object.freeze({
  'reference-native-colors.tif': 'e9dea64dc8bc57c6d134256a3b63cb7f1bb97133be874d3c7b10f6a8008999d5',
  'reference-native-alpha.tif': 'cdaddd4653fe257673a040780b40232945724326cb09546d953ea1426cb4ed45',
  'reference-alpha-export.png': 'd1dff4385862ca4efcc3dc7b179cf70b1afd1b0b7e1f41fd67536547736e2ef1',
  'reference-eraser-tolerance-fine-result.paint': 'd6c819ba961492bb223e34ed11b8ac2d07d2a78b91d61b6d59aa879917190318',
  'reference-native-single-layer.paint': '011068fb966e10b80a30b822bcaddf9966c82360143bdb215417d86806168e4e',
  'reference-native-two-layers.paint': 'ca6f3de4933a8f27c63001e33af5ba8648e279bf402f290e26e3d0fca67bb666',
});

export async function readNativeFixture(name, { directory = process.env.SJ_PAINT_NATIVE_FIXTURE_DIR } = {}) {
  if (!Object.hasOwn(NATIVE_FIXTURES, name)) throw new Error(`Unknown native fixture: ${name}`);
  if (directory !== undefined && (!directory || !path.isAbsolute(directory))) {
    throw new Error('SJ_PAINT_NATIVE_FIXTURE_DIR must be an absolute directory.');
  }
  const filename = path.join(directory ?? defaultDirectory, name);
  let bytes;
  try { bytes = await readFile(filename); }
  catch (error) {
    if (error.code === 'ENOENT' && directory === undefined) return null;
    throw new Error(`Cannot read requested native fixture: ${filename}`, { cause: error });
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== NATIVE_FIXTURES[name]) throw new Error(`Native fixture provenance changed: ${filename}`);
  return bytes;
}
