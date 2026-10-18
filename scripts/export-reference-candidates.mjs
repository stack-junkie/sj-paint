import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { readFile, writeFile, readdir, realpath, lstat, mkdir } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/version.js';
import { readTiff } from '../src/tiff.js';
import { readPaint } from '../src/paint-format.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const execute = promisify(execFile);
if (process.argv.length !== 3 || !path.isAbsolute(process.argv[2])) {
  throw new Error('Usage: node scripts/export-reference-candidates.mjs ABSOLUTE_CAPTURE_KIT_DIRECTORY');
}
const kit = await realpath(process.argv[2]);
const fixtureManifestBytes = await readFile(path.join(kit, 'fixture-manifest.json'));
const fixtureManifest = JSON.parse(fixtureManifestBytes);
const output = path.join(kit, 'candidates');
try { if ((await lstat(output)).isSymbolicLink()) throw new Error('Refusing a linked candidate output directory.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const inside = filename => {
  const relative = path.relative(kit, filename);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('Fixture must remain inside the explicitly selected capture kit.');
  }
  return filename;
};
async function inputFixture(name) {
  const relative = `fixtures/${name}`;
  const record = fixtureManifest.fixtures?.find(fixture => fixture.path === relative);
  if (!record) throw new Error(`Capture kit does not declare ${relative}`);
  const filename = inside(await realpath(path.join(kit, relative))), bytes = await readFile(filename);
  if (sha256(bytes) !== record.sha256) throw new Error(`Capture fixture digest changed: ${relative}`);
  return { name, bytes, record };
}
async function sourceIdentity() {
  const files = ['index.html', 'package.json', 'package-lock.json', 'scripts/export-reference-candidates.mjs'];
  for (const entry of await readdir(path.join(root, 'src'), { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files.push(path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/'));
  }
  const hashes = [];
  for (const filename of files.sort()) hashes.push({ path: filename, sha256: sha256(await readFile(path.join(root, filename))) });
  const options = { cwd: root, windowsHide: true };
  const commit = (await execute('git', ['rev-parse', 'HEAD'], options)).stdout.trim();
  const status = (await execute('git', ['status', '--porcelain=v1', '--untracked-files=no'], options)).stdout.trim();
  return { version: VERSION, checkoutCommit: commit, trackedWorkingTreeDirty: Boolean(status),
    trackedWorkingTreeStatus: status ? status.split(/\r?\n/) : [], runtimeSourceFiles: hashes,
    runtimeSourceSha256: sha256(JSON.stringify(hashes)),
    boundary: 'checkoutCommit identifies the base commit. Runtime file digests identify the actual exported working-tree source, including uncommitted runtime files.' };
}
async function refuseDifferent(filename, bytes) {
  try {
    if (!(await readFile(filename)).equals(bytes)) throw new Error(`Refusing to overwrite different candidate evidence: ${filename}`);
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function writeOriginal(filename, bytes) {
  if (await refuseDifferent(filename, bytes)) return;
  try { await writeFile(filename, bytes, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; await refuseDifferent(filename, bytes); }
}
const opaque = await inputFixture('properties-96dpi.png'), alpha = await inputFixture('selection-alpha.png');
const extended = fixtureManifest.fixtures.some(fixture => fixture.path === 'fixtures/gif-gradient.png');
const additional = extended ? [
  [`sj-${VERSION}-gradient.gif`, 'gif', await inputFixture('gif-gradient.png'), false],
  [`sj-${VERSION}-transparency.gif`, 'gif', await inputFixture('gif-transparency.png'), false],
  [`sj-${VERSION}-animation-open.png`, 'png', await inputFixture('two-frames.gif'), false],
] : [];
const decoderPath = path.join(kit, 'inspect-candidate.py');
const independentDecoder = extended ? { path: 'inspect-candidate.py', sha256: sha256(await readFile(decoderPath)) } : null;
async function independentlyDecode(bytes, fixture) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PAINT_PYTHON_PATH || 'python', [decoderPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = []; let length = 0;
    const timer = setTimeout(() => child.kill(), 15000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', chunk => { length += chunk.length; if (length > 1048576) child.kill(); else stdout.push(chunk); });
    child.stderr.on('data', chunk => { if (stderr.reduce((sum, item) => sum + item.length, 0) < 65536) stderr.push(chunk); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || length > 1048576) return reject(new Error(`Independent decoder failed (${code}): ${Buffer.concat(stderr)}`));
      try { resolve(JSON.parse(Buffer.concat(stdout))); } catch (error) { reject(error); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ output: bytes.toString('base64'), input: fixture.bytes.toString('base64') }));
  });
}
const source = await sourceIdentity(), candidates = [];
let server, browser;
try {
  server = await createServer({ root, server: { host: '127.0.0.1', port: 0,
    watch: { ignored: ['**/output/**', '**/release/**', '**/dist/**'] } } });
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.PAINT_CHROME_PATH ?
    { executablePath: process.env.PAINT_CHROME_PATH } : { channel: process.env.PAINT_CHROME_CHANNEL || 'chrome' }) });
  for (const [name, format, fixture, layered] of [
    [`sj-${VERSION}-opaque.tiff`, 'tiff', opaque, false],
    [`sj-${VERSION}-alpha.tiff`, 'tiff', alpha, false],
    [`sj-${VERSION}-two-layers.paint`, 'paint', alpha, true],
    ...additional,
  ]) {
    const context = await browser.newContext({ viewport: { width: 1364, height: 820 }, deviceScaleFactor: 1 });
    try {
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.setDefaultTimeout(15000);
      await page.goto(server.resolvedUrls.local[0]); await page.locator('#overlay').waitFor();
      const chooser = page.waitForEvent('filechooser');
      await page.locator('#overlay').focus(); await page.keyboard.press('Control+o');
      await (await chooser).setFiles({ name: fixture.name, mimeType: fixture.name.endsWith('.gif') ? 'image/gif' : 'image/png', buffer: fixture.bytes });
      await page.waitForFunction(stem => document.title.startsWith(stem + ' - '), fixture.name.replace(/\.[^.]+$/, ''));
      const actions = [`Open original ${fixture.record.path} through browser file chooser`];
      if (layered) {
        await page.locator('#zoom-presets').selectOption('1');
        await page.locator('.layers-group [data-action="layers"]').click();
        await page.locator('[data-action="add-layer"]').click();
        await page.locator('[data-tool="text"]').click();
        await page.locator('#font').selectOption('Arial');
        await page.locator('#font-size').fill('24'); await page.locator('#font-size').press('Tab');
        await page.locator('#text-background').uncheck();
        await page.locator('[data-color="#000000"]').click();
        const box = await page.locator('#overlay').boundingBox();
        await page.mouse.click(box.x + 20, box.y + 250);
        await page.locator('.text-editor').fill('SJ export candidate');
        await page.locator('[data-action="commit-text"]').click();
        actions.push('Add visible full-opacity layer; add black Arial 24 text at (20,250), transparent text background; Apply text');
      }
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const visible = await page.locator('#canvas').evaluate(async canvas => {
        const image = new Image(); image.src = canvas.toDataURL(); await image.decode();
        const independent = document.createElement('canvas'); independent.width = canvas.width; independent.height = canvas.height;
        const c = independent.getContext('2d', { willReadFrequently: true }); c.drawImage(image, 0, 0);
        const rgba = c.getImageData(0, 0, canvas.width, canvas.height).data;
        let transparent = 0, partial = 0, opaque = 0;
        for (let i = 3; i < rgba.length; i += 4) { if (rgba[i] === 0) transparent++; else if (rgba[i] === 255) opaque++; else partial++; }
        const digest = await crypto.subtle.digest('SHA-256', rgba);
        return { width: canvas.width, height: canvas.height, transparent, partial, opaque,
          rgbaSha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('') };
      });
      if (!layered && ((fixture === opaque && visible.transparent + visible.partial !== 0) ||
          (fixture === alpha && (visible.partial === 0 || visible.transparent === 0)))) {
        throw new Error(`Fixture did not produce its expected opaque/alpha surface: ${name}`);
      }
      await page.locator('#overlay').focus(); await page.keyboard.press('Control+Shift+s');
      await page.locator('#dialog [name="name"]').fill(name.replace(/\.[^.]+$/, ''));
      await page.locator('#dialog [name="format"]').selectOption(format);
      const pending = page.waitForEvent('download'); await page.locator('#dialog button[type="submit"]').click();
      const download = await pending, stream = await download.createReadStream(), chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      let selfCheck;
      if (format === 'tiff') {
        const decoded = await readTiff(bytes);
        if (decoded.width !== visible.width || decoded.height !== visible.height || sha256(decoded.rgba) !== visible.rgbaSha256) {
          throw new Error(`SJ TIFF round-trip differs from exported browser pixels: ${name}`);
        }
        selfCheck = { decoder: 'SJ TIFF decoder, not independent native acceptance', rgbaSha256: sha256(decoded.rgba) };
      } else if (format === 'paint') {
        const decoded = await readPaint(bytes);
        if (decoded.width !== visible.width || decoded.height !== visible.height || decoded.layers.length !== 2 ||
            !decoded.layers.every(layer => layer.visible && layer.opacity === 1)) throw new Error('Expected supported two-layer .paint output');
        selfCheck = { decoder: 'SJ .paint decoder, not independent native acceptance', layers: decoded.layers.map(layer =>
          ({ name: layer.name, visible: layer.visible, opacity: layer.opacity, rgbaSha256: sha256(layer.rgba) })) };
      } else {
        selfCheck = { boundary: 'Independent decoder below evaluates actual public Save As bytes; no SJ GIF decoder is used.' };
      }
      const independent = extended && format !== 'paint' ? await independentlyDecode(bytes, fixture) : null;
      if (independent && (independent.width !== visible.width || independent.height !== visible.height || independent.frames !== 1)) {
        throw new Error(`Independent output dimensions/frame count differ: ${name}`);
      }
      if (independent && format === 'tiff' && independent.rgbaSha256 !== visible.rgbaSha256) throw new Error(`Independent TIFF pixels differ: ${name}`);
      if (independent && fixture.name === 'two-frames.gif' && independent.rgbaSha256 !== independent.inputFirstFrameRgbaSha256) {
        throw new Error('Opened animated GIF does not match its first decoded frame; retain source evidence before changing animation scope.');
      }
      if (independent && format === 'gif' && independent.alphaThresholdMismatches !== 0) throw new Error(`GIF transparency boundary differs: ${name}`);
      if (errors.length) throw new Error(errors.join('\n'));
      actions.push(`Save As ${format} through public dialog; capture actual browser download bytes`);
      candidates.push({ bytes, record: { path: `candidates/${name}`, bytes: bytes.length, sha256: sha256(bytes),
        input: { path: fixture.record.path, sha256: fixture.record.sha256 }, actions, visible, selfCheck, independent } });
    } finally { await context.close(); }
  }
  const after = await sourceIdentity();
  if (JSON.stringify(source) !== JSON.stringify(after)) throw new Error('Source changed during candidate export; no candidates written. Freeze the runtime and retry.');
  const manifestPath = path.join(output, 'candidate-manifest.json');
  let generatedAt = new Date().toISOString();
  try { generatedAt = JSON.parse(await readFile(manifestPath, 'utf8')).generatedAt; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, generatedAt, source,
    browser: browser.version(), platform: process.platform, architecture: process.arch,
    inputManifestSha256: sha256(fixtureManifestBytes), referenceBuild: fixtureManifest.referenceBuild, independentDecoder,
    provenance: 'Original capture-kit inputs exported by SJ Paint through public browser controls. No private or Microsoft-generated fixtures used.',
    nativeAcceptance: 'Not performed. These are inputs prepared for later owner-authorized pinned-Paint reopening.',
    candidates: candidates.map(candidate => candidate.record) }, null, 2) + '\n');
  // Check the complete batch before writing anything; existing evidence is immutable.
  for (const candidate of candidates) await refuseDifferent(path.join(kit, candidate.record.path), candidate.bytes);
  await refuseDifferent(manifestPath, manifest);
  await mkdir(output, { recursive: true });
  for (const candidate of candidates) await writeOriginal(path.join(kit, candidate.record.path), candidate.bytes);
  await writeOriginal(manifestPath, manifest);
  console.log(JSON.stringify({ manifest: manifestPath, candidates: candidates.map(candidate => candidate.record.path), source: source.runtimeSourceSha256 }));
} finally { await browser?.close(); await server?.close(); }
