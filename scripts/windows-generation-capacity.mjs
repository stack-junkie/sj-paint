import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ownedStreams = new Set();
export const pendingCapacityStreams = () => [...ownedStreams];

export function parseSingleGpuCapacity(stdout, visibleDevices) {
  const rows=stdout.trim().split(/\r?\n/).filter(Boolean);
  if(rows.length!==1)throw new Error('This diagnostic requires one NVIDIA GPU. Select the same device explicitly for inference and capacity monitoring before using a multi-GPU host.');
  const [gpuUuid,free,...extra]=rows[0].split(',').map(value=>value.trim());
  if(extra.length || !/^GPU-[a-f0-9-]+$/i.test(gpuUuid) || !/^\d+(?:\.\d+)?$/.test(free) || !Number.isFinite(Number(free)))throw new Error('GPU capacity returned an invalid UUID or memory value.');
  if(visibleDevices!==undefined && visibleDevices!=='0' && visibleDevices!==gpuUuid)throw new Error('CUDA_VISIBLE_DEVICES does not unambiguously select the monitored GPU. Select the same device for inference and capacity monitoring.');
  return {gpuUuid,gpuFreeMiB:Number(free)};
}

// Long-lived owned readers avoid repeated interpreter/driver startup under load.
// A stale or malformed stream fails closed; kill alone never proves release.
export function createCapacityStream(command, args, parse, { spawnProcess = spawn, now = Date.now, cleanupTimeoutMs = 5000 } = {}) {
  if(!Number.isInteger(cleanupTimeoutMs)||cleanupTimeoutMs<1||cleanupTimeoutMs>5000)throw new Error('Invalid capacity cleanup deadline.');
  const child = spawnProcess(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const receipt = { pid: child.pid, startedUtc: new Date().toISOString() };
  let pending = '', stderr = '', latest, receivedAt, failure, released = false, owner;
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    released = true;
    ownedStreams.delete(owner);
    Object.assign(receipt, { closedUtc: new Date().toISOString(), code, signal, stderr });
    failure ??= new Error('Capacity sampler closed.'); resolve();
  }));
  child.on('error', error => { failure = error; });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
  child.stdout.on('data', chunk => {
    if (failure) return;
    pending += chunk;
    try {
      if (pending.length > 10000) throw new Error('Capacity sampler frame exceeds bound.');
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        latest = parse(pending.slice(0, end)); pending = pending.slice(end + 1); receivedAt = now();
      }
    } catch (error) { failure = error; }
  });
  const read = () => {
    if (failure) throw failure;
    if (!latest || now() - receivedAt > 5000) throw new Error('Capacity sampler is stale.');
    return { ...latest, sampleAgeMs: now() - receivedAt };
  };
  owner = { receipt, read, waitForClose: () => closed.then(() => receipt),
    async ready() {
      const deadline = Date.now() + 10000;
      while (!latest && !failure && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      return read();
    },
    async close() {
      if (!released) child.kill();
      let timer;
      try { await Promise.race([closed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`Capacity sampler ${child.pid} remains owned after stop.`),
          { samplerOwner: owner, receipt })), cleanupTimeoutMs);
      })]); } finally { clearTimeout(timer); }
      return receipt;
    },
  };
  ownedStreams.add(owner);
  return owner;
}

// Explicit installed read-only samplers, no installation or host settings changes.
export async function windowsGenerationCapacity({ pythonPath = process.env.SJ_PAINT_TEST_CAPACITY_PYTHON, requireGpu = false } = {}) {
  if(process.platform!=='win32')throw new Error('Windows capacity adapter requires Windows.');
  if(typeof pythonPath!=='string'||!isAbsolute(pythonPath))throw new Error('Set SJ_PAINT_TEST_CAPACITY_PYTHON to an absolute existing Python interpreter path; no interpreter is installed automatically.');
  const python=await realpath(pythonPath);
  if(!(await stat(python)).isFile())throw new Error('The capacity interpreter must be an existing file.');
  const monitor=fileURLToPath(new URL('./windows-generation-capacity.py',import.meta.url));
  const device=requireGpu ? parseSingleGpuCapacity((await run('nvidia-smi',['--query-gpu=uuid,memory.free','--format=csv,noheader,nounits'],{windowsHide:true,timeout:10000})).stdout,process.env.CUDA_VISIBLE_DEVICES) : null;
  const streams=[];
  const close=async()=>{
    const results=await Promise.allSettled(streams.map(stream=>stream.close()));
    const failures=results.filter(result=>result.status==='rejected').map(result=>result.reason);
    if(failures.length)throw Object.assign(new AggregateError(failures,'Capacity sampler cleanup incomplete.'),{samplerOwners:streams});
    return streams.map(stream=>stream.receipt);
  };
  try {
    const host=createCapacityStream(python,['-I','-B',monitor,'--stream'],line=>{
      const value=JSON.parse(line);
      if(![value.availablePagefile,value.availablePhysical].every(n=>Number.isSafeInteger(n)&&n>=0))throw new Error('Invalid host capacity.');
      return value;
    }); streams.push(host);
    const gpu=device ? createCapacityStream('nvidia-smi',[`--id=${device.gpuUuid}`,'--query-gpu=uuid,memory.free','--format=csv,noheader,nounits','--loop-ms=1000'],line=>{
      const value=parseSingleGpuCapacity(line,device.gpuUuid);
      if(value.gpuUuid!==device.gpuUuid)throw new Error('Capacity GPU identity changed.');
      return value;
    }) : null;
    if(gpu)streams.push(gpu);
    await Promise.all(streams.map(stream=>stream.ready()));
    return { close, receipts: streams.map(stream=>stream.receipt), sample: async()=>{
      const memory=host.read(), graphics=gpu?.read();
      return {availableCommitBytes:memory.availablePagefile,availablePhysicalBytes:memory.availablePhysical,
        gpuUuid:graphics?.gpuUuid ?? null,gpuFreeMiB:graphics?.gpuFreeMiB ?? null,hostSampleAgeMs:memory.sampleAgeMs,gpuSampleAgeMs:graphics?.sampleAgeMs ?? null};
    }};
  } catch(error) {
    try { await close(); } catch(cleanup) { throw Object.assign(new AggregateError([error,cleanup],'Capacity initialization and cleanup failed.'),{samplerOwners:streams}); }
    throw error;
  }
}
