const { createHash } = require('node:crypto');
const assets = require('./ai-assets.json');
const releaseCapabilities = require('./ai-capabilities.json');
const FEATURES = Object.freeze(releaseCapabilities.setupFeatures);
const DEFAULT_FEATURES = Object.freeze(releaseCapabilities.defaultFeatures);
const supportsAcceleration = feature => ['sdxl-base', 'sdxl-coloring'].includes(feature);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Full digests remain in receipts. Short locations leave room for native DLL
// names on Windows; readiness is checked against the full identity, not a prefix.
const runtimeLocation = runtime => `r/${digest(runtime).slice(0, 16)}`;
const modelLocation = model => `m/${digest(model).slice(0, 16)}`;
const relative = value => typeof value === 'string' && value.length > 0 && !value.includes('\\') &&
  !value.includes(':') && !value.includes('\0') && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..');

function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1) throw new TypeError('Unsupported AI asset manifest.');
  for (const [id, artifact] of Object.entries(manifest.artifacts)) {
    if (!/^[a-f0-9]{64}$/.test(id) || artifact.sha256 !== id || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 ||
        !relative(artifact.filename) || artifact.filename.includes('/') || new URL(artifact.url).protocol !== 'https:' ||
        (['wheel', 'python'].includes(artifact.kind) && (!Number.isSafeInteger(artifact.expandedBytes) || artifact.expandedBytes < 1))) throw new TypeError('Invalid pinned AI artifact.');
  }
  for (const [id, runtime] of Object.entries(manifest.runtimes)) {
    if (!/^(win32|linux)-x64-(onnx|sdxl-cpu|sdxl-cuda)$/.test(id) || !relative(runtime.executable) ||
        !manifest.artifacts[runtime.python] || !runtime.wheels.length || runtime.wheels.some(key => !manifest.artifacts[key])) throw new TypeError('Invalid AI runtime profile.');
  }
  for (const feature of FEATURES) {
    const model = manifest.models[feature];
    if (!model?.files.length || model.files.some(file => !relative(file.path) || !manifest.artifacts[file.artifact])) throw new TypeError('Invalid AI model profile.');
  }
  return manifest;
}

function selectProfiles(manifest, { features = DEFAULT_FEATURES, accelerator = 'cpu' } = {}, platform = process.platform, arch = process.arch) {
  if (!Array.isArray(features) || !features.length || features.some(feature => !FEATURES.includes(feature)) ||
      !['cpu', 'cuda'].includes(accelerator)) throw new TypeError('Choose supported AI features and CPU or CUDA acceleration.');
  const selections = [...new Set(features)].map(feature => {
    const runtimeId = `${platform}-${arch}-${supportsAcceleration(feature) ? `sdxl-${accelerator}` : 'onnx'}`;
    const runtime = manifest.runtimes[runtimeId];
    if (!runtime) throw new TypeError('Managed AI requires Windows x64 or Linux x64.');
    const model = manifest.models[feature];
    return { feature, runtimeId, runtime, model, runtimeDigest: digest(runtime), modelDigest: digest(model) };
  });
  const ids = [...new Set(selections.flatMap(item => [item.runtime.python, ...item.runtime.wheels, ...item.model.files.map(file => file.artifact)]))];
  return { selections, artifacts: ids.map(id => manifest.artifacts[id]) };
}

module.exports = { manifest: validateManifest(assets), validateManifest, selectProfiles, digest, relative, FEATURES, DEFAULT_FEATURES, supportsAcceleration, runtimeLocation, modelLocation };
