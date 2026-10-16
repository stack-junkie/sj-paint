const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createLocalAi, MODEL_SHA256 } = require('./local-ai.cjs');

const config = { pythonPath: process.execPath, modelPath: path.resolve('local-test-model.onnx') };
const metadata = { model: 'u2netp', modelSha256: MODEL_SHA256, provider: 'CPUExecutionProvider', runtimeVersion: '1.24.4' };
const header = (extra = {}) => Buffer.from(JSON.stringify({ version: 1, operation: 'probe', ok: true, metadata, ...extra }) + '\n');

function fakeWorker(t, onInput, options = {}) {
  let child, spawnArgs;
  const backend = createLocalAi({ ...config, ...options }, {
    readFile: async () => 'worker source',
    spawnProcess(...args) {
      spawnArgs = args;
      child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.exitCode = null; child.signalCode = null; child.kills = [];
      child.close = code => { child.exitCode = code; child.emit('close', code); };
      child.kill = signal => { child.kills.push(signal); setImmediate(() => child.close(null)); return true; };
      const inputs = [];
      child.stdin.on('data', chunk => inputs.push(chunk));
      child.stdin.on('finish', () => onInput(child, Buffer.concat(inputs)));
      return child;
    },
  });
  t.after(() => { if (child?.exitCode === null) child.close(0); });
  return { backend, get child() { return child; }, get spawnArgs() { return spawnArgs; } };
}

test('readiness uses hidden isolated Python with no shell or ambient environment persistence', async t => {
  const fixture = fakeWorker(t, child => { child.stdout.write(header()); child.close(0); });
  assert.deepEqual(await fixture.backend.probe(), metadata);
  const [, args, options] = fixture.spawnArgs;
  assert.deepEqual(args.slice(0, 4), ['-I', '-B', '-u', '-c']);
  assert.equal(args[5], 'probe');
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
  assert.ok(Object.keys(options.env).every(key => ['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].includes(key)));
});

test('PNG bounds and dimensions are rejected before a child can start', async () => {
  let spawned = false;
  const backend = createLocalAi(config, { spawnProcess: () => { spawned = true; } });
  await assert.rejects(backend.run({ png: Buffer.alloc(33), width: 1, height: 1 }), { code: 'INPUT' });
  await assert.rejects(backend.run({ png: Buffer.alloc(33), width: 16000001, height: 1 }), { code: 'INPUT' });
  assert.equal(spawned, false);
});

test('oversized stdout or stderr kills only the owned process before releasing BUSY', async t => {
  for (const channel of ['stdout', 'stderr']) {
    const fixture = fakeWorker(t, child => {
      child[channel].write(Buffer.alloc(channel === 'stdout' ? 4097 : 16385));
      assert.equal(child.kills.length, 1);
    });
    await assert.rejects(fixture.backend.probe(), { code: 'PROTOCOL' });
    assert.deepEqual(fixture.child.kills, ['SIGKILL']);
  }
});

test('malformed and foreign-model protocol responses cannot become a ready backend', async t => {
  for (const response of [Buffer.from('not json\n'), header({ metadata: { ...metadata, modelSha256: 'wrong' } }), Buffer.concat([header(), Buffer.from([1])])]) {
    const fixture = fakeWorker(t, child => { child.stdout.write(response); child.close(0); });
    await assert.rejects(fixture.backend.probe(), { code: 'PROTOCOL' });
  }
});

test('cancellation and timeout wait for owned child close, then permit reuse', async t => {
  for (const reason of ['ABORTED', 'TIMEOUT']) {
    let release;
    const fixture = fakeWorker(t, child => {
      child.kill = signal => { child.kills.push(signal); release = () => child.close(null); return true; };
    }, { timeoutMs: reason === 'TIMEOUT' ? 10 : 1000 });
    const controller = new AbortController();
    const pending = fixture.backend.probe({ signal: controller.signal });
    const check = assert.rejects(pending, { code: reason });
    await new Promise(resolve => setImmediate(resolve));
    if (reason === 'ABORTED') controller.abort();
    else await new Promise(resolve => setTimeout(resolve, 25));
    await assert.rejects(fixture.backend.probe(), { code: 'BUSY' });
    release(); await check;
    assert.deepEqual(fixture.child.kills, ['SIGKILL']);
    const again = fixture.backend.probe();
    await new Promise(resolve => setImmediate(resolve));
    fixture.child.stdout.write(header()); fixture.child.close(0);
    assert.deepEqual(await again, metadata);
  }
});

test('failed cleanup retains ownership and rejects new work', async t => {
  const fixture = fakeWorker(t, child => { child.kill = () => false; }, { timeoutMs: 10 });
  await assert.rejects(fixture.backend.probe(), { code: 'CLEANUP' });
  await assert.rejects(fixture.backend.probe(), { code: 'BUSY' });
  fixture.child.close(1);
});

test('already exited children with lingering streams have a bounded cleanup wait', { timeout: 4000 }, async t => {
  for (const exitedBy of ['exitCode', 'signalCode']) {
    const fixture = fakeWorker(t, child => { child[exitedBy] = exitedBy === 'exitCode' ? 0 : 'SIGTERM'; }, { timeoutMs: 10 });
    await assert.rejects(fixture.backend.probe(), { code: 'CLEANUP' });
    assert.deepEqual(fixture.child.kills, []);
    await assert.rejects(fixture.backend.probe(), { code: 'BUSY' });
    fixture.child.close(0);
  }
});

// Generate a real PNG without a browser, fixture download, or added dependency.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(width, height, transparent = false, uniform = false) {
  const chunk = (type, body) => {
    const result = Buffer.alloc(12 + body.length); result.writeUInt32BE(body.length);
    result.write(type, 4); body.copy(result, 8); result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
    return result;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 4 + 1) + 1 + x * 4;
    const subject = !uniform && (x - width / 2) ** 2 + (y - height / 2) ** 2 < (width / 4) ** 2;
    raw[offset] = subject ? 220 : 240; raw[offset + 1] = subject ? 35 : 240; raw[offset + 2] = subject ? 45 : 240;
    raw[offset + 3] = transparent ? 0 : 255;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('run accepts only an exact-sized mask and snapshots input before asynchronous work', async t => {
  const input = png(16, 16); const original = Buffer.from(input);
  const fixture = fakeWorker(t, (child, received) => {
    assert.deepEqual(received, original);
    child.stdout.write(header({ operation: 'run', width: 16, height: 16, metadata: { ...metadata, elapsedMs: 1, rawMin: 0, rawMax: 1 } }));
    child.stdout.write(Buffer.alloc(255)); child.close(0);
  });
  const result = fixture.backend.run({ png: input, width: 16, height: 16 });
  input.fill(0);
  await assert.rejects(result, { code: 'PROTOCOL' });
});

const pythonPath = process.env.PAINT_AI_TEST_PYTHON;
const modelPath = process.env.PAINT_AI_TEST_MODEL;
test('real configured CPU runtime probes, infers, rejects invalid input/model, and cancels', {
  skip: !pythonPath || !modelPath ? 'Set PAINT_AI_TEST_PYTHON and PAINT_AI_TEST_MODEL for authorized local inference.' : false,
}, async t => {
  const backend = createLocalAi({ pythonPath, modelPath });
  assert.equal((await backend.probe()).modelSha256, MODEL_SHA256);
  const image = png(256, 256);
  const result = await backend.run({ png: image, width: 256, height: 256 });
  assert.equal(result.mask.length, 65536); assert.equal(result.metadata.provider, 'CPUExecutionProvider');
  assert.ok(result.mask[128 * 256 + 128] > 240); assert.ok(result.mask[0] < 20);
  const corrupt = Buffer.from(image); corrupt[corrupt.length - 1] ^= 1;
  await assert.rejects(backend.run({ png: corrupt, width: 256, height: 256 }), { code: 'INPUT' });
  const concealedTrailingData = Buffer.concat([image, Buffer.from('junk after first IEND'), image.subarray(-12)]);
  await assert.rejects(backend.run({ png: concealedTrailingData, width: 256, height: 256 }), { code: 'INPUT' });
  await assert.rejects(backend.run({ png: png(16, 16, false, true), width: 16, height: 16 }), { code: 'INPUT' });
  await assert.rejects(backend.run({ png: png(16, 16, true), width: 16, height: 16 }), { code: 'INPUT' });
  const controller = new AbortController();
  const pending = backend.run({ png: image, width: 256, height: 256, signal: controller.signal });
  const cancelled = assert.rejects(pending, { code: 'ABORTED' });
  setTimeout(() => controller.abort(), 50);
  await cancelled;
  assert.equal((await backend.probe()).provider, 'CPUExecutionProvider');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sj-paint-ai-model-'));
  t.after(async () => { await fs.unlink(path.join(directory, 'wrong.onnx')); await fs.rmdir(directory); });
  await fs.writeFile(path.join(directory, 'wrong.onnx'), 'invalid model');
  await assert.rejects(createLocalAi({ pythonPath, modelPath: path.join(directory, 'wrong.onnx') }).probe(), { code: 'MODEL' });
});
