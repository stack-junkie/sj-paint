const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { spawn } = require('node:child_process');
const tar = require('tar');
const { createManagedAiSetup, INSTALL_SCRIPT } = require('./ai-setup.cjs');
const { manifest: published, selectProfiles, runtimeLocation, digest, DEFAULT_FEATURES } = require('./ai-manifest.cjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const error = code => Object.assign(new Error(code), { code });

async function fixture(t, unsafeArchive) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sj-ai-setup-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'source/python'), { recursive: true });
  await fs.writeFile(path.join(root, 'source/python/python.exe'), 'fixture interpreter, never executed');
  const archive = path.join(root, 'python.tar.gz');
  if (unsafeArchive) await fs.writeFile(archive, unsafeArchive);
  else await tar.c({ gzip: true, file: archive, cwd: path.join(root, 'source') }, ['python']);
  const definitions = [
    ['python.tar.gz', await fs.readFile(archive), 'python'],
    ['fixture-1-py3-none-any.whl', Buffer.from('a fixed fixture wheel, never installed'), 'wheel'],
    ['u2netp.onnx', Buffer.from('a fixed model fixture, never loaded'), 'model'],
  ];
  const artifacts = {}, seeds = {}, bytes = {};
  for (const [filename, data, kind] of definitions) {
    const id = sha(data), file = path.join(root, filename);
    await fs.writeFile(file, data); seeds[id] = file; bytes[id] = data;
    artifacts[id] = { sha256: id, filename, bytes: data.length, kind, ...(['wheel', 'python'].includes(kind) ? { expandedBytes: data.length } : {}),
      url: `https://example.invalid/${filename}`, license: 'fixture' };
  }
  const ids = Object.keys(artifacts), model = { files: [{ artifact: ids[2], path: 'u2netp.onnx' }] };
  const manifest = { schemaVersion: 1, artifacts, runtimes: { 'win32-x64-onnx': {
    platform: 'win32', arch: 'x64', python: ids[0], executable: 'python.exe', wheels: [ids[1]], packages: { fixture: '1' }, probe: 'onnx' } },
    models: { u2net: { files: [{ artifact: ids[2], path: 'u2net.onnx' }] }, u2netp: model, 'efficientsam-ti': model, sdxl: model, 'sdxl-base': model, 'sdxl-coloring': model,
      migan: { files: [{ artifact: ids[2], path: 'migan_pipeline_v2.onnx' }] } } };
  const processes = [];
  const createWorkerProcess = config => {
    let owned = true;
    const worker = { config, async request(operation, fields, payload, maxPayload, signal, progress) {
      assert(['install', 'probe'].includes(operation)); assert.equal(config.script, INSTALL_SCRIPT);
      const request = JSON.parse(payload); assert.equal(request.wheels.length, operation === 'install' ? 1 : 0);
      if (operation === 'install') assert.equal(await fs.readFile(request.wheels[0], 'utf8'), definitions[1][1].toString());
      worker.operation = operation;
      progress?.({ stage: 'installing', completed: 1, total: 1 });
      return { header: { ok: true, metadata: { packages: { fixture: '1' } } }, payload: Buffer.alloc(0) };
    }, async close() { owned = false; }, state() { return { owned, blocked: false }; } };
    processes.push(worker); return worker;
  };
  return { root, manifest, seeds, bytes, ids, processes, createWorkerProcess,
    options: { userDataPath: path.join(root, 'data'), manifest, platform: 'win32', arch: 'x64', seedAssets: seeds } };
}

test('released Windows/Linux profiles pin portable ONNX dependencies without diffusion downloads', () => {
  assert.equal(Object.keys(published.runtimes).length, 6, 'Legacy runtime definitions remain preserved');
  for (const platform of ['win32', 'linux']) {
    const selected = selectProfiles(published, {}, platform, 'x64');
    assert.equal(selected.selections.length, 3);
    assert(selected.selections.every(item => item.runtimeId === `${platform}-x64-onnx`));
    assert(selected.artifacts.every(item => /^[a-f0-9]{64}$/.test(item.sha256) && item.url.startsWith('https://') && item.bytes > 0));
    assert(selected.artifacts.some(item => item.filename.includes('cpython-3.12.15')));
    assert(!selected.artifacts.some(item => /torch|safetensors|opencv/.test(item.filename)));
  }
});

test('removal setup uses the installed ONNX runtime without generation dependencies and resolves independently', async t => {
  for (const platform of ['win32','linux']) {
    const selection=selectProfiles(published,{features:['migan'],accelerator:'cuda'},platform,'x64');
    assert.equal(selection.selections[0].runtimeId,`${platform}-x64-onnx`);
    assert(selection.artifacts.some(value=>value.filename==='migan_pipeline_v2.onnx'));
    assert(selection.artifacts.some(value=>value.filename==='migan-LICENSE'));
    assert(!selection.artifacts.some(value=>/torch|safetensors|opencv/.test(value.filename)));
  }
  const f=await fixture(t), manager=createManagedAiSetup(f.options,{createWorkerProcess:f.createWorkerProcess});
  const status = await manager.status();
  assert.deepEqual(status.defaultFeatures, DEFAULT_FEATURES);
  status.defaultFeatures.length = 0;
  assert.deepEqual((await manager.status()).defaultFeatures, DEFAULT_FEATURES, 'Status callers cannot change manifest defaults');
  await manager.setup({id:'background',features:['u2netp']});
  const background=await manager.resolve('u2netp'), workers=f.processes.length;
  await manager.setup({id:'removal',features:['migan']});
  const descriptor=await manager.resolve('migan');
  assert.equal(descriptor.pythonPath,background.pythonPath);
  assert.equal(path.basename(descriptor.removalModelPath),'migan_pipeline_v2.onnx');
  assert.equal(f.processes.length,workers,'An already verified runtime needs no reinstall or import');
  await assert.rejects(manager.resolve('sdxl-base'), { code: 'INPUT' });
  assert.deepEqual(await manager.resolve('u2netp'),background);
  await manager.close();
});

test('status and plan are read-only, seeds install through real files/extraction and activation persists', async t => {
  const f = await fixture(t), events = [];
  const setup = createManagedAiSetup({ ...f.options, onProgress: event => events.push(event.stage) }, {
    createWorkerProcess: f.createWorkerProcess, fetch: () => { throw new Error('Seeded setup must not download.'); } });
  assert.equal((await setup.status()).features.u2netp.installed, false);
  assert.equal((await setup.plan({ features: ['u2netp'] })).estimatedDownloadBytes, 0);
  await assert.rejects(fs.stat(f.options.userDataPath), { code: 'ENOENT' });
  assert.deepEqual(await setup.setup({ id: 'seeded', features: ['u2netp'] }), { installed: ['u2netp'] });
  const resolved = await setup.resolve('u2netp');
  assert.equal(await fs.readFile(resolved.modelPath, 'utf8'), f.bytes[f.ids[2]].toString());
  assert(resolved.pythonPath.startsWith(path.join(f.options.userDataPath, 'ai/r')));
  assert.equal(f.processes[0].config.pythonPath, resolved.pythonPath, 'runtime is probed at its final executable path');
  const ready = JSON.parse(await fs.readFile(path.join(path.dirname(resolved.pythonPath), 'ready.json'), 'utf8'));
  assert.equal(ready.probedExecutable, resolved.pythonPath);
  assert.equal(f.processes.length, 1); assert.equal(f.processes[0].state().owned, false);
  assert(events.includes('reusing') && events.includes('installing') && events.includes('ready'));
  const again = createManagedAiSetup(f.options, { createWorkerProcess: f.createWorkerProcess });
  assert.deepEqual(await again.resolve('u2netp'), resolved);
  assert.equal(await fs.readFile(f.seeds[f.ids[2]], 'utf8'), f.bytes[f.ids[2]].toString());
  await setup.close(); await again.close();
});

test('reused installed model verification reports its current file before activation', async t => {
  const f = await fixture(t), events = [];
  const setup = createManagedAiSetup({ ...f.options, onProgress: event => events.push(event) }, {
    createWorkerProcess: f.createWorkerProcess });
  await setup.setup({ id: 'initial-model', features: ['u2net'] });
  events.length = 0;
  await setup.setup({ id: 'verify-installed-model', features: ['u2net'] });
  assert.deepEqual(events.at(-2), { id: 'verify-installed-model', stage: 'verifying',
    artifact: 'u2net.onnx', completed: 0, total: f.bytes[f.ids[2]].length });
  assert.equal(events.at(-1).stage, 'ready');
  assert.equal(f.processes.length, 1, 'verified reuse does not reinstall or start a worker');
  await setup.close();
});

test('digest mismatch does not create a runtime or activation and rejects the bad partial', async t => {
  const f = await fixture(t);
  const setup = createManagedAiSetup({ ...f.options, seedAssets: {} }, { createWorkerProcess: f.createWorkerProcess,
    fetch: async url => { const artifact = Object.values(f.manifest.artifacts).find(item => item.url === url);
      return new Response(Buffer.alloc(artifact.bytes, 42), { status: 200, headers: { 'content-length': String(artifact.bytes) } }); } });
  await assert.rejects(setup.setup({ id: 'bad-digest', features: ['u2netp'] }), { code: 'INTEGRITY' });
  assert.equal(f.processes.length, 0); assert.equal(await setup.resolve('u2netp'), null);
  const part = path.join(f.options.userDataPath, 'ai/artifacts', f.ids[0], 'python.tar.gz.part');
  await assert.rejects(fs.stat(part), { code: 'ENOENT' });
  assert.equal((await setup.status()).state, 'idle');
});

test('a moved runtime is not ready until a successful probe at the new final path', async t => {
  const f = await fixture(t), original = createManagedAiSetup(f.options, { createWorkerProcess: f.createWorkerProcess });
  await original.setup({ id: 'before-move', features: ['u2netp'] }); await original.close();
  const movedPath = path.join(f.root, 'moved-data'); await fs.rename(f.options.userDataPath, movedPath);
  const moved = createManagedAiSetup({ ...f.options, userDataPath: movedPath }, { createWorkerProcess: f.createWorkerProcess });
  assert.equal(await moved.resolve('u2netp'), null);
  await moved.setup({ id: 'after-move', features: ['u2netp'] });
  assert.equal(f.processes.length, 2); assert.equal(f.processes[1].operation, 'probe');
  assert.equal((await moved.resolve('u2netp')).pythonPath, f.processes[1].config.pythonPath);
});

test('unrelated catalog additions preserve readiness while selected model or runtime changes invalidate it', async t => {
  const f = await fixture(t), original = createManagedAiSetup(f.options, { createWorkerProcess: f.createWorkerProcess });
  await original.setup({ id: 'catalog-before', features: ['u2netp'] }); await original.close();
  const before = await original.resolve('u2netp'), added = structuredClone(f.manifest), unrelated = 'b'.repeat(64);
  added.artifacts[unrelated] = { ...added.artifacts[f.ids[0]], sha256: unrelated, filename: 'unrelated.tar.gz' };
  added.models.sdxl = { ...added.models.sdxl, license: 'Updated unrelated model metadata' };
  const compatible = createManagedAiSetup({ ...f.options, manifest: added });
  assert.deepEqual(await compatible.resolve('u2netp'), before);
  const changedModel = structuredClone(added); changedModel.models.u2netp = { ...changedModel.models.u2netp, license: 'Selected model changed' };
  assert.equal(await createManagedAiSetup({ ...f.options, manifest: changedModel }).resolve('u2netp'), null);
  const changedRuntime = structuredClone(added); changedRuntime.runtimes['win32-x64-onnx'].packages.fixture = '2';
  assert.equal(await createManagedAiSetup({ ...f.options, manifest: changedRuntime }).resolve('u2netp'), null);
});

test('full U2Net has a distinct descriptor and retains U2NetP compatibility', async t => {
  const f = await fixture(t), setup = createManagedAiSetup(f.options, { createWorkerProcess: f.createWorkerProcess });
  await setup.setup({ id: 'matte-models', features: ['u2net', 'u2netp'] });
  const full = await setup.resolve('u2net'), small = await setup.resolve('u2netp');
  assert.equal(full.backgroundModelId, 'u2net'); assert.equal(path.basename(full.modelPath), 'u2net.onnx');
  assert.equal(path.basename(small.modelPath), 'u2netp.onnx'); assert.notEqual(full.modelPath, small.modelPath);
  assert.equal(full.pythonPath, small.pythonPath); assert.equal(f.processes.length, 1);
});

test('capacity planning reuses installed runtime and model allocations while reserving new model copies', async t => {
  const f = await fixture(t), setup = createManagedAiSetup(f.options, { createWorkerProcess: f.createWorkerProcess });
  const first = await setup.plan({ features: ['u2netp'] });
  assert(first.capacity.runtimeBytes > 0 && first.capacity.modelBytes > 0 && first.capacity.temporaryWheelBytes > 0);
  await setup.setup({ id: 'capacity-installed', features: ['u2netp'] });
  const again = await setup.plan({ features: ['u2netp'] });
  assert.equal(again.estimatedDownloadBytes, 0);
  assert.equal(again.capacity.runtimeBytes, 0); assert.equal(again.capacity.modelBytes, 0);
  assert.equal(again.capacity.temporaryWheelBytes, 0); assert.equal(again.capacity.runtimeReserveBytes, 0);
  assert(again.requiredFreeBytesEstimate < first.requiredFreeBytesEstimate);
  const extra = await setup.plan({ features: ['u2net'] });
  assert.equal(extra.capacity.runtimeBytes, 0); assert.equal(extra.estimatedDownloadBytes, 0);
  assert.equal(extra.capacity.modelBytes, f.bytes[f.ids[2]].length);
  await setup.setup({ id: 'capacity-extra', features: ['u2net'] });
  assert.equal(f.processes.length, 1, 'adding a model reuses the existing runtime');
});

test('fetch failures are actionable network errors and leave setup retryable', async t => {
  const f = await fixture(t), setup = createManagedAiSetup({ ...f.options, seedAssets: {} }, {
    createWorkerProcess: f.createWorkerProcess, fetch: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(setup.setup({ id: 'offline', features: ['u2netp'] }), error =>
    error.code === 'NETWORK' && error.message.includes('python.tar.gz') && error.message.includes('retry'));
  assert.equal((await setup.status()).state, 'idle'); assert.equal(f.processes.length, 0);
});

test('setup forwards confirmed ownership-release notification to its process owner', async t => {
  const f = await fixture(t), onOwnershipReleased = () => {};
  let forwarded;
  const setup = createManagedAiSetup({ ...f.options, onOwnershipReleased }, { createWorkerProcess: (config, dependencies) => {
    forwarded = dependencies.onOwnershipReleased; return f.createWorkerProcess(config);
  } });
  await setup.setup({ id: 'ownership-notification', features: ['u2netp'] });
  assert.equal(forwarded, onOwnershipReleased);
  await setup.close();
});

test('malformed readiness receipts report integrity failure before any worker starts', async t => {
  const f = await fixture(t), directory = path.join(f.options.userDataPath, 'ai', runtimeLocation(f.manifest.runtimes['win32-x64-onnx']));
  await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, 'ready.json'), '{broken');
  const setup = createManagedAiSetup(f.options, { createWorkerProcess: f.createWorkerProcess });
  await assert.rejects(setup.plan({ features: ['u2netp'] }), { code: 'INTEGRITY' });
  await assert.rejects(setup.setup({ id: 'broken-receipt', features: ['u2netp'] }), { code: 'INTEGRITY' });
  assert.equal(f.processes.length, 0); assert.equal(await fs.readFile(path.join(directory, 'ready.json'), 'utf8'), '{broken');
});

test('excluded legacy accelerator bindings remain untouched and absent from status', async t => {
  const f = await fixture(t), setup = createManagedAiSetup(f.options);
  assert.equal((await setup.status()).features['sdxl-base'], undefined);
  const registryPath = path.join(f.options.userDataPath, 'ai/active.json');
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  const bytes = JSON.stringify({ schemaVersion: 1, features: { sdxl: { runtimeId: 'legacy-runtime', runtime: 'r/legacy', model: 'm/legacy' } } });
  await fs.writeFile(registryPath, bytes);
  assert.equal((await setup.status()).features['sdxl-base'], undefined);
  assert.equal(await fs.readFile(registryPath, 'utf8'), bytes);
  await setup.close();
});

test('a final-path import failure never publishes readiness and cleans the unpublished runtime', async t => {
  const f = await fixture(t);
  const setup = createManagedAiSetup(f.options, { createWorkerProcess: config => {
    assert(config.pythonPath.startsWith(path.join(f.options.userDataPath, 'ai/r')));
    let owned = true;
    return { async request() { return { header: { ok: false, message: 'Native library cannot load at this path.' } }; },
      async close() { owned = false; }, state() { return { owned }; } };
  } });
  await assert.rejects(setup.setup({ id: 'path-failure', features: ['u2netp'] }), { code: 'RUNTIME' });
  assert.equal(await setup.resolve('u2netp'), null);
  assert.deepEqual(await fs.readdir(path.join(f.options.userDataPath, 'ai/r')), []);
  const retry = createManagedAiSetup(f.options, { createWorkerProcess: f.createWorkerProcess });
  await retry.setup({ id: 'path-retry', features: ['u2netp'] }); assert(await retry.resolve('u2netp'));
});

test('short runtime locations require the full manifest digest before reuse', async t => {
  const f = await fixture(t), profile = f.manifest.runtimes['win32-x64-onnx'];
  const target = path.join(f.options.userDataPath, 'ai', runtimeLocation(profile));
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'ready.json'), JSON.stringify({ digest: 'a'.repeat(64) }));
  const setup = createManagedAiSetup(f.options, { createWorkerProcess: f.createWorkerProcess });
  await assert.rejects(setup.setup({ id: 'collision', features: ['u2netp'] }), { code: 'INTEGRITY' });
  assert.equal(f.processes.length, 0);
  assert.equal(JSON.parse(await fs.readFile(path.join(target, 'ready.json'), 'utf8')).digest, 'a'.repeat(64));
});

test('a crashed owner leaves its attempt immutable while a fresh owner installs and atomically publishes a replacement', async t => {
  const f = await fixture(t), original = createManagedAiSetup(f.options, { createWorkerProcess: f.createWorkerProcess });
  await original.setup({ id: 'prior-runtime', features: ['u2netp'] });
  const prior = await original.resolve('u2netp'), registryPath = path.join(f.options.userDataPath, 'ai/active.json');
  const registryBefore = await fs.readFile(registryPath);
  await original.close();
  const manifest = structuredClone(f.manifest); manifest.runtimes['win32-x64-onnx'].packages.fixture = '2';
  const options = { ...f.options, manifest }, optionsPath = path.join(f.root, 'options.json'), marker = path.join(f.root, 'crashed-path.txt');
  await fs.writeFile(optionsPath, JSON.stringify(options));
  // Production extraction/filesystem ownership runs in another Node owner.
  // Its injected installer exits the owner before any readiness publication;
  // no Python, package installer or model is executed by this fixture.
  const script = `const fs=require('node:fs'); const {createManagedAiSetup}=require(process.argv[1]);
    const options=JSON.parse(fs.readFileSync(process.argv[2]));
    createManagedAiSetup(options,{createWorkerProcess(config){return {async request(){
      fs.writeFileSync(process.argv[3],config.pythonPath);process.exit(85);
    },async close(){},state(){return {owned:true}}}}}).setup({id:'interrupted',features:['u2netp']})
    .catch(error=>{console.error(error);process.exitCode=1});`;
  const child = spawn(process.execPath, ['-e', script, require.resolve('./ai-setup.cjs'), optionsPath, marker], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10_000);
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  clearTimeout(timer); assert.equal(timedOut, false); assert.equal(exit.code, 85, stderr);
  const orphanPython = await fs.readFile(marker, 'utf8'), orphan = path.dirname(orphanPython);
  const orphanBytes = await fs.readFile(orphanPython), orphanStat = await fs.stat(orphanPython);
  const orphanEntries = await fs.readdir(orphan);
  await assert.rejects(fs.stat(path.join(orphan, 'ready.json')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(registryPath), registryBefore);
  let release, reached;
  const closing = new Promise(resolve => { reached = resolve; }), mayClose = new Promise(resolve => { release = resolve; });
  const next = createManagedAiSetup(options, { createWorkerProcess(config) {
    const worker = f.createWorkerProcess(config), close = worker.close.bind(worker);
    worker.close = async () => { reached(config.pythonPath); await mayClose; await close(); }; return worker;
  } });
  const estimate = await next.plan({ features: ['u2netp'] });
  assert(estimate.capacity.runtimeBytes > 0 && estimate.capacity.runtimeReserveBytes > 0, 'An orphan does not discount replacement allocation');
  const operation = next.setup({ id: 'recovered', features: ['u2netp'] });
  const candidatePython = await closing;
  try {
    assert.notEqual(candidatePython, orphanPython); assert.notEqual(candidatePython, prior.pythonPath);
    assert.deepEqual(await fs.readFile(registryPath), registryBefore, 'Activation waits for the exact worker close');
    await assert.rejects(fs.stat(path.join(path.dirname(candidatePython), 'ready.json')), { code: 'ENOENT' });
  } finally { release(); await operation; }
  assert.equal((await next.resolve('u2netp')).pythonPath, candidatePython);
  const activated = JSON.parse(await fs.readFile(registryPath, 'utf8')).features.u2netp;
  const receipt = JSON.parse(await fs.readFile(path.join(path.dirname(candidatePython), 'ready.json'), 'utf8'));
  assert.equal(activated.runtimeDigest, digest(manifest.runtimes[activated.runtimeId]));
  assert.equal(receipt.digest, activated.runtimeDigest); assert.equal(receipt.installationId, path.basename(path.dirname(candidatePython)));
  assert.equal(receipt.runtimeId, activated.runtimeId); assert.equal(receipt.probedExecutable, candidatePython);
  assert.deepEqual(await fs.readFile(orphanPython), orphanBytes); assert.deepEqual(await fs.readdir(orphan), orphanEntries);
  assert.equal((await fs.stat(orphanPython)).mtimeMs, orphanStat.mtimeMs);
  assert.equal(await fs.readFile(prior.pythonPath, 'utf8'), 'fixture interpreter, never executed');
  const restarted = createManagedAiSetup(options, { createWorkerProcess: f.createWorkerProcess });
  assert.equal((await restarted.plan({ features: ['u2net'] })).capacity.runtimeBytes, 0);
  const count = f.processes.length;
  await restarted.setup({ id: 'reuse-for-another-feature', features: ['u2net'] });
  assert.equal((await restarted.resolve('u2net')).pythonPath, candidatePython); assert.equal(f.processes.length, count);
  await next.close(); await restarted.close();
});

test('canonical legacy readiness remains reusable and incomplete canonical directories are preserved', async t => {
  for (const ready of [false, true]) {
    const f = await fixture(t), profile = f.manifest.runtimes['win32-x64-onnx'];
    const name = runtimeLocation(profile), target = path.join(f.options.userDataPath, 'ai', name), pythonPath = path.join(target, 'python.exe');
    await fs.mkdir(target, { recursive: true }); await fs.writeFile(pythonPath, 'legacy fixture interpreter');
    const receiptBytes = JSON.stringify({ digest: digest(profile), probedExecutable: pythonPath });
    if (ready) await fs.writeFile(path.join(target, 'ready.json'), receiptBytes);
    const manager = createManagedAiSetup(f.options, { createWorkerProcess: f.createWorkerProcess });
    assert.equal((await manager.plan({ features: ['u2netp'] })).capacity.runtimeBytes === 0, ready);
    await manager.setup({ id: 'canonical-compatibility', features: ['u2netp'] });
    const descriptor = await manager.resolve('u2netp');
    assert.equal(descriptor.pythonPath === pythonPath, ready); assert.equal(f.processes.length, ready ? 0 : 1);
    assert.equal(await fs.readFile(pythonPath, 'utf8'), 'legacy fixture interpreter');
    if (ready) {
      assert.equal(await fs.readFile(path.join(target, 'ready.json'), 'utf8'), receiptBytes);
      const registryPath = path.join(f.options.userDataPath, 'ai/active.json'), registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
      delete registry.features.u2netp.runtimeDigest; await fs.writeFile(registryPath, JSON.stringify(registry));
      const restarted = createManagedAiSetup(f.options);
      assert.deepEqual(await restarted.resolve('u2netp'), descriptor, 'Pre-attempt activation records remain compatible');
    } else await assert.rejects(fs.stat(path.join(target, 'ready.json')), { code: 'ENOENT' });
    await manager.close();
  }
});

test('activated attempt receipt identity and full digest mismatches fail without rewriting or replacing it', async t => {
  const f = await fixture(t), manager = createManagedAiSetup(f.options, { createWorkerProcess: f.createWorkerProcess });
  await manager.setup({ id: 'valid-attempt', features: ['u2netp'] });
  const descriptor = await manager.resolve('u2netp'), filename = path.join(path.dirname(descriptor.pythonPath), 'ready.json');
  const original = JSON.parse(await fs.readFile(filename, 'utf8'));
  const registry = await fs.readFile(path.join(f.options.userDataPath, 'ai/active.json'));
  for (const change of [{ installationId: 'f'.repeat(16) }, { runtimeId: 'another-runtime' }, { digest: 'a'.repeat(64) }]) {
    const bytes = JSON.stringify({ ...original, ...change }); await fs.writeFile(filename, bytes);
    const restarted = createManagedAiSetup(f.options, { createWorkerProcess: f.createWorkerProcess });
    await assert.rejects(restarted.resolve('u2netp'), { code: 'INTEGRITY' });
    await assert.rejects(restarted.plan({ features: ['u2net'] }), { code: 'INTEGRITY' });
    await assert.rejects(restarted.setup({ id: 'must-not-repair', features: ['u2net'] }), { code: 'INTEGRITY' });
    assert.equal(await fs.readFile(filename, 'utf8'), bytes);
    assert.deepEqual(await fs.readFile(path.join(f.options.userDataPath, 'ai/active.json')), registry);
  }
  assert.equal(f.processes.length, 1);
});

test('compressed HTTP transfers verify decoded artifact bytes instead of transfer length', async t => {
  for (const corrupt of [false, true]) {
    const f = await fixture(t), id = f.ids[2], data = f.bytes[id];
    const seeds = { ...f.seeds }; delete seeds[id];
    const setup = createManagedAiSetup({ ...f.options, seedAssets: seeds }, {
      createWorkerProcess: f.createWorkerProcess,
      fetch: async () => new Response(corrupt ? Buffer.alloc(data.length, 42) : data, {
        // Fetch decodes the body, but retains the encoded response headers.
        headers: { 'content-encoding': 'gzip', 'content-length': String(gzipSync(data).length) },
      }),
    });
    if (corrupt) await assert.rejects(setup.setup({ id: 'compressed-bad-digest', features: ['u2netp'] }), { code: 'INTEGRITY' });
    else {
      await setup.setup({ id: 'compressed', features: ['u2netp'] });
      assert.deepEqual(await fs.readFile((await setup.resolve('u2netp')).modelPath), data);
    }
    await setup.close();
  }
});

test('a verified range resume retains prior bytes and validates the complete result', async t => {
  const f = await fixture(t), id = f.ids[2], data = f.bytes[id], offset = 7;
  const seeds = { ...f.seeds }; delete seeds[id];
  const dir = path.join(f.options.userDataPath, 'ai/artifacts', id); await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'u2netp.onnx.part'), data.subarray(0, offset));
  let downloads = 0;
  const setup = createManagedAiSetup({ ...f.options, seedAssets: seeds }, { createWorkerProcess: f.createWorkerProcess,
    fetch: async (url, options) => { downloads++; assert.equal(options.headers.Range, `bytes=${offset}-`);
      assert.equal(options.headers['Accept-Encoding'], 'identity');
      return new Response(data.subarray(offset), { status: 206, headers: { 'content-length': String(data.length - offset),
        'content-range': `bytes ${offset}-${data.length - 1}/${data.length}` } }); } });
  await setup.setup({ id: 'resume', features: ['u2netp'] });
  assert.equal(downloads, 1); assert.deepEqual(await fs.readFile((await setup.resolve('u2netp')).modelPath), data);
});

test('rejected download headers cancel the unread response body and preserve resumable bytes', async t => {
  const f = await fixture(t), id = f.ids[0], prefix = f.bytes[id].subarray(0, 7);
  const dir = path.join(f.options.userDataPath, 'ai/artifacts', id); await fs.mkdir(dir, { recursive: true });
  const partial = path.join(dir, 'python.tar.gz.part'); await fs.writeFile(partial, prefix);
  let canceled = false;
  const setup = createManagedAiSetup({ ...f.options, seedAssets: {} }, { createWorkerProcess: f.createWorkerProcess,
    fetch: async () => new Response(new ReadableStream({ cancel() { canceled = true; } }), {
      status: 206, headers: { 'content-range': 'bytes 8-9/10' } }) });
  await assert.rejects(setup.setup({ id: 'bad-range', features: ['u2netp'] }), { code: 'NETWORK' });
  assert.equal(canceled, true); assert.deepEqual(await fs.readFile(partial), prefix);
  assert.equal((await setup.status()).state, 'idle'); assert.equal(f.processes.length, 0);
});

test('compressed partial responses cannot append encoded range offsets to decoded bytes', async t => {
  const f = await fixture(t), id = f.ids[0], data = f.bytes[id], offset = 7;
  const dir = path.join(f.options.userDataPath, 'ai/artifacts', id); await fs.mkdir(dir, { recursive: true });
  const partial = path.join(dir, 'python.tar.gz.part'); await fs.writeFile(partial, data.subarray(0, offset));
  let canceled = false;
  const setup = createManagedAiSetup({ ...f.options, seedAssets: {} }, {
    createWorkerProcess: f.createWorkerProcess,
    fetch: async () => new Response(new ReadableStream({ cancel() { canceled = true; } }), {
      status: 206, headers: { 'content-encoding': 'gzip', 'content-range': `bytes ${offset}-${data.length - 1}/${data.length}` },
    }),
  });
  await assert.rejects(setup.setup({ id: 'compressed-range', features: ['u2netp'] }), { code: 'NETWORK' });
  assert(canceled); assert.deepEqual(await fs.readFile(partial), data.subarray(0, offset));
  assert.equal(f.processes.length, 0);
  await setup.close();
});

test('canceling an active download drains it and permits a subsequent setup', async t => {
  const f = await fixture(t); let started;
  const began = new Promise(resolve => { started = resolve; });
  const setup = createManagedAiSetup({ ...f.options, seedAssets: {} }, { createWorkerProcess: f.createWorkerProcess,
    fetch: async (url, options) => { started(); return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(error('ABORTED')), { once: true })); } });
  const operation = setup.setup({ id: 'cancel-download', features: ['u2netp'] });
  const rejected = assert.rejects(operation, { code: 'ABORTED' });
  await began; await setup.cancel('cancel-download'); await rejected;
  assert.equal((await setup.status()).state, 'idle'); assert.equal(await setup.resolve('u2netp'), null);
  assert.equal(f.processes.length, 0);
  const retry = createManagedAiSetup(f.options, { createWorkerProcess: f.createWorkerProcess });
  await retry.setup({ id: 'retry', features: ['u2netp'] }); assert(await retry.resolve('u2netp'));
});

test('an installation failure preserves the previously activated runtime and cleans only its stage', async t => {
  const f = await fixture(t), good = createManagedAiSetup(f.options, { createWorkerProcess: f.createWorkerProcess });
  await good.setup({ id: 'first', features: ['u2netp'] });
  const registryPath = path.join(f.options.userDataPath, 'ai/active.json'), before = await fs.readFile(registryPath);
  const changed = structuredClone(f.manifest); changed.runtimes['win32-x64-onnx'].packages.fixture = '2';
  const bad = createManagedAiSetup({ ...f.options, manifest: changed }, { createWorkerProcess: () => {
    let owned = true; return { async request() { throw error('RUNTIME'); }, async close() { owned = false; }, state() { return { owned }; } };
  } });
  await assert.rejects(bad.setup({ id: 'failure', features: ['u2netp'] }), { code: 'RUNTIME' });
  assert.deepEqual(await fs.readFile(registryPath), before); assert(await good.resolve('u2netp'));
  assert.deepEqual(await fs.readdir(path.join(f.options.userDataPath, 'ai/staging')), []);
});

test('late worker closure retains ownership until confirmed, then allows cleanup and retry', async t => {
  const f = await fixture(t); let owned = true, calls = 0;
  const setup = createManagedAiSetup(f.options, { createWorkerProcess: config => {
    calls++; if (calls > 1) return f.createWorkerProcess(config);
    return { async request() { throw error('TIMEOUT'); }, async close() { throw error('CLEANUP'); }, state() { return { owned, blocked: owned }; } };
  } });
  await assert.rejects(setup.setup({ id: 'late', features: ['u2netp'] }), { code: 'TIMEOUT' });
  const pending = await setup.status(); assert.equal(pending.ownsProcess, true); assert.equal(pending.cleanupPending, true);
  await assert.rejects(setup.cancel('late'), { code: 'CLEANUP' });
  await assert.rejects(setup.setup({ id: 'too-early', features: ['u2netp'] }), { code: 'BUSY' });
  owned = false; assert.equal(await setup.cancel('late'), true); assert.equal((await setup.status()).state, 'idle');
  await setup.setup({ id: 'after-close', features: ['u2netp'] }); assert.equal(calls, 2);
});

test('archive traversal is rejected before starting an interpreter', async t => {
  const header = Buffer.alloc(512); header.write('python/../../escaped.txt');
  header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write('00000000001\0', 124); header.write('00000000000\0', 136); header.fill(32, 148, 156); header[156] = 48;
  header.write('ustar\0', 257); header.write('00', 263);
  const sum = header.reduce((a, b) => a + b, 0); header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const f = await fixture(t, gzipSync(Buffer.concat([header, Buffer.from('x'), Buffer.alloc(511 + 1024)])));
  const setup = createManagedAiSetup(f.options, { createWorkerProcess: f.createWorkerProcess });
  await assert.rejects(setup.setup({ id: 'traversal', features: ['u2netp'] }), /archive path/);
  assert.equal(f.processes.length, 0);
  await assert.rejects(fs.stat(path.join(f.options.userDataPath, 'ai/escaped.txt')), { code: 'ENOENT' });
});


test('model files link only verified managed cache, copy when unsupported and preserve activation on integrity failure', async t => {
  for (const policy of ['link','copy','corrupt']) {
    const f=await fixture(t), options={createWorkerProcess:f.createWorkerProcess};
    if(policy!=='link') options.linkModelArtifact=async(source,target)=>{
      assert(source.startsWith(path.join(f.options.userDataPath,'ai/artifacts')));
      assert(!Object.values(f.seeds).includes(source));
      if(policy==='copy') throw error('EXDEV');
      // An incorrect install producer must not be activated. Do not mutate the
      // shared cache or an already activated model in this failure fixture.
      await fs.writeFile(target,'corrupted owned fixture');
    };
    const setup=createManagedAiSetup(f.options,options);
    if(policy==='corrupt') {
      const prior=createManagedAiSetup(f.options,{createWorkerProcess:f.createWorkerProcess});
      await prior.setup({id:'prior-model',features:['u2netp']});
      const descriptor=await prior.resolve('u2netp'), registry=await fs.readFile(path.join(f.options.userDataPath,'ai/active.json'));
      await prior.close();
      await assert.rejects(setup.setup({id:'corrupt-model',features:['u2net']}),{code:'INTEGRITY'});
      assert.equal(await setup.resolve('u2net'),null);
      assert.deepEqual(await setup.resolve('u2netp'),descriptor);
      assert.deepEqual(await fs.readFile(path.join(f.options.userDataPath,'ai/active.json')),registry);
      assert.equal(sha(await fs.readFile(descriptor.modelPath)),f.ids[2]);
    } else {
      await setup.setup({id:`model-${policy}`,features:['u2netp']});
      const descriptor=await setup.resolve('u2netp'), artifact=f.manifest.artifacts[f.ids[2]];
      const cache=path.join(f.options.userDataPath,'ai/artifacts',artifact.sha256,artifact.filename);
      const [installed,cached]=await Promise.all([fs.stat(descriptor.modelPath),fs.stat(cache)]);
      assert.equal(installed.ino===cached.ino,policy==='link');
      assert.equal(sha(await fs.readFile(descriptor.modelPath)),artifact.sha256);
    }
    await setup.close();
  }
});

test('release capabilities exclude unfinished modes and unused setup without changing legacy registry bytes', async t => {
  const release = require('./ai-capabilities.json');
  assert.deepEqual(Object.keys(release.generation), ['erase']);
  for (const feature of ['sdxl', 'sdxl-base', 'sdxl-coloring']) {
    assert(!DEFAULT_FEATURES.includes(feature)); assert(!release.setupFeatures.includes(feature));
  }
  const f = await fixture(t);
  const registryPath = path.join(f.options.userDataPath, 'ai/active.json');
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  const legacy = JSON.stringify({ schemaVersion: 1, features: { sdxl: { runtime: 'r/legacy', model: 'm/legacy', runtimeId: 'win32-x64-sdxl-cuda' }, 'sdxl-coloring': { runtime: 'r/legacy', model: 'm/coloring', runtimeId: 'win32-x64-sdxl-cuda' }, 'sdxl-base': { runtime: 'r/legacy', model: 'm/base', runtimeId: 'win32-x64-sdxl-cuda' } } });
  await fs.writeFile(registryPath, legacy);
  const setup = createManagedAiSetup(f.options, { createWorkerProcess: f.createWorkerProcess });
  for (const feature of ['sdxl', 'sdxl-base', 'sdxl-coloring']) {
    await assert.rejects(setup.plan({ features: [feature] }), /Choose supported AI features/);
    await assert.rejects(setup.setup({ id: `excluded-${feature}`, features: [feature] }), /Choose supported AI features/);
  }
  assert.equal(f.processes.length, 0);
  assert.equal(await fs.readFile(registryPath, 'utf8'), legacy);
  await setup.close();
});
