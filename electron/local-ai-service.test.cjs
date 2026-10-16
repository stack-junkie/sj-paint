const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { LocalAiError, MODEL_SHA256 } = require('./local-ai.cjs');
const { createLocalAiService } = require('./local-ai-service.cjs');

const configuredEnv = { SJ_PAINT_PYTHON: process.execPath, SJ_PAINT_U2NETP_MODEL: path.resolve('approved-model.onnx') };
function controlled() {
  const operations = [];
  const start = (kind, request) => new Promise((resolve, reject) => operations.push({ kind, request, resolve, reject }));
  const service = createLocalAiService({ env: configuredEnv, createBackend: () => ({
    probe: request => start('probe', request), run: request => start('run', request),
  }) });
  return { service, operations };
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

test('failed cleanup permanently blocks the owner and retains the unresolved operation identity', async () => {
  const { service, operations } = controlled();
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
