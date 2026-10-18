const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createHash } = require('node:crypto');
const { createWorkerProcess } = require('./local-ai-process.cjs');
const progressFrame = (extra = {}) => Buffer.from(JSON.stringify({ version: 2, id: 1, operation: 'generate', event: 'progress', payloadLength: 0,
  progress: { stage: 'denoise', completed: 1, total: 20 }, ...extra }) + '\n');

function fixture(t, settings = {}) {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.signalCode = null; child.kills = [];
  child.close = () => { child.exitCode = 0; child.emit('close', 0); };
  child.kill = signal => { child.kills.push(signal); setImmediate(child.close); return true; };
  let launch;
  const process = createWorkerProcess({ pythonPath: __filename, script: '', args: [], timeoutMs: 1000, ...settings }, {
    spawnProcess: (executable, args, options) => { launch = { executable, args, options }; return child; }, cleanupTimeoutMs: settings.cleanupTimeoutMs === null ? undefined : settings.cleanupTimeoutMs ?? 20,
    onOwnershipReleased: settings.onOwnershipReleased,
  });
  t.after(() => child.close());
  return { process, child, launch, reply(id, operation, payload = Buffer.alloc(0)) { return Buffer.concat([Buffer.from(JSON.stringify({ version: 2, id, operation, ok: true, payloadLength: payload.length }) + '\n'), payload]); } };
}

test('worker environment satisfies the Windows Torch PATH lookup without inheriting host search paths', async t => {
  const f = fixture(t), environment = f.launch.options.env;
  assert.deepEqual(Object.keys(environment).filter(key => !['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH'].includes(key)), []);
  if (process.platform === 'win32') {
    assert.equal(environment.PATH, '');
  } else assert.equal(Object.hasOwn(environment, 'PATH'), false);
  await f.process.close(); assert.equal(f.process.state().owned, false);
});

test('source bytes precede framed requests without entering the command line', async t => {
  const script = '# non-ASCII: æ猫\n' + '# padding\n'.repeat(5000);
  const f = fixture(t, { script, args: ['model-name', 'a path with spaces'] });
  const chunks = []; f.child.stdin.on('data', chunk => chunks.push(chunk));
  const first = f.process.request('probe', {}, Buffer.from([0, 10, 255]), 0);
  await new Promise(resolve => setImmediate(resolve));
  const input = Buffer.concat(chunks), source = Buffer.from(script, 'utf8');
  assert(f.launch.args[4].length < 1024);
  assert(!f.launch.args.includes(script));
  assert.deepEqual(f.launch.args.slice(5), ['model-name', 'a path with spaces']);
  assert.equal(input.readUInt32BE(0), source.length);
  assert.deepEqual(input.subarray(4, 4 + source.length), source);
  const requestOffset = 4 + source.length, newline = input.indexOf(10, requestOffset);
  assert.equal(JSON.parse(input.toString('utf8', requestOffset, newline)).operation, 'probe');
  assert.deepEqual(input.subarray(newline + 1), Buffer.from([0, 10, 255]));
  f.child.stdout.write(f.reply(1, 'probe')); await first; await f.process.close();
});

test('real Python executes source larger than the Windows command line and preserves framing, argv and cancellation', {
  skip: !process.env.PAINT_AI_PROTOCOL_PYTHON ? 'Provide PAINT_AI_PROTOCOL_PYTHON for the model-free real transport check.' : false,
  timeout: 10000,
}, async t => {
  const script = '# UTF-8 source: æ猫\n'.repeat(4000) + `
import sys, json, hashlib, time
marker = 'æ猫'
while True:
    line = sys.stdin.buffer.readline()
    if not line: break
    request = json.loads(line)
    payload = sys.stdin.buffer.read(request['payloadLength'])
    response = dict(version=2, id=request['id'], operation=request['operation'])
    if request['operation'] == 'wait':
        progress = dict(response, event='progress', payloadLength=0, progress=dict(stage='waiting', completed=0, total=1))
        sys.stdout.buffer.write((json.dumps(progress)+'\\n').encode()); sys.stdout.buffer.flush()
        time.sleep(60)
    result = json.dumps(dict(argv=sys.argv[1:], marker=marker, sha256=hashlib.sha256(payload).hexdigest())).encode()
    response.update(ok=True, payloadLength=len(result))
    sys.stdout.buffer.write((json.dumps(response)+'\\n').encode()+result); sys.stdout.buffer.flush()
`;
  assert(Buffer.byteLength(script) > 65536);
  let releases = 0;
  const owner = createWorkerProcess({ pythonPath: process.env.PAINT_AI_PROTOCOL_PYTHON, script,
    args: ['model-name', 'path with spaces', '猫'], timeoutMs: 5000 }, { onOwnershipReleased() { releases++; } });
  t.after(async () => { try { await owner.close(); } catch { /* Test below checks the original cancellation. */ } });
  for (const payload of [Buffer.from([0, 10, 255, 13, 0]), Buffer.from('second frame')]) {
    const response = await owner.request('echo', {}, payload, 1024);
    assert.deepEqual(JSON.parse(response.payload), { argv: ['model-name', 'path with spaces', '猫'], marker: 'æ猫',
      sha256: createHash('sha256').update(payload).digest('hex') });
  }
  const cancellation = new AbortController();
  const pending = owner.request('wait', {}, Buffer.alloc(0), 1024, cancellation.signal, () => cancellation.abort());
  await assert.rejects(pending, { code: 'ABORTED' });
  assert.equal(owner.state().owned, false);
  assert.equal(releases, 1, 'Cancellation waits for the actual child/streams close');
});

test('persistent framing reassembles split headers and payloads across two commands', async t => {
  const f = fixture(t);
  const first = f.process.request('prepare', {}, Buffer.alloc(0), 0);
  const a = f.reply(1, 'prepare'); f.child.stdout.write(a.subarray(0, 7)); f.child.stdout.write(a.subarray(7));
  assert.equal((await first).header.operation, 'prepare');
  const next = f.process.request('select', {}, Buffer.alloc(0), 3);
  const b = f.reply(2, 'select', Buffer.from([0, 255, 0])); f.child.stdout.write(b.subarray(0, -1)); f.child.stdout.write(b.subarray(-1));
  assert.deepEqual((await next).payload, Buffer.from([0, 255, 0]));
  await f.process.close(); assert.deepEqual(f.child.kills, ['SIGKILL']);
});

test('foreign response IDs and duplicate frames terminate only the owned worker', async t => {
  for (const wrong of ['id', 'duplicate', 'stderr']) {
    const f = fixture(t); const pending = f.process.request('probe', {}, Buffer.alloc(0), 0);
    const rejection = assert.rejects(pending, { code: 'PROTOCOL' });
    if (wrong === 'stderr') f.child.stderr.write(Buffer.alloc(16385));
    else f.child.stdout.write(wrong === 'id' ? f.reply(2, 'probe') : Buffer.concat([f.reply(1, 'probe'), f.reply(1, 'probe')]));
    await rejection; assert.deepEqual(f.child.kills, ['SIGKILL']);
  }
});

test('aborting a request waits for close and cleanup failure remains owned', async t => {
  let notifications = 0;
  const f = fixture(t, { onOwnershipReleased: () => { notifications++; assert.equal(f.process.state().owned, false); } }); f.child.kill = () => false;
  const controller = new AbortController();
  const pending = f.process.request('select', {}, Buffer.alloc(0), 0, controller.signal);
  const rejection = assert.rejects(pending, { code: 'ABORTED' }); controller.abort();
  await rejection; assert.equal(f.process.state().owned, true);
  await assert.rejects(f.process.request('probe', {}, Buffer.alloc(0), 0), { code: 'CLEANUP' });
  f.child.exitCode = 0; f.child.emit('exit', 0);
  assert.equal(f.process.state().blocked, true, 'exit without stdio close still owns cleanup');
  assert.equal(notifications, 0, 'timeout and exit alone cannot announce ownership release');
  f.child.close();
  assert.equal(f.process.state().owned, false);
  assert.equal(f.process.state().blocked, false);
  assert.equal(f.process.state().error.code, 'ABORTED', 'late closure does not rewrite the failed operation');
  f.child.close();
  assert.equal(notifications, 1, 'one actual ownership release emits one notification');
});

test('exited child with lingering pipes still gets a bounded cleanup deadline', async t => {
  const f = fixture(t, { timeoutMs: 10 }); f.child.exitCode = 0;
  await assert.rejects(f.process.request('probe', {}, Buffer.alloc(0), 0), { code: 'TIMEOUT' });
  assert.equal(f.process.state().owned, true); assert.deepEqual(f.child.kills, []);
});

test('normal close after the former one-second deadline stays owned and resolves within production grace', async t => {
  const f = fixture(t, { cleanupTimeoutMs: null });
  f.child.kill = () => { setTimeout(f.child.close, 1150); return true; };
  const closing = f.process.close();
  await new Promise(resolve => setTimeout(resolve, 1050));
  assert.equal(f.process.state().owned, true);
  assert.equal(f.process.state().blocked, false);
  await closing;
  assert.equal(f.process.state().owned, false);
  assert.equal(f.process.state().cleanupError, null);
});

test('a large mask fragmented into many chunks copies each payload chunk only once', async t => {
  const f = fixture(t); const size = 1024 * 1024;
  const pending = f.process.request('select', {}, Buffer.alloc(0), size);
  const originalConcat = Buffer.concat; let concatenatedBytes = 0;
  Buffer.concat = (chunks, ...args) => { concatenatedBytes += chunks.reduce((sum, item) => sum + item.length, 0); return originalConcat(chunks, ...args); };
  try {
    f.child.stdout.write(Buffer.from(JSON.stringify({ version: 2, id: 1, operation: 'select', ok: true, payloadLength: size }) + '\n'));
    const chunk = Buffer.alloc(1024, 255);
    for (let offset = 0; offset < size; offset += chunk.length) f.child.stdout.write(chunk);
  } finally { Buffer.concat = originalConcat; }
  const result = await pending;
  assert.equal(result.payload.length, size); assert.equal(result.payload[size - 1], 255);
  assert.ok(concatenatedBytes < 4096, `Header concat copied ${concatenatedBytes} bytes; payload must use direct copies.`);
  await f.process.close();
});

test('progress can be fragmented or coalesced with the final PNG without entering result bytes', async t => {
  const f = fixture(t), updates = [], bytes = Buffer.from([1, 10, 3]);
  const pending = f.process.request('generate', {}, Buffer.alloc(0), bytes.length, undefined, value => { updates.push(value); throw new Error('observer'); });
  const first = progressFrame();
  for (const byte of first) f.child.stdout.write(Buffer.from([byte]));
  f.child.stdout.write(Buffer.concat([progressFrame({ progress: { stage: 'encode', completed: 1, total: 1 } }), f.reply(1, 'generate', bytes)]));
  assert.deepEqual((await pending).payload, bytes);
  assert.deepEqual(updates, [{ stage: 'denoise', completed: 1, total: 20 }, { stage: 'encode', completed: 1, total: 1 }]);
  await f.process.close();
});

test('foreign, malformed and excessive progress closes the owned process', async t => {
  for (const bytes of [progressFrame({ id: 7 }), progressFrame({ payloadLength: 1 }), progressFrame({ progress: { stage: 'denoise', completed: 2, total: 1 } }), Buffer.concat(Array.from({ length: 257 }, () => progressFrame()))]) {
    const f = fixture(t), pending = f.process.request('generate', {}, Buffer.alloc(0), 0);
    const rejected = assert.rejects(pending, { code: 'PROTOCOL' });
    f.child.stdout.write(bytes); await rejected;
    assert.deepEqual(f.child.kills, ['SIGKILL']);
  }
});

test('progress cannot reset a deadline or prevent cancellation', async t => {
  for (const cancel of [false, true]) {
    const f = fixture(t, { timeoutMs: cancel ? 1000 : 30 }), controller = new AbortController();
    const pending = f.process.request('generate', {}, Buffer.alloc(0), 0, controller.signal);
    const rejected = assert.rejects(pending, { code: cancel ? 'ABORTED' : 'TIMEOUT' });
    const timer = setInterval(() => { if (!f.process.state().closing) f.child.stdout.write(progressFrame()); }, 5);
    try { if (cancel) controller.abort(); await rejected; } finally { clearInterval(timer); }
    assert.deepEqual(f.child.kills, ['SIGKILL']);
  }
});
