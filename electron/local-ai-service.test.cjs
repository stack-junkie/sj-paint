const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createLocalAi, LocalAiError, MODEL_SHA256, SELECTION_HASHES } = require('./local-ai.cjs');
const { createLocalAiService } = require('./local-ai-service.cjs');

const configuredEnv = { SJ_PAINT_PYTHON: process.execPath, SJ_PAINT_U2NETP_MODEL: path.resolve('approved-model.onnx'), SJ_PAINT_EFFICIENTSAM_ENCODER: path.resolve('encoder.onnx'), SJ_PAINT_EFFICIENTSAM_DECODER: path.resolve('decoder.onnx') };
const generationConfiguration = { pythonPath: process.execPath, removalModelPath: path.resolve('migan.onnx') };
function controlled() {
  const operations = [];
  const ownership = { owned: false, retained: null, blocked: false };
  const close = () => { ownership.owned = false; ownership.retained = null; ownership.blocked = false; };
  const start = (kind, request) => new Promise((resolve, reject) => {
    ownership.owned = true;
    operations.push({ kind, request, resolve(value) {
      if (kind === 'prepareSelection') ownership.retained = { sessionId: request.sessionId, targetToken: request.targetToken };
      else if (kind !== 'selectObject') close();
      resolve(value);
    }, reject(error) {
      if (error.code === 'CLEANUP') ownership.blocked = true;
      else close();
      reject(error);
    } });
  });
  const service = createLocalAiService({ env: configuredEnv, createBackend: () => ({
    state: () => ({ ...ownership }),
    probe: request => start('probe', request), run: request => start('run', request),
    prepareSelection: request => start('prepareSelection', request), selectObject: request => start('selectObject', request), releaseSelection: async () => { close(); },
  }) });
  return { service, operations, close };
}

test('unconfigured and invalid host paths are honest statuses without process creation or path disclosure', async () => {
  let created = false;
  const missing = createLocalAiService({ env: {}, createBackend: () => { created = true; } });
  assert.equal(missing.status().value.state, 'unconfigured');
  assert.equal((await missing.probe({ id: 'probe' })).error.code, 'UNCONFIGURED');
  const invalid = createLocalAiService({ env: { SJ_PAINT_PYTHON: 'relative', SJ_PAINT_U2NETP_MODEL: path.resolve('secret-model') } });
  assert.equal((await invalid.run({ id: 'run' })).error.code, 'CONFIG');
  assert.equal(JSON.stringify(invalid.status()).includes('secret-model'), false);
  assert.equal(created, false);
  assert.equal(missing.status().value.model.sha256, MODEL_SHA256);
});

test('removal-only service retains candidates, rejects stale targets, expires and cancels through the generation owner', async () => {
  let owned=false, releases=0, pendingResolve;
  const service=createLocalAiService({configuration:{pythonPath:process.execPath,removalModelPath:path.resolve('migan.onnx')},idleTimeoutMs:10,
    createBackend:()=>({state:()=>({owned,blocked:false}), generate:async request=>{
      owned=true;
      if(request.seed===9) return new Promise(resolve=>{pendingResolve=resolve;});
      return {mode:'erase',seed:request.seed,metadata:{model:'migan'}};
    },releaseSelection:async()=>{owned=false;releases++;}})});
  const status=service.status().value;
  assert.equal(status.features.sdxl,undefined); assert.equal(status.features.migan.configured,true);
  assert.equal(status.generation.model,undefined);
  assert.equal(status.generation.modelDetails.migan.sha256.length,64);
  assert.deepEqual(status.generation.requirements.erase,['migan']); assert.equal(status.generation.requirements.create,undefined); assert.equal(status.generation.requirements.sticker,undefined); assert.equal(status.generation.requirements.coloring,undefined);
  assert.equal((await service.generate({id:'create',targetToken:'doc',mode:'create'})).error.code,'INPUT');
  const first=await service.generate({id:'first',targetToken:'doc',mode:'erase',seed:1});
  assert.equal(first.ok,true); assert(first.value.candidateId);
  const second=await service.generate({id:'second',targetToken:'doc',mode:'erase',seed:2,sessionId:first.value.sessionId});
  assert.equal(second.value.sessionId,first.value.sessionId); assert.equal(service.status().value.generationSession.candidates.length,2);
  assert.equal((await service.generate({id:'stale',targetToken:'other',mode:'erase',sessionId:first.value.sessionId})).error.code,'SESSION_EXPIRED');
  await new Promise(resolve=>setTimeout(resolve,30)); assert.equal(releases,1); assert.equal(owned,false);
  assert.equal((await service.generate({id:'expired',targetToken:'doc',mode:'erase',sessionId:first.value.sessionId})).error.code,'SESSION_EXPIRED');
  const pending=service.generate({id:'cancel-removal',targetToken:'doc',mode:'erase',seed:9});
  const cancel=service.cancel({id:'cancel-removal'}); pendingResolve({mode:'erase',seed:9});
  assert.equal((await pending).error.code,'ABORTED'); assert.equal((await cancel).ok,true);
  assert.equal(owned,false); assert.equal(service.status().value.generationSession,null);
  await service.shutdown();
});

test('generation sessions bind targets, bound candidates, sanitize configuration and expire on release', async () => {
  let owned = false, calls = 0, config;
  const updates = [];
  const service = createLocalAiService({ configuration: generationConfiguration, onProgress: value => updates.push(value), createBackend: value => {
    config = value;
    return { state: () => ({ owned, blocked: false }), generate: async request => {
      calls++; owned = true; request.onProgress({ stage: 'denoise', completed: 1, total: 2 });
      assert.equal(request.modelPath, undefined);
      return { mode: request.mode, seed: request.seed, png: new Uint8Array([1]), width: 64, height: 64 };
    }, releaseSelection: async () => { owned = false; } };
  } });
  assert.deepEqual(config, { ...generationConfiguration, backgroundModelId: 'u2netp' });
  let sessionId, firstCandidate;
  for (let index = 0; index < 5; index++) {
    const result = await service.generate({ id: `gen-${index}`, ...(sessionId ? { sessionId } : {}), targetToken: 'doc-a', mode: 'erase', prompt: '', seed: index, modelPath: '/forged' });
    assert.equal(result.ok, true); sessionId = result.value.sessionId;
    if (!index) firstCandidate = result.value.candidateId;
    assert.equal(result.value.evictedCandidateId, index === 4 ? firstCandidate : null);
  }
  assert.equal(service.status().value.generationSession.candidates.length, 4);
  assert.equal(updates.length, 5); assert.equal(updates[0].targetToken, 'doc-a');
  assert.equal((await service.generate({ id: 'wrong', sessionId, targetToken: 'doc-b', mode: 'erase' })).error.code, 'SESSION_EXPIRED');
  assert.equal(calls, 5);
  assert.equal((await service.releaseGeneration({ sessionId })).ok, true);
  assert.equal(service.status().value.generationSession, null);
  assert.equal((await service.generate({ id: 'stale', sessionId, targetToken: 'doc-a', mode: 'erase' })).error.code, 'SESSION_EXPIRED');
});

test('status preserves candidate history while a new worker starts but reconciles an idle worker exit', async () => {
  let owned = false, finishHandoff, calls = 0;
  const service = createLocalAiService({ configuration: {
    ...generationConfiguration, pythonPath: process.execPath, modelPath: path.resolve('matte.onnx'),
  }, createBackend: () => ({
    state: () => ({ owned, blocked: false }),
    generate: async request => {
      calls++;
      if (calls === 2) {
        // The prior worker has closed and the next worker has not started.
        // This is still one active operation, not an idle worker exit.
        owned = false;
        await new Promise(resolve => { finishHandoff = resolve; });
      }
      owned = true;
      return { mode: request.mode, seed: request.seed };
    },
    releaseSelection: async () => { owned = false; },
  }) });
  const first = await service.generate({ id: 'first-create', targetToken: 'drawing', mode: 'erase', seed: 1 });
  assert.equal(first.ok, true);
  const before = service.status().value.generationSession;
  const second = service.generate({ id: 'retry-create', targetToken: 'drawing', sessionId: first.value.sessionId, mode: 'erase', seed: 2 });
  const during = service.status().value;
  assert.equal(during.state, 'busy');
  assert.equal(during.ownsProcess, false);
  assert.deepEqual(during.generationSession, before);
  assert.equal((await service.generate({ id: 'overlap', targetToken: 'drawing', mode: 'erase' })).error.code, 'BUSY');
  finishHandoff();
  const result = await second;
  assert.equal(result.ok, true);
  assert.equal(result.value.sessionId, first.value.sessionId);
  assert.deepEqual(service.status().value.generationSession.candidates.map(value => value.candidateId), [first.value.candidateId, result.value.candidateId]);
  // The same zero-owned state after the operation finishes really is a lost
  // retained worker. Old session IDs must then expire instead of lingering.
  owned = false;
  assert.equal(service.status().value.generationSession, null);
  assert.equal(service.status().value.features.migan.ready, false);
  assert.equal((await service.generate({ id: 'old-session', targetToken: 'drawing', sessionId: first.value.sessionId, mode: 'erase' })).error.code, 'SESSION_EXPIRED');
  assert.equal((await service.shutdown()).ok, true);
});

test('cancellation at generation completion preserves ABORTED while retaining failed cleanup until late close', async () => {
  let finish, owned = false, blocked = false;
  const service = createLocalAiService({ configuration: generationConfiguration, createBackend: () => ({
    state: () => ({ owned, blocked }), generate: () => new Promise(resolve => { owned = true; finish = resolve; }),
    releaseSelection: async () => { blocked = true; throw new LocalAiError('CLEANUP', 'Late close'); },
  }) });
  const pending = service.generate({ id: 'cancel-generation', targetToken: 'doc', mode: 'erase' });
  const cancelling = service.cancel({ id: 'cancel-generation' });
  finish({ mode: 'erase', seed: 1 });
  assert.equal((await pending).error.code, 'ABORTED');
  assert.equal((await cancelling).error.code, 'CLEANUP');
  assert.equal(service.status().value.state, 'blocked');
  assert.equal(service.status().value.generationSession, null);
  owned = false; blocked = false;
  assert.equal(service.status().value.state, 'idle');
});

test('generation idle expiry releases the retained pipeline', async () => {
  let owned = false, releases = 0;
  const service = createLocalAiService({ configuration: generationConfiguration, idleTimeoutMs: 10, createBackend: () => ({
    state: () => ({ owned, blocked: false }), generate: async () => { owned = true; return { mode: 'erase', seed: 1 }; },
    releaseSelection: async () => { releases++; owned = false; },
  }) });
  await service.generate({ id: 'gen', targetToken: 'doc', mode: 'erase' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(releases, 1); assert.equal(service.status().value.generationSession, null);
});

test('a retained image has a main-generated session and rejects foreign targets or another model', async () => {
  const { service, operations } = controlled();
  const request = { id: 'prepare', targetToken: 'document-1', png: new Uint8Array(1), width: 5, height: 4, sessionId: 'forged' };
  const preparing = service.prepareSelection(request);
  request.targetToken = 'changed-after-call';
  assert.notEqual(operations[0].request.sessionId, 'forged');
  operations[0].resolve({ width: 5, height: 4, metadata: {} });
  const session = (await preparing).value;
  assert.match(session.sessionId, /^[a-f0-9-]{36}$/);
  assert.equal(service.status().value.retainedSelection.sessionId, session.sessionId);
  assert.equal(service.status().value.active, null);
  assert.equal((await service.run({ id: 'background' })).error.code, 'BUSY');
  assert.equal((await service.selectObject({ id: 'select', sessionId: session.sessionId, targetToken: 'wrong' })).error.code, 'SESSION_EXPIRED');
  const selecting = service.selectObject({ id: 'select', sessionId: session.sessionId, targetToken: 'document-1', prompts: { points: [{ x: 2, y: 2 }] } });
  operations[1].resolve({ width: 5, height: 4, mask: new Uint8Array(20), metadata: {}, scores: [0, 1, 0], selectedCandidate: 1 });
  assert.equal((await selecting).value.sessionId, session.sessionId);
  assert.equal((await service.releaseSelection({ sessionId: 'wrong' })).error.code, 'SESSION_EXPIRED');
  assert.equal((await service.releaseSelection({ sessionId: session.sessionId })).ok, true);
  assert.equal(service.status().value.retainedSelection, null);
});

test('idle expiry releases retained workers and shutdown releases an idle image too', async () => {
  for (const shutdown of [false, true]) {
    let released = 0, owned = false;
    const service = createLocalAiService({ env: configuredEnv, idleTimeoutMs: 10, createBackend: () => ({
      state: () => ({ owned, retained: owned ? {} : null, blocked: false }),
      prepareSelection: async () => { owned = true; return { width: 1, height: 1 }; }, releaseSelection: async () => { released++; owned = false; },
    }) });
    const result = await service.prepareSelection({ id: 'prepare', targetToken: 'target', width: 1, height: 1 });
    if (shutdown) assert.equal((await service.shutdown()).ok, true);
    else await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(released, 1); assert.equal(service.status().value.retainedSelection, null);
    assert.equal((await service.selectObject({ id: 'stale', sessionId: result.value.sessionId, targetToken: 'target' })).error.code, shutdown ? 'CLOSED' : 'SESSION_EXPIRED');
  }
});

test('idle release cleanup failure retains image ownership and blocks future commands', async () => {
  let blocked = false;
  const service = createLocalAiService({ env: configuredEnv, createBackend: () => ({
    state: () => ({ owned: true, retained: {}, blocked }),
    prepareSelection: async () => ({ width: 1, height: 1 }), releaseSelection: async () => { blocked = true; throw new LocalAiError('CLEANUP', 'Not closed'); },
  }) });
  const session = (await service.prepareSelection({ id: 'prepare', targetToken: 'target', width: 1, height: 1 })).value;
  assert.equal((await service.releaseSelection({ sessionId: session.sessionId })).error.code, 'CLEANUP');
  assert.equal(service.status().value.retainedSelection.sessionId, session.sessionId);
  assert.equal((await service.probe({ id: 'new' })).error.code, 'CLEANUP');
  assert.equal((await service.shutdown()).error.code, 'CLEANUP');
});

test('releaseOwned cancels current work and leaves the service usable after a cancelled quit', async () => {
  const { service, operations } = controlled();
  const pending = service.probe({ id: 'probe-before-quit' });
  const releasing = service.releaseOwned();
  assert.equal(operations[0].request.signal.aborted, true);
  assert.equal((await service.run({ id: 'during-cleanup' })).error.code, 'BUSY');
  operations[0].reject(new LocalAiError('ABORTED', 'Cancelled.'));
  assert.equal((await pending).error.code, 'ABORTED');
  assert.equal((await releasing).ok, true); assert.equal(service.status().value.closed, false);
  const again = service.probe({ id: 'after-cancelled-quit' });
  operations[1].resolve({ modelSha256: MODEL_SHA256 });
  assert.equal((await again).ok, true);
});

test('failed cleanup is visible even when a worker has no retained image', async () => {
  let blocked = false;
  const service = createLocalAiService({ env: configuredEnv, createBackend: () => ({
    state: () => ({ owned: true, retained: null, blocked }),
    releaseSelection: async () => { blocked = true; throw new LocalAiError('CLEANUP', 'Not closed'); },
  }) });
  assert.equal(service.status().value.ownsProcess, true);
  assert.equal((await service.releaseOwned()).error.code, 'CLEANUP');
  assert.equal(service.status().value.cleanupBlocked, true);
  assert.equal(service.status().value.ownsProcess, true);
  assert.equal(service.status().value.retainedSelection, null);
});

test('one lease spans probe and run, with bounded IDs and only trusted configuration captured', async () => {
  const { service, operations } = controlled();
  assert.equal((await service.probe({ id: 'x'.repeat(81) })).error.code, 'INPUT');
  const probe = service.probe({ id: 'probe-1' });
  assert.deepEqual(service.status().value.active, { id: 'probe-1', kind: 'probe' });
  assert.equal((await service.run({ id: 'run-1' })).error.code, 'BUSY');
  operations[0].resolve({ modelSha256: MODEL_SHA256 });
  assert.equal((await probe).ok, true);
  assert.equal(service.status().value.ready, true);
  const png = new Uint8Array([1]);
  const run = service.run({ id: 'run-2', png, width: 2, height: 3, pythonPath: 'renderer-path' });
  assert.equal(operations[1].request.png, png);
  assert.equal('pythonPath' in operations[1].request, false);
  operations[1].resolve({ mask: new Uint8Array(6), width: 2, height: 3, metadata: {} });
  assert.equal((await run).value.mask.length, 6);
  assert.equal(service.status().value.state, 'idle');
});

test('cancellation matches ID, waits for cleanup, and discards a late successful result', async () => {
  const { service, operations } = controlled();
  const pending = service.run({ id: 'current' });
  assert.equal((await service.cancel({ id: 'stale' })).error.code, 'NOT_FOUND');
  assert.equal(operations[0].request.signal.aborted, false);
  const cancellation = service.cancel({ id: 'current' });
  assert.equal(operations[0].request.signal.aborted, true);
  assert.equal((await service.probe({ id: 'new' })).error.code, 'BUSY');
  operations[0].resolve({ mask: new Uint8Array(1) });
  assert.equal((await pending).error.code, 'ABORTED');
  assert.deepEqual(await cancellation, { ok: true, value: { id: 'current', cancelled: true } });
  assert.equal(service.status().value.active, null);
});

test('failed cleanup retains identity until confirmed closure, including after shutdown', async () => {
  const { service, operations, close } = controlled();
  const pending = service.probe({ id: 'owned-probe' });
  const cancel = service.cancel({ id: 'owned-probe' });
  operations[0].reject(new LocalAiError('CLEANUP', 'Worker still alive.'));
  assert.equal((await pending).error.code, 'CLEANUP');
  assert.equal((await cancel).error.code, 'CLEANUP');
  assert.equal((await service.probe({ id: 'next' })).error.code, 'CLEANUP');
  assert.equal(service.status().value.state, 'blocked');
  assert.deepEqual(service.status().value.active, { id: 'owned-probe', kind: 'probe' });
  assert.equal((await service.shutdown()).error.code, 'CLEANUP');
  assert.equal(service.status().value.closed, true);
  close();
  assert.equal(service.status().value.active, null);
  assert.equal(service.status().value.cleanupBlocked, false);
  assert.equal((await service.shutdown()).ok, true);
  assert.equal((await service.probe({ id: 'after-closed' })).error.code, 'CLOSED');
});

test('shutdown cancels probes as well as runs and never admits a new lease', async () => {
  for (const kind of ['probe', 'run']) {
    const { service, operations } = controlled();
    const pending = service[kind]({ id: 'owned' });
    const stopping = service.shutdown();
    assert.equal(operations[0].request.signal.aborted, true);
    assert.equal((await service.probe({ id: 'after-shutdown' })).error.code, 'CLOSED');
    operations[0].reject(new LocalAiError('ABORTED', 'Cancelled.'));
    assert.equal((await pending).error.code, 'ABORTED');
    assert.deepEqual(await stopping, { ok: true, value: { closed: true } });
    assert.equal(service.status().value.active, null);
    assert.equal(service.status().value.ready, false);
    assert.deepEqual(await service.shutdown(), { ok: true, value: { closed: true } });
  }
});

test('unexpected errors are sanitized while known backend errors remain tagged', async () => {
  const { service, operations } = controlled();
  const pending = service.probe({ id: 'probe' });
  operations[0].reject(new Error('private path and configuration details'));
  assert.deepEqual(await pending, { ok: false, error: { code: 'WORKER', message: 'The local image worker failed unexpectedly.' } });
  const run = service.run({ id: 'run' });
  operations[1].reject(new LocalAiError('INPUT', 'Unsupported uniform image.'));
  assert.deepEqual(await run, { ok: false, error: { code: 'INPUT', message: 'Unsupported uniform image.' } });
});

test('production service, backend and transport recover after late close without rewriting failed operations', { timeout: 6000 }, async t => {
  for (const reason of ['TIMEOUT', 'ABORTED', 'release']) {
    const children = [];
    let notifications = 0;
    const service = createLocalAiService({ env: configuredEnv, onOwnershipReleased: () => { notifications++; }, createBackend: (config, hooks) => createLocalAi({
      ...config, timeoutMs: reason === 'TIMEOUT' ? 10 : 2000,
    }, {
      ...hooks,
      cleanupTimeoutMs: 20,
      readFile: async () => 'model-free transport fixture',
      spawnProcess() {
        const child = new EventEmitter();
        child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.exitCode = null; child.signalCode = null;
        child.close = () => { child.exitCode = 0; child.emit('close', 0); };
        children.push(child);
        // The first child deliberately leaves its streams open past cleanup's
        // deadline. Subsequent workers use the normal close path.
        child.kill = () => { if (children.length > 1) setImmediate(child.close); return true; };
        let input = Buffer.alloc(0), sourceRead = false;
        child.stdin.on('data', chunk => {
          input = Buffer.concat([input, chunk]);
          if (!sourceRead) {
            if (input.length < 4 || input.length < 4 + input.readUInt32BE(0)) return;
            const end = 4 + input.readUInt32BE(0);
            assert.equal(input.toString('utf8', 4, end), 'model-free transport fixture');
            input = input.subarray(end); sourceRead = true;
          }
          const newline = input.indexOf(10);
          if (newline < 0) return;
          const request = JSON.parse(input.toString('utf8', 0, newline));
          if (input.length < newline + 1 + request.payloadLength) return;
          input = Buffer.alloc(0);
          if (children.length === 1 && reason !== 'release') return;
          const metadata = request.operation === 'prepare' ? { model: 'efficientsam-ti',
            encoderSha256: SELECTION_HASHES.encoder, decoderSha256: SELECTION_HASHES.decoder } : {
            model: 'u2netp', modelSha256: MODEL_SHA256 };
          child.stdout.write(Buffer.from(JSON.stringify({ version: 2, id: request.id, operation: request.operation,
            ok: true, payloadLength: 0, width: 1, height: 1,
            metadata: { ...metadata, provider: 'CPUExecutionProvider', runtimeVersion: '1.24.4', elapsedMs: 1 } }) + '\n'));
        });
        return child;
      },
    }) });
    t.after(() => { for (const child of children) child.close(); });
    let pending, cancelling, session;
    if (reason === 'release') {
      const png = Buffer.alloc(33); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
      png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20);
      session = (await service.prepareSelection({ id: 'prepare', targetToken: 'document', png, width: 1, height: 1 })).value;
      pending = service.releaseSelection({ sessionId: session.sessionId });
    } else {
      pending = service.probe({ id: 'first' });
      await new Promise(resolve => setImmediate(resolve));
      if (reason === 'ABORTED') cancelling = service.cancel({ id: 'first' });
    }
    const failed = await pending, originalResult = structuredClone(failed);
    assert.equal(failed.error.code, reason === 'release' ? 'CLEANUP' : reason);
    if (cancelling) assert.equal((await cancelling).error.code, 'CLEANUP');
    assert.equal(service.status().value.cleanupBlocked, true);
    assert.equal(service.status().value.ownsProcess, true);
    assert.equal(service.status().value.active.id, session?.sessionId || 'first');
    assert.equal((await service.probe({ id: 'while-owned' })).error.code, 'CLEANUP');
    children[0].exitCode = 0; children[0].emit('exit', 0);
    assert.equal((await service.probe({ id: 'pipes-still-open' })).error.code, 'CLEANUP');
    assert.equal(children.length, 1, 'exit alone cannot authorize a replacement worker');
    assert.equal(notifications, 0);
    children[0].close();
    assert.equal(notifications, 1);
    assert.equal(service.status().value.cleanupBlocked, false);
    assert.equal(service.status().value.ownsProcess, false);
    assert.equal(service.status().value.active, null);
    assert.equal(service.status().value.retainedSelection, null);
    if (session) assert.equal((await service.selectObject({ id: 'old-image', sessionId: session.sessionId, targetToken: 'document' })).error.code, 'SESSION_EXPIRED');
    const next = await service.probe({ id: 'fresh-worker' });
    assert.equal(next.ok, true); assert.equal(next.value.modelSha256, MODEL_SHA256);
    assert.equal(children.length, 2);
    assert.deepEqual(failed, originalResult, 'the original failure remains failed after recovery');
    assert.equal((await service.shutdown()).ok, true);
  }
});

test('real configured service probes and shuts down with IPC-safe records', {
  skip: !process.env.PAINT_AI_TEST_PYTHON || !process.env.PAINT_AI_TEST_MODEL ? 'Provide approved local runtime/model paths to exercise the real worker.' : false,
}, async () => {
  const service = createLocalAiService({ env: {
    SJ_PAINT_PYTHON: process.env.PAINT_AI_TEST_PYTHON,
    SJ_PAINT_U2NETP_MODEL: process.env.PAINT_AI_TEST_MODEL,
  } });
  const result = await service.probe({ id: 'actual-probe' });
  assert.equal(result.ok, true); assert.equal(result.value.modelSha256, MODEL_SHA256);
  assert.deepEqual(structuredClone(result), result);
  assert.equal(service.status().value.ready, true);
  assert.equal((await service.shutdown()).ok, true);
  assert.equal(service.status().value.state, 'closed');
});


test('excluded modes and legacy diffusion configuration stay outside the public service contract', async () => {
  let calls = 0;
  const service = createLocalAiService({ configuration: { ...generationConfiguration,
    basePythonPath: process.execPath, baseModelPath: path.resolve('legacy-base'), baseAccelerator: 'cuda',
    coloringPythonPath: process.execPath, coloringModelPath: path.resolve('legacy-coloring'), coloringAccelerator: 'cuda' },
    createBackend: config => {
      assert.equal(config.basePythonPath, undefined); assert.equal(config.baseModelPath, undefined); assert.equal(config.baseAccelerator, undefined);
      assert.equal(config.coloringPythonPath, undefined); assert.equal(config.coloringModelPath, undefined); assert.equal(config.coloringAccelerator, undefined);
      return { state: () => ({ owned: false, blocked: false }), generate: async () => { calls++; }, releaseSelection: async () => {} };
    } });
  const status = service.status().value;
  assert.deepEqual(status.generation.modes, ['erase']);
  assert.deepEqual(Object.keys(status.generation.modelDetails).sort(), ['migan']);
  assert.deepEqual(status.generation.adapters, {});
  assert.equal(status.features['sdxl-coloring'], undefined); assert.equal(status.features['sdxl-base'], undefined);
  for (const mode of ['create', 'fill', 'cocreate', 'reimagine', 'sticker', 'coloring']) {
    assert.equal((await service.generate({ id: `excluded-${mode}`, targetToken: 'drawing', mode })).error.code, 'INPUT');
    assert.equal(status.generation.models[mode], undefined);
    assert.equal(status.generation.requirements[mode], undefined);
  }
  for (const feature of ['sdxl-base', 'sdxl-coloring']) assert.equal((await service.probe({ id: `excluded-${feature}`, feature })).error.code, 'INPUT');
  assert.equal(calls, 0);
  assert.equal((await service.shutdown()).ok, true);
});
