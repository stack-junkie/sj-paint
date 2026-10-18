const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Transform, Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const tar = require('tar');
const { writeFileAtomically } = require('./atomic-write.cjs');
const { createWorkerProcess, LocalAiError } = require('./local-ai-process.cjs');
const { manifest: publishedManifest, validateManifest, selectProfiles, digest, relative, FEATURES, DEFAULT_FEATURES, supportsAcceleration, runtimeLocation, modelLocation } = require('./ai-manifest.cjs');
const fail = (code, message) => new LocalAiError(code, message);
const aborted = signal => { if (signal?.aborted) throw fail('ABORTED', 'AI setup was canceled. Verified downloads are retained.'); };
const exists = async filename => { try { return await fs.lstat(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

// Pip runs in this owned worker, without a shell, dependency resolution, builds,
// downloads, or a child installer. Model inference is a separate operation.
const INSTALL_SCRIPT = String.raw`
import contextlib, importlib, importlib.metadata, io, json, os, sys, tempfile
os.environ.update({'HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1','PIP_CONFIG_FILE':os.devnull})
tempfile.tempdir=os.path.join(sys.prefix,'.setup-temp'); os.makedirs(tempfile.tempdir,exist_ok=True)
class Diagnostics(io.TextIOBase):
    def __init__(self): self.tail=''
    def write(self,value): self.tail=(self.tail+value)[-8192:]; return len(value)
def send(frame):
    sys.__stdout__.write(json.dumps(frame,separators=(',',':'))+'\n'); sys.__stdout__.flush()
for line in sys.stdin.buffer:
    h=json.loads(line); count=h['payloadLength']; request=json.loads(sys.stdin.buffer.read(count)); out=Diagnostics()
    base={'version':2,'id':h['id'],'operation':h['operation'],'payloadLength':0}
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            if h['operation']=='install':
                from pip._internal.cli.main import main
                for index,wheel in enumerate(request['wheels']):
                    result=main(['--isolated','install','--no-index','--no-deps','--no-compile','--ignore-installed',
                        '--no-cache-dir','--disable-pip-version-check',wheel])
                    if result: raise RuntimeError('Wheel installation failed: '+os.path.basename(wheel))
                    send({**base,'event':'progress','progress':{'stage':'installing','completed':index+1,'total':len(request['wheels'])}})
                if main(['--isolated','check','--disable-pip-version-check']): raise RuntimeError('Installed dependencies are inconsistent.')
            modules=['onnxruntime','PIL','numpy'] if request['probe']=='onnx' else ['torch','diffusers','transformers','accelerate','cv2']
            for index,name in enumerate(modules):
                send({**base,'event':'progress','progress':{'stage':'checking-runtime','completed':index,'total':len(modules)}})
                importlib.import_module(name)
            versions={name:importlib.metadata.version(name) for name in request['packages']}
            if versions!=request['packages']: raise RuntimeError('Installed package versions differ from the pinned profile.')
        send({**base,'ok':True,'metadata':{'python':sys.version.split()[0],'packages':versions}})
    except Exception as error:
        send({**base,'ok':False,'code':'RUNTIME','message':str(error)[:256]})
`;

/** Main-process-only setup. Renderer inputs are feature IDs, never paths/URLs. */
function createManagedAiSetup({ userDataPath, manifest = publishedManifest, platform = process.platform, arch = process.arch,
  seedAssets = {}, onProgress, onOwnershipReleased, timeoutMs = 30 * 60_000 } = {}, dependencies = {}) {
  if (!path.isAbsolute(userDataPath || '')) throw new TypeError('AI setup requires an absolute application data directory.');
  validateManifest(manifest);
  const root = path.join(userDataPath, 'ai'), manifestDigest = digest(manifest);
  const fetchArtifact = dependencies.fetch || globalThis.fetch;
  const workerFactory = dependencies.createWorkerProcess || createWorkerProcess;
  const linkModelArtifact = dependencies.linkModelArtifact || fs.link;
  const windowsRoot = process.env.SystemRoot || process.env.WINDIR;
  const windowsSystemDirectory = dependencies.windowsSystemDirectory ?? (windowsRoot ? path.join(windowsRoot, 'System32') : null);
  let active = null, closed = false;
  function inspect() { if (active?.finished && !active.worker?.state().owned && !active.retainedStages?.length) active = null; }
  function local(name) {
    if (!relative(name)) throw fail('CONFIG', 'Invalid managed AI path.');
    return path.join(root, ...name.split('/'));
  }
  async function directory(name = '') {
    await fs.mkdir(userDataPath, { recursive: true });
    let current = root;
    for (const component of ['', ...name.split('/').filter(Boolean)]) {
      if (component) current = path.join(current, component);
      try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('CONFIG', 'A managed AI directory was replaced by a link or file.');
    }
    return current;
  }
  async function readRegistry() {
    try {
      const value = JSON.parse(await fs.readFile(local('active.json'), 'utf8'));
      if (value.schemaVersion !== 1 || !value.features || typeof value.features !== 'object') throw new Error();
      return value;
    } catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, features: {} }; throw fail('CONFIG', 'The managed AI activation receipt is invalid.'); }
  }
  async function readReady(name, expectedDigest) {
    const filename = local(name + '/ready.json'), stat = await exists(filename);
    if (!stat) return null;
    try {
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
      const receipt = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (receipt?.digest !== expectedDigest) throw new Error();
      return receipt;
    } catch (error) {
      if (error.code && error.code !== 'ENOENT') throw error;
      throw fail('INTEGRITY', 'The existing managed AI readiness receipt is invalid.');
    }
  }
  async function inspectRuntime(selection, binding) {
    const canonical = runtimeLocation(selection.runtime), name = binding?.runtime || canonical;
    if (!/^r\/[a-f0-9]{16}$/.test(name)) return null;
    if (binding) {
      if (binding.runtimeId !== selection.runtimeId) return null;
      if (binding.runtimeDigest !== undefined) {
        if (!/^[a-f0-9]{64}$/.test(binding.runtimeDigest)) throw fail('INTEGRITY', 'The managed runtime binding digest is invalid.');
        // A previous, valid dependency profile remains installed until its
        // replacement is ready. It is not a receipt for this selected profile.
        if (binding.runtimeDigest !== selection.runtimeDigest) return null;
      } else if (name !== canonical) return null;
    }
    const receipt = await readReady(name, selection.runtimeDigest);
    if (!receipt) return null; // Never adopt an incomplete directory.
    const attempt = receipt.installationId !== undefined;
    if ((attempt && (receipt.installationId !== name.slice(2) || receipt.runtimeId !== selection.runtimeId)) ||
        (!attempt && name !== canonical)) throw fail('INTEGRITY', 'The managed runtime receipt does not identify its installation path.');
    const destination = local(name), stat = await exists(destination);
    if (!stat?.isDirectory() || stat.isSymbolicLink() || !await executableWithin(destination, selection.runtime.executable)) {
      throw fail('INTEGRITY', 'The existing managed runtime executable is invalid.');
    }
    const pythonPath = path.join(destination, ...selection.runtime.executable.split('/'));
    return { name, destination, pythonPath, receipt, ready: receipt.probedExecutable === pythonPath };
  }
  async function reusableRuntime(selection, registry) {
    for (const binding of Object.values(registry.features)) {
      const installed = await inspectRuntime(selection, binding);
      if (installed) return installed;
    }
    // Compatibility with ready installations made before attempts had unique
    // identities. This is one known path, not a scan of unowned directories.
    return inspectRuntime(selection);
  }
  async function allocateRuntime(selection, lease) {
    await directory('r');
    for (;;) {
      const name = `r/${randomUUID().replaceAll('-', '').slice(0, 16)}`;
      if (name === runtimeLocation(selection.runtime)) continue;
      const destination = local(name);
      try { await fs.mkdir(destination); }
      catch (error) { if (error.code === 'EEXIST') continue; throw error; }
      lease.stages.add(destination);
      return { name, destination, pythonPath: path.join(destination, ...selection.runtime.executable.split('/')) };
    }
  }
  function emit(lease, value) {
    lease.progress = { id: lease.id, ...value };
    for (const listener of [onProgress, lease.onProgress]) { try { listener?.(lease.progress); } catch { /* Observers cannot change setup ownership. */ } }
  }
  async function hash(filename, signal) {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw fail('INTEGRITY', 'An AI artifact is not a regular file.');
    const value = createHash('sha256');
    for await (const chunk of createReadStream(filename, { signal })) { aborted(signal); value.update(chunk); }
    return value.digest('hex');
  }
  const artifactPath = item => local(`artifacts/${item.sha256}/${item.filename}`);
  async function validArtifact(item, filename, signal) {
    const stat = await exists(filename);
    return !!stat?.isFile() && !stat.isSymbolicLink() && stat.size === item.bytes && await hash(filename, signal) === item.sha256;
  }
  async function copyVerified(item, source, target, signal, progress) {
    let received = 0; const value = createHash('sha256');
    const verify = new Transform({ transform(chunk, encoding, done) {
      received += chunk.length; value.update(chunk);
      if (received > item.bytes) { done(fail('INTEGRITY', 'An AI artifact grew during copying.')); return; }
      progress?.(received); done(null, chunk);
    } });
    const previous = await exists(target);
    if (previous && (!previous.isFile() || previous.isSymbolicLink())) throw fail('INTEGRITY', 'An AI staging file was replaced by a link.');
    await pipeline(createReadStream(source), verify, createWriteStream(target, { flags: 'w', mode: 0o600 }), { signal });
    if (received !== item.bytes || value.digest('hex') !== item.sha256) throw fail('INTEGRITY', 'An AI artifact changed while being copied.');
  }
  async function acquire(item, lease) {
    const signal = lease.controller.signal, target = artifactPath(item);
    aborted(signal); await directory(`artifacts/${item.sha256}`);
    emit(lease, { stage: 'verifying', artifact: item.filename, completed: 0, total: item.bytes });
    if (await validArtifact(item, target, signal)) return target;
    const partial = target + '.part';
    const previous = await exists(partial);
    if (previous && (!previous.isFile() || previous.isSymbolicLink())) throw fail('INTEGRITY', 'An AI download staging file is not a regular file.');
    const seeds = seedAssets[item.sha256] === undefined ? [] : [seedAssets[item.sha256]].flat();
    for (const seed of seeds) {
      if (typeof seed !== 'string' || !path.isAbsolute(seed)) throw fail('CONFIG', 'Seed artifacts require trusted absolute paths.');
      if (await validArtifact(item, seed, signal)) {
        emit(lease, { stage: 'reusing', artifact: item.filename, completed: 0, total: item.bytes });
        await copyVerified(item, seed, partial, signal);
        await fs.rename(partial, target); return target;
      }
    }
    let offset = (await exists(partial))?.size || 0;
    if (offset >= item.bytes) {
      if (await validArtifact(item, partial, signal)) { await fs.rename(partial, target); return target; }
      await fs.unlink(partial); offset = 0;
    }
    let response;
    try { response = await fetchArtifact(item.url, { signal, redirect: 'follow', headers: offset ? { Range: `bytes=${offset}-` } : {} }); }
    catch { aborted(signal); throw fail('NETWORK', `Could not download ${item.filename}. Check the network connection and retry.`); }
    try {
      if (!response.ok || !response.body || (response.url && new URL(response.url).protocol !== 'https:')) throw fail('NETWORK', `Could not download ${item.filename} (HTTP ${response.status}). Check the connection and retry.`);
      if (offset && response.status === 206) {
        if (response.headers.get('content-range') !== `bytes ${offset}-${item.bytes - 1}/${item.bytes}`) throw fail('NETWORK', 'AI download resumed at an unexpected byte range.');
      } else if (response.status === 200) offset = 0;
      else throw fail('NETWORK', 'Unexpected AI artifact HTTP response.');
      const length = response.headers.get('content-length');
      if (length !== null && Number(length) !== item.bytes - offset) throw fail('INTEGRITY', 'AI download size differs from the pinned manifest.');
    } catch (error) {
      // No pipeline owns this body yet. Release the connection before returning.
      try { await response.body?.cancel(); } catch { /* Fetch may have already aborted it. */ }
      throw error;
    }
    let received = offset, last = 0;
    const progress = new Transform({ transform(chunk, encoding, done) {
      received += chunk.length;
      if (received > item.bytes) { done(fail('INTEGRITY', 'AI download exceeded its pinned size.')); return; }
      if (Date.now() - last > 150 || received === item.bytes) { last = Date.now(); emit(lease, { stage: 'downloading', artifact: item.filename, completed: received, total: item.bytes }); }
      done(null, chunk);
    } });
    try { await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(partial, { flags: offset ? 'a' : 'w', mode: 0o600 }), { signal }); }
    catch (error) {
      aborted(signal);
      if (error instanceof TypeError || String(error.code).startsWith('UND_ERR') || ['ECONNRESET', 'ETIMEDOUT'].includes(error.code)) {
        throw fail('NETWORK', `The download of ${item.filename} was interrupted. Check the connection and retry.`);
      }
      throw error;
    }
    if (!await validArtifact(item, partial, signal)) { await fs.unlink(partial); throw fail('INTEGRITY', 'AI download failed its pinned SHA-256 check.'); }
    await fs.rename(partial, target); return target;
  }
  async function extractPython(archive, destination, signal) {
    let expanded = 0, rejected = null;
    // tar's async file API drains open output files before resolving. Cancel
    // skips remaining entries and waits for that drain before deleting staging.
    // Filter rejection must not throw through tar's Minipass write callback.
    await tar.x({ file: archive, cwd: destination, strip: 1, strict: true, preservePaths: false, filter(name, entry) {
      if (signal.aborted || rejected) return false;
      const reject = message => { rejected = fail('INTEGRITY', message); return false; };
      if (!relative(name.replace(/\/$/, '')) || !name.startsWith('python/')) return reject('Invalid portable Python archive path.');
      if (!['File', 'Directory', 'SymbolicLink', 'Link'].includes(entry.type)) return reject('Unsupported portable Python archive entry.');
      if (entry.linkpath) {
        const resolved = entry.type === 'Link' ? path.posix.normalize(entry.linkpath) : path.posix.join(path.posix.dirname(name), entry.linkpath);
        if (!relative(resolved) || !resolved.startsWith('python/')) return reject('Portable Python archive link escapes its root.');
      }
      expanded += entry.size;
      // Setup declares a 1 GiB expansion budget for its interpreter archive.
      if (expanded > 1024 ** 3) return reject('Portable Python exceeds its declared extraction budget.');
      return true;
    } });
    aborted(signal); if (rejected) throw rejected;
  }
  async function runtime(selection, files, lease, registry) {
    const installed = await reusableRuntime(selection, registry);
    const { name, destination, pythonPath } = installed || await allocateRuntime(selection, lease);
    const receipt = installed?.receipt;
    let operation = 'install', installedUtc;
    if (receipt) {
      const data = receipt;
      if (installed.ready) return name;
      operation = 'probe'; installedUtc = data.installedUtc;
    } else {
      // Runtime packages must never move after native-extension probing. This
      // directory is lease-owned and unpublished until its final-path probe and
      // ready receipt succeed; active.json is the atomic publication boundary.
      emit(lease, { stage: 'extracting', runtime: selection.runtimeId, completed: 0, total: 1 });
      await extractPython(files.get(selection.runtime.python), destination, lease.controller.signal);
    }
    const signal = lease.controller.signal;
    aborted(signal);
    const worker = workerFactory({ pythonPath, script: INSTALL_SCRIPT, args: [], timeoutMs }, { onOwnershipReleased }); lease.worker = worker;
    try {
      const fields = { wheels: operation === 'install' ? selection.runtime.wheels.map(id => files.get(id)) : [], probe: selection.runtime.probe, packages: selection.runtime.packages };
      const payload = Buffer.from(JSON.stringify(fields));
      const answer = await worker.request(operation, {}, payload, 0, signal, progress => emit(lease, { ...progress, runtime: selection.runtimeId }));
      if (!answer.header.ok) throw fail('RUNTIME', answer.header.message || 'The isolated runtime could not be installed.');
      await worker.close();
      if (worker.state().owned) throw fail('CLEANUP', 'The setup worker has not closed.');
      lease.worker = null; aborted(signal);
      await writeFileAtomically(path.join(destination, 'ready.json'), JSON.stringify({ digest: selection.runtimeDigest,
        ...(name !== runtimeLocation(selection.runtime) || receipt?.installationId !== undefined ? { installationId: name.slice(2), runtimeId: selection.runtimeId } : {}),
        installedUtc: installedUtc || new Date().toISOString(), probedExecutable: pythonPath,
        probedUtc: new Date().toISOString(), metadata: answer.header.metadata }));
      lease.stages.delete(destination); return name;
    } catch (error) { try { await worker.close(error); } catch { /* Keep worker ownership until confirmed close. */ } throw error; }
  }
  async function model(selection, files, lease) {
    const name = modelLocation(selection.model), destination = local(name);
    if (await readReady(name, selection.modelDigest)) {
      for (const item of selection.model.files) {
        const artifact = manifest.artifacts[item.artifact];
        emit(lease, { stage: 'verifying', artifact: item.path, completed: 0, total: artifact.bytes });
        if (!await validArtifact(artifact, path.join(destination, ...item.path.split('/')), lease.controller.signal)) throw fail('INTEGRITY', 'An installed model no longer matches its pinned digest.');
      }
      return name;
    }
    if (await exists(destination)) throw fail('INTEGRITY', 'An incomplete model occupies the activation destination.');
    const stageName = `staging/${lease.id}-${randomUUID()}`, stage = await directory(stageName);
    lease.stages.add(stage);
    for (const item of selection.model.files) {
      aborted(lease.controller.signal);
      const parent = path.posix.dirname(item.path);
      if (parent !== '.') await directory(stageName + '/' + parent);
      const artifact = manifest.artifacts[item.artifact];
      emit(lease, { stage: 'installing-model', artifact: item.path, completed: 0, total: artifact.bytes });
      const source = files.get(item.artifact), target = path.join(stage, ...item.path.split('/'));
      // Link only the verified content-addressed managed cache, never a seed.
      // These files are app-owned and treated as immutable, not OS write-locked.
      if (source !== artifactPath(artifact)) throw fail('INTEGRITY', 'Model installation requires a managed artifact.');
      try {
        await linkModelArtifact(source, target);
      } catch (error) {
        if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error;
        await copyVerified(artifact, source, target, lease.controller.signal);
      }
      if (!await validArtifact(artifact, target, lease.controller.signal)) throw fail('INTEGRITY', 'A model artifact changed during installation.');
    }
    await writeFileAtomically(path.join(stage, 'ready.json'), JSON.stringify({ digest: selection.modelDigest, installedUtc: new Date().toISOString() }));
    aborted(lease.controller.signal); await directory('m'); await fs.rename(stage, destination); lease.stages.delete(stage); return name;
  }
  async function executableWithin(destination, executable) {
    try {
      const real = await fs.realpath(path.join(destination, ...executable.split('/'))), prefix = await fs.realpath(destination);
      if (!real.startsWith(prefix + path.sep)) return false;
      return (await fs.stat(real)).isFile();
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async function cleanStages(lease) {
    if (lease.worker?.state().owned) { lease.retainedStages = [...lease.stages]; return; }
    lease.retainedStages = [];
    for (const stage of lease.stages) {
      try {
        const stat = await exists(stage);
        if (stat) {
          const parentName = path.dirname(stage);
          if (![local('staging'), local('r')].includes(parentName)) throw fail('CLEANUP', 'An owned setup directory is outside its managed roots.');
          const parent = await fs.realpath(parentName);
          if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(await fs.realpath(stage)) !== parent) throw fail('CLEANUP', 'A setup staging directory changed identity.');
          await fs.rm(stage, { recursive: true });
        }
        lease.stages.delete(stage);
      } catch { lease.retainedStages.push(stage); }
    }
  }
  async function plan(request = {}) {
    const selection = selectProfiles(manifest, request, platform, arch);
    const registry = await readRegistry(), installedRuntimes = new Map();
    for (const item of selection.selections) if (!installedRuntimes.has(item.runtimeId)) {
      installedRuntimes.set(item.runtimeId, await reusableRuntime(item, registry));
    }
    if (platform === 'win32') {
      for (const item of selection.selections.filter(item => supportsAcceleration(item.feature))) {
        const runtimeRoot = installedRuntimes.get(item.runtimeId)?.destination;
        // Pinned Torch imports MSVCP140 by its original name. The renamed DLL
        // in numpy.libs does not satisfy that dependency. Check only explicit
        // runtime locations and Windows' system directory, never ambient PATH.
        const directories = [...(runtimeRoot ? [runtimeRoot, path.join(runtimeRoot, 'Library/bin'),
          path.join(runtimeRoot, 'Lib/site-packages/torch/lib'), path.join(runtimeRoot, 'bin')] : []), windowsSystemDirectory];
        let present = false;
        for (const directory of directories) {
          if (!directory || !path.isAbsolute(directory)) continue;
          const info = await exists(path.join(directory, 'msvcp140.dll'));
          if (info?.isFile() && !info.isSymbolicLink() && info.size > 0) { present = true; break; }
        }
        if (!present) throw fail('RUNTIME', 'Windows image generation requires the Microsoft Visual C++ x64 runtime (MSVCP140.dll). Install or repair it from https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist, then retry. SJ Paint does not install system prerequisites.');
        // Presence is only a prerequisite. The final-path Python import probe
        // still establishes whether these DLLs and the pinned runtime can load.
      }
    }
    let presentBytes = 0, seededBytes = 0;
    for (const item of selection.artifacts) {
      if ((await exists(artifactPath(item)))?.size === item.bytes) presentBytes += item.bytes;
      else for (const seed of [seedAssets[item.sha256] || []].flat()) {
        if ((await exists(seed))?.size === item.bytes) { seededBytes += item.bytes; break; }
      }
    }
    const totalBytes = selection.artifacts.reduce((sum, item) => sum + item.bytes, 0);
    let runtimeBytes = 0, modelBytes = 0, temporaryWheelBytes = 0;
    const runtimes = new Set();
    for (const item of selection.selections) {
      // The placeholder has the exact length of a new attempt identity and is
      // used only for activation byte estimation, never directory allocation.
      const runtimeName = installedRuntimes.get(item.runtimeId)?.name || 'r/0000000000000000', modelName = modelLocation(item.model);
      if (!runtimes.has(item.runtimeId)) {
        runtimes.add(item.runtimeId);
        if (!installedRuntimes.get(item.runtimeId)) {
          const artifacts = [manifest.artifacts[item.runtime.python], ...item.runtime.wheels.map(id => manifest.artifacts[id])];
          runtimeBytes += artifacts.reduce((sum, artifact) => sum + artifact.expandedBytes, 0);
          temporaryWheelBytes = Math.max(temporaryWheelBytes, ...item.runtime.wheels.map(id => manifest.artifacts[id].expandedBytes));
        }
      }
      const modelReceipt = await readReady(modelName, item.modelDigest);
      let modelPresent = !!modelReceipt;
      for (const file of item.model.files) {
        const stat = await exists(local(modelName + '/' + file.path));
        if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== manifest.artifacts[file.artifact].bytes) modelPresent = false;
      }
      if (!modelPresent) modelBytes += item.model.files.reduce((sum, file) => sum + manifest.artifacts[file.artifact].bytes, 0);
      registry.features[item.feature] = { runtimeId: item.runtimeId, runtimeDigest: item.runtimeDigest, runtime: runtimeName, model: modelName, manifestDigest };
    }
    // Archive expansion comes from the pinned archives' directory metadata.
    // Pip can hold one unpacked wheel while copying it into the runtime. Keep
    // the existing conservative 2 GiB setup allowance only for new runtimes;
    // reused installations need no second runtime/model allocation.
    const runtimeReserveBytes = runtimeBytes ? 2 * 1024 ** 3 : 0;
    const activationBytes = Buffer.byteLength(JSON.stringify(registry));
    return { features: selection.selections.map(item => item.feature), accelerator: request.accelerator || 'cpu', totalBytes,
      estimatedDownloadBytes: totalBytes - presentBytes - seededBytes, seedCandidateBytes: seededBytes,
      requiredFreeBytesEstimate: totalBytes - presentBytes + runtimeBytes + modelBytes + temporaryWheelBytes + runtimeReserveBytes + activationBytes,
      capacity: { cachedArtifactBytesNeeded: totalBytes - presentBytes, runtimeBytes, modelBytes, temporaryWheelBytes, runtimeReserveBytes, activationBytes },
      integrity: 'Every reused or downloaded artifact is SHA-256 verified during setup.',
      licenses: [...new Set(selection.artifacts.map(item => item.license))] };
  }
  function selectedAccelerator(binding) {
    if (!binding || manifest.runtimes[binding.runtimeId]?.probe !== 'sdxl') return null;
    return /-sdxl-(cpu|cuda)$/.exec(binding.runtimeId)?.[1] || null;
  }
  async function resolveBinding(feature, binding) {
    if (!FEATURES.includes(feature)) throw fail('INPUT', 'Unknown AI feature.');
    // Readiness belongs to the selected runtime/model receipts. A catalog-wide
    // digest is provenance, and unrelated model additions cannot invalidate it.
    if (!binding || !relative(binding.runtime) || !relative(binding.model)) return null;
    const runtimeProfile = manifest.runtimes[binding.runtimeId], modelProfile = manifest.models[feature];
    if (!runtimeProfile || binding.model !== modelLocation(modelProfile)) return null;
    const installed = await inspectRuntime({ runtimeId: binding.runtimeId, runtime: runtimeProfile, runtimeDigest: digest(runtimeProfile) }, binding);
    if (!installed?.ready) return null;
    const { pythonPath } = installed, modelRoot = local(binding.model);
    const modelReceipt = await readReady(binding.model, digest(modelProfile));
    if (!modelReceipt) return null;
    for (const file of modelProfile.files) if ((await exists(path.join(modelRoot, ...file.path.split('/'))))?.size !== manifest.artifacts[file.artifact].bytes) return null;
    if (feature === 'sdxl-base') {
      const baseAccelerator = selectedAccelerator(binding);
      return baseAccelerator ? { basePythonPath: pythonPath, baseModelPath: modelRoot, baseAccelerator } : null;
    }
    if (feature === 'sdxl-coloring') {
      const coloringAccelerator = selectedAccelerator(binding);
      return coloringAccelerator ? { coloringPythonPath: pythonPath, coloringModelPath: modelRoot, coloringAccelerator } : null;
    }
    if (feature === 'migan') return { pythonPath, removalModelPath: path.join(modelRoot, 'migan_pipeline_v2.onnx') };
    if (feature === 'u2net') return { pythonPath, modelPath: path.join(modelRoot, 'u2net.onnx'), backgroundModelId: 'u2net' };
    if (feature === 'u2netp') return { pythonPath, modelPath: path.join(modelRoot, 'u2netp.onnx') };
    return { pythonPath, encoderPath: path.join(modelRoot, 'efficientsam_ti_encoder.onnx'), decoderPath: path.join(modelRoot, 'efficientsam_ti_decoder.onnx') };
  }
  async function resolve(feature) {
    const registry = await readRegistry();
    return resolveBinding(feature, registry.features[feature]);
  }
  async function status() {
    if (active?.finished && !active.worker?.state().owned) await cleanStages(active);
    inspect(); const features = {}, registry = await readRegistry();
    for (const feature of FEATURES) {
      const binding = registry.features[feature];
      features[feature] = { installed: !!await resolveBinding(feature, binding), supportsAcceleration: supportsAcceleration(feature),
        accelerator: supportsAcceleration(feature) ? selectedAccelerator(binding) : null };
    }
    return { state: closed ? 'closed' : active?.finished ? 'cleanup-pending' : active ? 'setting-up' : 'idle',
      active: active ? { id: active.id, progress: active.progress, finished: !!active.finished } : null, features, defaultFeatures: [...DEFAULT_FEATURES],
      preferredAccelerator: Object.values(features).some(value => value.installed && value.accelerator === 'cuda') ? 'cuda' : 'cpu',
      ownsProcess: active?.worker?.state().owned || false, cleanupPending: !!active?.retainedStages?.length };
  }
  async function setup(request) {
    if (active?.finished && !active.worker?.state().owned) await cleanStages(active);
    inspect();
    if (closed) throw fail('CLOSED', 'AI setup is shutting down.');
    if (active) throw fail('BUSY', 'An AI setup operation still owns resources.');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(request?.id || '')) throw fail('INPUT', 'A bounded setup operation ID is required.');
    const selected = selectProfiles(manifest, request, platform, arch);
    const lease = { id: request.id, controller: new AbortController(), onProgress: request.onProgress, worker: null, stages: new Set() };
    active = lease;
    const abort = () => lease.controller.abort(); request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    lease.done = (async () => {
      try {
        aborted(lease.controller.signal);
        const estimate = await plan(request);
        aborted(lease.controller.signal); await directory();
        const stat = await fs.statfs(root);
        if (stat.bavail * stat.bsize < estimate.requiredFreeBytesEstimate) throw fail('CAPACITY', 'There is not enough free space for the selected AI runtime, model and setup working files.');
        const files = new Map();
        for (const item of selected.artifacts) files.set(item.sha256, await acquire(item, lease));
        const registry = await readRegistry(), runtimes = new Map();
        for (const item of selected.selections) {
          if (!runtimes.has(item.runtimeId)) runtimes.set(item.runtimeId, await runtime(item, files, lease, registry));
          const modelName = await model(item, files, lease);
          registry.features[item.feature] = { runtimeId: item.runtimeId, runtimeDigest: item.runtimeDigest, runtime: runtimes.get(item.runtimeId), model: modelName, manifestDigest };
        }
        aborted(lease.controller.signal);
        await writeFileAtomically(local('active.json'), JSON.stringify(registry));
        emit(lease, { stage: 'ready', completed: selected.selections.length, total: selected.selections.length });
        return { installed: selected.selections.map(item => item.feature) };
      } catch (error) {
        if (lease.controller.signal.aborted && error.code !== 'CLEANUP') throw fail('ABORTED', 'AI setup was canceled. Verified downloads are retained.');
        if (error.code === 'ENOSPC') throw fail('CAPACITY', 'The AI setup volume ran out of free space. Free space and retry; verified downloads are retained.');
        throw error;
      } finally {
        request.signal?.removeEventListener('abort', abort); lease.finished = true; await cleanStages(lease); inspect();
      }
    })();
    return lease.done;
  }
  async function cancel(id) {
    inspect(); if (!active || active.id !== id) return false;
    const lease = active; lease.controller.abort();
    try { await lease.done; } catch { /* The setup caller receives its operation outcome. */ }
    if (!lease.worker?.state().owned) await cleanStages(lease);
    inspect();
    if (active === lease) throw fail('CLEANUP', 'AI setup is canceled but still owns cleanup. Retry cancellation after its worker closes.');
    return true;
  }
  async function close() { closed = true; if (active) { await cancel(active.id); if (active) await cleanStages(active); inspect(); } if (active) throw fail('CLEANUP', 'AI setup still owns process or staging cleanup while closing.'); }
  return { status, plan, setup, cancel, close, resolve };
}

module.exports = { createManagedAiSetup, INSTALL_SCRIPT };
