const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createLocalAi, MODEL_SHA256, BACKGROUND_MODELS, SELECTION_HASHES, REMOVAL_SHA256, generationModel } = require('./local-ai.cjs');

const config = { pythonPath: process.execPath, modelPath: path.resolve('local-test-model.onnx') };
const metadata = { model: 'u2netp', modelSha256: MODEL_SHA256, provider: 'CPUExecutionProvider', runtimeVersion: '1.24.4' };
const header = (extra = {}) => Buffer.from(JSON.stringify({ version: 2, id: 1, operation: 'probe', payloadLength: 0, ok: true, metadata, ...extra }) + '\n');
const generationConfig = { pythonPath: process.execPath, removalModelPath: path.resolve('migan.onnx') };
const generationMetadata = { model: 'migan', modelSha256: REMOVAL_SHA256, provider: 'CPUExecutionProvider', runtimeVersion: '1.24.4', elapsedMs: 2, conditioningMargin: 3 };

const generationInput = { targetToken: 'doc-1-layer-2', mode: 'erase', prompt: '', png: png(64, 64), mask: png(64, 64), width: 64, height: 64, seed: 42 };

test('erase uses the owned ONNX worker without SDXL and rejects prompts and forged model identity', async t => {
  const removalMetadata = { model: 'migan', modelSha256: REMOVAL_SHA256, provider: 'CPUExecutionProvider', runtimeVersion: '1.24.4', elapsedMs: 2, conditioningMargin: 3 };
  const input = { ...generationInput, mode: 'erase', prompt: '', png: png(64,64), mask: png(64,64) };
  for (const [patch, expected] of [[{}, null], [{ model: 'sdxl' }, 'PROTOCOL'], [{ conditioningMargin: 4 }, 'PROTOCOL'], [{ effectiveStrength: .99 }, 'PROTOCOL']]) {
    const f = fakeWorker(t, (child, _payload, request) => {
      const output = png(64,64);
      child.stdout.write(header({ id: request.id, operation: 'generate', width:64, height:64, targetToken:request.targetToken,
        mode:request.mode, seed:request.seed, payloadLength:output.length, metadata:{...removalMetadata,...patch} }));
      child.stdout.write(output);
    }, { modelPath: undefined, removalModelPath: path.resolve('migan.onnx') });
    if (expected) await assert.rejects(f.backend.generate(input), { code: expected });
    else {
      const result = await f.backend.generate(input);
      assert.equal(result.metadata.model, 'migan'); assert.equal(result.metadata.requestedStrength, undefined);
      assert.equal(f.spawnArgs[1][5], 'migan'); assert.equal(f.backend.state().owned, true);
      await f.backend.releaseSelection(); assert.equal(f.backend.state().owned, false);
    }
  }
  let spawned=false;
  const backend=createLocalAi({pythonPath:process.execPath,removalModelPath:path.resolve('migan.onnx')},{spawnProcess(){spawned=true;}});
  for (const patch of [{prompt:'wall'},{negativePrompt:'no objects'},{prompt:' '}]) await assert.rejects(backend.generate({...input,...patch}),{code:'INPUT'});
  assert.equal(spawned,false); assert.equal(generationModel('erase'),'migan'); assert.equal(generationModel('fill'),undefined);
});

function fakeWorker(t, onInput, options = {}) {
  let child, spawnArgs;
  const backend = createLocalAi({ ...config, ...options }, {
    cleanupTimeoutMs: 20,
    readFile: async () => 'worker source',
    spawnProcess(...args) {
      spawnArgs = args;
      child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.exitCode = null; child.signalCode = null; child.kills = [];
      child.close = code => { child.exitCode = code; child.emit('close', code); };
      child.kill = signal => { child.kills.push(signal); setImmediate(() => child.close(null)); return true; };
      let input = Buffer.alloc(0), sourceRead = false;
      child.stdin.on('data', chunk => {
        input = Buffer.concat([input, chunk]);
        if (!sourceRead) {
          if (input.length < 4 || input.length < 4 + input.readUInt32BE(0)) return;
          const end = 4 + input.readUInt32BE(0);
          assert.equal(input.toString('utf8', 4, end), 'worker source');
          input = input.subarray(end); sourceRead = true;
        }
        const newline = input.indexOf(10);
        if (newline < 0) return;
        const request = JSON.parse(input.toString('utf8', 0, newline));
        if (input.length !== newline + 1 + request.payloadLength) return;
        const payload = input.subarray(newline + 1); input = Buffer.alloc(0);
        onInput(child, payload, request);
      });
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
  assert.equal(args[5], 'u2netp');
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
  const expectedEnvironment = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
  if (process.platform === 'win32') expectedEnvironment.PATH = '';
  assert.deepEqual(options.env, expectedEnvironment);
});

test('PNG bounds and dimensions are rejected before a child can start', async () => {
  let spawned = false;
  const backend = createLocalAi(config, { spawnProcess: () => { spawned = true; } });
  await assert.rejects(backend.run({ png: Buffer.alloc(33), width: 1, height: 1 }), { code: 'INPUT' });
  await assert.rejects(backend.run({ png: Buffer.alloc(33), width: 16000001, height: 1 }), { code: 'INPUT' });
  assert.equal(spawned, false);
});

test('full background model is explicitly selected and cannot accept the legacy model identity', async t => {
  const full = { ...metadata, model: 'u2net', modelSha256: BACKGROUND_MODELS.u2net };
  const fixture = fakeWorker(t, child => { child.stdout.write(header({ metadata: full })); child.close(0); }, { backgroundModelId: 'u2net' });
  assert.deepEqual(await fixture.backend.probe(), full);
  assert.equal(fixture.spawnArgs[1][5], 'u2net');
  const wrong = fakeWorker(t, child => { child.stdout.write(header()); child.close(0); }, { backgroundModelId: 'u2net' });
  await assert.rejects(wrong.backend.probe(), { code: 'PROTOCOL' });
  assert.throws(() => createLocalAi({ ...config, backgroundModelId: 'unapproved' }), { code: 'CONFIG' });
});

test('deterministic matte metadata preserves its distinct provenance and rejects fabricated model ranges', async t => {
  const matte = { method: 'flat-drawing-border-flood', paperRgb: [242,230,190], unmixEdges: true,
    borderAgreement: 1, foregroundFlatColorFraction: .8, antialiasEdgeSupport: 1, connectivity: 4, preservesEnclosedInteriors: true };
  for (const [extra, code] of [[{}, null], [{ rawMin: 0, rawMax: 1 }, 'PROTOCOL'], [{ modelExecuted: true }, 'PROTOCOL'],
    [{ matte: { ...matte, paperRgb: [256,0,0] } }, 'PROTOCOL'], [{ matte: { ...matte, unmixEdges: false } }, 'PROTOCOL']]) {
    const fixture = fakeWorker(t, (child, _payload, request) => {
      child.stdout.write(header({ id: request.id, operation: 'run', width: 16, height: 16, payloadLength: 256,
        metadata: { ...metadata, elapsedMs: 1, modelExecuted: false, matte, ...extra } }));
      child.stdout.write(Buffer.alloc(256,128));
    });
    const pending = fixture.backend.run({ png: png(16,16), width:16,height:16 });
    if (code) await assert.rejects(pending,{code});
    else { const result = await pending; assert.deepEqual(result.metadata.matte,matte); assert.equal(result.metadata.rawMin,undefined); }
  }
});

test('sigmoid metadata permits one float32 endpoint ULP while retaining observed values', async t => {
  for (const [rawMax, accepted] of [[1 + 2 ** -23,true],[1 + 2 ** -22,false]]) {
    const fixture = fakeWorker(t, (child,_payload,request) => {
      child.stdout.write(header({id:request.id,operation:'run',width:16,height:16,payloadLength:256,
        metadata:{...metadata,elapsedMs:1,rawMin:0,rawMax,modelExecuted:true,matte:{method:'model-saliency'}}}));
      child.stdout.write(Buffer.alloc(256,128));
    });
    const result = fixture.backend.run({png:png(16,16),width:16,height:16});
    if (accepted) assert.equal((await result).metadata.rawMax,rawMax);
    else await assert.rejects(result,{code:'PROTOCOL'});
  }
});

test('generation bounds reject invalid modes, controls, images and oversized prompts before spawning', async () => {
  let spawned = false;
  const backend = createLocalAi(generationConfig, { spawnProcess: () => { spawned = true; } });
  for (const patch of [{ mode: 'unknown' }, { width: 65 }, { height: 1032 }, { seed: -1 }, { seed: 2 ** 32 }, { prompt: 'unexpected' },
    { prompt: 'a'.repeat(1537) }, { negativePrompt: 'é'.repeat(257) }, { steps: 0 }, { steps: 51 }, { strength: 0 }, { guidance: NaN },
    { png: png(72, 64) }, { mask: undefined }, { mode: 'fill', png: png(64, 64), mask: png(72, 64) },
    { mode: 'cocreate', png: png(64, 64), strength: .01, steps: 20 }]) {
    await assert.rejects(backend.generate({ ...generationInput, ...patch }), { code: 'INPUT' });
  }
  assert.equal(spawned, false);
});

test('erase transports progress and retains one worker until explicit release', async t => {
  const source = png(64, 64), mask = png(64, 64), original = Buffer.concat([source, mask]), output = png(64, 64), updates = [];
  let commands = 0;
  const fixture = fakeWorker(t, (child, payload, request) => {
    commands++;
    if (commands === 1) assert.deepEqual(payload, original);
    child.stdout.write(Buffer.from(JSON.stringify({ version: 2, id: request.id, operation: 'generate', event: 'progress', payloadLength: 0,
      progress: { stage: 'denoise', completed: 1, total: 20 } }) + '\n'));
    child.stdout.write(Buffer.concat([header({ id: request.id, operation: 'generate', width: 64, height: 64, mode: request.mode,
      seed: request.seed, targetToken: request.targetToken, metadata: generationMetadata, payloadLength: output.length }), output]));
  }, generationConfig);
  const pending = fixture.backend.generate({ ...generationInput, png: source, mask, mode: 'erase', onProgress: value => updates.push(value) });
  source.fill(0); mask.fill(0);
  const result = await pending;
  assert.deepEqual(Buffer.from(result.png), output); assert.equal(result.targetToken, generationInput.targetToken);
  assert.equal(fixture.backend.state().feature, 'migan'); assert.equal(fixture.backend.state().owned, true);
  const child = fixture.child;
  await fixture.backend.generate({ ...generationInput, mode: 'erase' });
  assert.equal(fixture.child, child); assert.equal(commands, 2); assert.equal(updates.length, 1);
  await fixture.backend.releaseSelection(); assert.equal(fixture.backend.state().owned, false);
});

test('erase refuses results from another target, seed or configured model identity', async t => {
  const output = png(64, 64);
  for (const patch of [{ targetToken: 'foreign' }, { seed: 43 },
    { metadata: { ...generationMetadata, modelSha256: 'unverified' } },
    { metadata: { ...generationMetadata, conditioningMargin: 4 } },
    { metadata: { ...generationMetadata, effectiveStrength: .5 } }]) {
    const fixture = fakeWorker(t, (child, _payload, request) => {
      child.stdout.write(Buffer.concat([header({ operation: 'generate', width: 64, height: 64, mode: request.mode, seed: request.seed,
        targetToken: request.targetToken, metadata: generationMetadata, payloadLength: output.length, ...patch }), output]));
    }, generationConfig);
    await assert.rejects(fixture.backend.generate(generationInput), { code: 'PROTOCOL' });
    assert.equal(fixture.backend.state().owned, false);
  }
});

test('cancellation while loading worker source never starts a child', async () => {
  let loaded, spawned = false;
  const backend = createLocalAi(config, { readFile: () => new Promise(resolve => { loaded = resolve; }), spawnProcess: () => { spawned = true; } });
  const controller = new AbortController();
  const pending = backend.probe({ signal: controller.signal });
  const rejection = assert.rejects(pending, { code: 'ABORTED' });
  controller.abort(); loaded('worker source');
  await rejection; assert.equal(spawned, false);
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

test('timeout retains its cause while failed cleanup blocks work until confirmed late close', async t => {
  const fixture = fakeWorker(t, child => { child.kill = () => false; }, { timeoutMs: 10 });
  await assert.rejects(fixture.backend.probe(), { code: 'TIMEOUT' });
  await assert.rejects(fixture.backend.probe(), { code: 'CLEANUP' });
  assert.equal(fixture.backend.state().owned, true);
  fixture.child.close(1);
  assert.equal(fixture.backend.state().blocked, false);
  const again = fixture.backend.probe();
  await new Promise(resolve => setImmediate(resolve));
  fixture.child.stdout.write(header()); fixture.child.close(0);
  assert.deepEqual(await again, metadata);
});

test('already exited children with lingering streams have a bounded cleanup wait', { timeout: 4000 }, async t => {
  for (const exitedBy of ['exitCode', 'signalCode']) {
    const fixture = fakeWorker(t, child => { child[exitedBy] = exitedBy === 'exitCode' ? 0 : 'SIGTERM'; }, { timeoutMs: 10 });
    await assert.rejects(fixture.backend.probe(), { code: 'TIMEOUT' });
    assert.deepEqual(fixture.child.kills, []);
    await assert.rejects(fixture.backend.probe(), { code: 'CLEANUP' });
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
function png(width, height, transparent = false, uniform = false, adjacent = false) {
  const chunk = (type, body) => {
    const result = Buffer.alloc(12 + body.length); result.writeUInt32BE(body.length);
    result.write(type, 4); body.copy(result, 8); result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
    return result;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 4 + 1) + 1 + x * 4;
    const subject = !uniform && (adjacent ? Math.min((x - width / 3) ** 2, (x - width * 2 / 3) ** 2) + (y - height / 2) ** 2 < (height / 3) ** 2 : (x - width / 2) ** 2 + (y - height / 2) ** 2 < (width / 4) ** 2);
    raw[offset] = subject ? 220 : 240; raw[offset + 1] = subject ? 35 : 240; raw[offset + 2] = subject ? 45 : 240;
    if (subject && adjacent && x > width / 2) { raw[offset] = 35; raw[offset + 1] = 55; raw[offset + 2] = 220; }
    raw[offset + 3] = transparent ? 0 : 255;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('run accepts only an exact-sized mask and snapshots input before asynchronous work', async t => {
  const input = png(16, 16); const original = Buffer.from(input);
  const fixture = fakeWorker(t, (child, received) => {
    assert.deepEqual(received, original);
    child.stdout.write(header({ operation: 'run', payloadLength: 256, width: 16, height: 16, metadata: { ...metadata, elapsedMs: 1, rawMin: 0, rawMax: 1 } }));
    child.stdout.write(Buffer.alloc(255)); child.close(0);
  });
  const result = fixture.backend.run({ png: input, width: 16, height: 16 });
  input.fill(0);
  await assert.rejects(result, { code: 'PROTOCOL' });
});

test('selection retains one worker, validates prompts and binds reuse to the prepared target', async t => {
  let prepares = 0, selects = 0;
  const selectionMetadata = { model: 'efficientsam-ti', encoderSha256: SELECTION_HASHES.encoder, decoderSha256: SELECTION_HASHES.decoder, provider: 'CPUExecutionProvider', runtimeVersion: '1.24.4', elapsedMs: 1 };
  const fixture = fakeWorker(t, (child, payload, request) => {
    if (request.operation === 'prepare') { prepares++; assert.deepEqual(payload, png(16, 16)); }
    else { selects++; assert.deepEqual(request.labels, [1, 0, 2, 3]); }
    const refinement = { method: 'object-mask-subtraction', excludedObjects: 1, empty: false, candidates: [{ scores: [0.8, 0.2, 0.3], selectedCandidate: 0 }] };
    child.stdout.write(header({ id: request.id, operation: request.operation, metadata: { ...selectionMetadata, ...(request.operation === 'select' ? { refinement } : {}) }, width: 16, height: 16, payloadLength: request.operation === 'select' ? 768 : 0, scores: [0.5, 1.01, 0.8], selectedCandidate: 1 }));
    if (request.operation === 'select') child.stdout.write(Buffer.concat([Buffer.alloc(256), Buffer.alloc(256, 1), Buffer.from(Array.from({length:256},(_,index)=>index%2))]));
  }, { encoderPath: path.resolve('encoder.onnx'), decoderPath: path.resolve('decoder.onnx') });
  const prepareRequest = { sessionId: 'session', targetToken: 'target', png: png(16, 16), width: 16, height: 16 };
  const preparing = fixture.backend.prepareSelection(prepareRequest);
  prepareRequest.targetToken = 'changed-after-call';
  await preparing;
  assert.equal(fixture.backend.state().owned, true);
  await assert.rejects(fixture.backend.probe(), { code: 'BUSY' });
  await assert.rejects(fixture.backend.selectObject({ sessionId: 'session', targetToken: 'wrong', prompts: { points: [{ x: 2, y: 2 }] } }), { code: 'SESSION_EXPIRED' });
  for (const prompts of [{ points: [{ x: NaN, y: 2 }] }, { points: Array(7).fill({ x: 2, y: 2 }) }, { points: [{ x: 2, y: 2, negative: true }] }, { points: [{ x: 2, y: 2, label: 0 }] }, { points: [], box: { x1: 4, x2: 2, y1: 0, y2: 4 } }]) {
    await assert.rejects(fixture.backend.selectObject({ sessionId: 'session', targetToken: 'target', prompts }), { code: 'INPUT' });
  }
  const result = await fixture.backend.selectObject({ sessionId: 'session', targetToken: 'target', prompts: { points: [{ x: 2, y: 2 }, { x: 14, y: 14, label: 0 }], box: { x1: 0, y1: 0, x2: 15, y2: 15 } } });
  assert.equal(result.mask.length, 256); assert.equal(result.scores[1], 1.01);
  assert.equal(result.candidates.length, 3); assert.equal(result.mask, result.candidates[1]);
  assert.ok(result.candidates[0].every(value => value === 0));
  assert.ok(result.candidates[2].every((value,index) => value === index % 2));
  assert.equal(result.metadata.refinement.method, 'object-mask-subtraction');
  assert.equal(result.metadata.refinement.excludedObjects, 1);
  assert.equal(prepares, 1); assert.equal(selects, 1);
  await fixture.backend.releaseSelection(); assert.equal(fixture.backend.state().owned, false);
});

test('selection rejects malformed alternatives including unused nonbinary planes', async t => {
  const selectionMetadata = { model:'efficientsam-ti',encoderSha256:SELECTION_HASHES.encoder,decoderSha256:SELECTION_HASHES.decoder,provider:'CPUExecutionProvider',runtimeVersion:'1.24.4',elapsedMs:1 };
  for (const malformed of ['short','extra','nonbinary','wrong-default']) {
    const fixture = fakeWorker(t,(child,_payload,request) => {
      const selecting=request.operation==='select';
      const payload=Buffer.alloc(selecting ? malformed==='short' ? 256 : malformed==='extra' ? 1024 : 768 : 0,1);
      if(selecting&&malformed==='nonbinary')payload[700]=2;
      child.stdout.write(header({id:request.id,operation:request.operation,width:16,height:16,metadata:selectionMetadata,payloadLength:payload.length,scores:[.1,.9,.3],selectedCandidate:malformed==='wrong-default'?2:1}));
      if(payload.length)child.stdout.write(payload);
    },{encoderPath:path.resolve('encoder.onnx'),decoderPath:path.resolve('decoder.onnx')});
    await fixture.backend.prepareSelection({sessionId:'session',targetToken:'target',png:png(16,16),width:16,height:16});
    await assert.rejects(fixture.backend.selectObject({sessionId:'session',targetToken:'target',prompts:{points:[{x:4,y:4}]}}),{code:'PROTOCOL'},malformed);
    assert.equal(fixture.backend.state().owned,false);
  }
});

test('selection input bounds reject before spawn and an exited idle image can be replaced', async t => {
  let prepares = 0;
  const fixture = fakeWorker(t, (child, payload, request) => {
    prepares++;
    child.stdout.write(header({ id: request.id, operation: 'prepare', width: 16, height: 16,
      metadata: { model: 'efficientsam-ti', encoderSha256: SELECTION_HASHES.encoder, decoderSha256: SELECTION_HASHES.decoder, provider: 'CPUExecutionProvider', runtimeVersion: '1.24.4', elapsedMs: 1 } }));
  }, { encoderPath: path.resolve('encoder.onnx'), decoderPath: path.resolve('decoder.onnx') });
  await assert.rejects(fixture.backend.prepareSelection({ sessionId: 'one', targetToken: 'target', png: png(16, 16), width: 1025, height: 16 }), { code: 'INPUT' });
  await assert.rejects(fixture.backend.prepareSelection({ sessionId: 'one', targetToken: 'target', png: new Uint8Array(8 * 1024 * 1024 + 1), width: 16, height: 16 }), { code: 'INPUT' });
  assert.equal(fixture.child, undefined);
  await fixture.backend.prepareSelection({ sessionId: 'one', targetToken: 'target', png: png(16, 16), width: 16, height: 16 });
  fixture.child.close(1);
  assert.equal(fixture.backend.state().retained, null);
  await fixture.backend.prepareSelection({ sessionId: 'two', targetToken: 'target', png: png(16, 16), width: 16, height: 16 });
  assert.equal(prepares, 2); await fixture.backend.releaseSelection();
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

test('real selection reuses one embedding for positive points and boxes, then releases and cancels', {
  skip: !pythonPath || !process.env.PAINT_AI_TEST_ENCODER || !process.env.PAINT_AI_TEST_DECODER ? 'Provide approved EfficientSAM paths for real CPU inference.' : false,
  timeout: 90_000,
}, async t => {
  const backend = createLocalAi({ pythonPath, modelPath, encoderPath: process.env.PAINT_AI_TEST_ENCODER, decoderPath: process.env.PAINT_AI_TEST_DECODER });
  t.after(async () => { await backend.releaseSelection(); });
  const source = png(256, 128, false, false, true);
  const prepared = await backend.prepareSelection({ sessionId: 'actual', targetToken: 'drawing', png: source, width: 256, height: 128 });
  assert.equal(prepared.metadata.encoderSha256, SELECTION_HASHES.encoder);
  assert.equal(backend.state().owned, true);
  const left = await backend.selectObject({ sessionId: 'actual', targetToken: 'drawing', prompts: { points: [{ x: 85, y: 64 }] } });
  const right = await backend.selectObject({ sessionId: 'actual', targetToken: 'drawing', prompts: { points: [{ x: 170, y: 64 }] } });
  const box = await backend.selectObject({ sessionId: 'actual', targetToken: 'drawing', prompts: { points: [], box: { x1: 125, y1: 20, x2: 214, y2: 108 } } });
  for (const result of [left, right, box]) { assert.equal(result.mask.length, 256 * 128); assert.ok(result.mask.every(value => value === 0 || value === 1)); }
  assert.equal(left.mask[64 * 256 + 85], 1); assert.equal(left.mask[64 * 256 + 170], 0);
  assert.equal(right.mask[64 * 256 + 170], 1); assert.equal(right.mask[64 * 256 + 85], 0);
  assert.equal(box.mask[64 * 256 + 170], 1);
  t.diagnostic(JSON.stringify({ prepareMs: prepared.metadata.elapsedMs, leftMs: left.metadata.elapsedMs, rightMs: right.metadata.elapsedMs, boxMs: box.metadata.elapsedMs }));
  const selectController = new AbortController();
  const selecting = backend.selectObject({ sessionId: 'actual', targetToken: 'drawing', prompts: { points: [{ x: 85, y: 64 }] }, signal: selectController.signal });
  const selectCancelled = assert.rejects(selecting, { code: 'ABORTED' }); selectController.abort(); await selectCancelled;
  assert.equal(backend.state().owned, false);
  await backend.releaseSelection(); assert.equal(backend.state().owned, false);
  await assert.rejects(backend.selectObject({ sessionId: 'actual', targetToken: 'drawing', prompts: { points: [{ x: 85, y: 64 }] } }), { code: 'SESSION_EXPIRED' });
  const controller = new AbortController();
  const pending = backend.prepareSelection({ sessionId: 'cancelled', targetToken: 'drawing', png: source, width: 256, height: 128, signal: controller.signal });
  const cancelled = assert.rejects(pending, { code: 'ABORTED' }); setTimeout(() => controller.abort(), 100); await cancelled;
  assert.equal(backend.state().owned, false);
  if (modelPath) assert.equal((await backend.probe()).modelSha256, MODEL_SHA256);
});


test('release exclusion rejects every unfinished mode before process creation', async t => {
  const f = fakeWorker(t, () => { throw new Error('Excluded request reached worker.'); }, generationConfig);
  for (const mode of ['create', 'fill', 'cocreate', 'reimagine', 'sticker', 'coloring']) {
    await assert.rejects(f.backend.generate({ ...generationInput, mode }), { code: 'INPUT' });
    assert.equal(generationModel(mode), undefined);
  }
  await assert.rejects(f.backend.probe({ feature: 'sdxl' }), { code: 'INPUT' });
  assert.equal(f.child, undefined);
});
