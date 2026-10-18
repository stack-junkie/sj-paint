import { readFile, realpath, lstat } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

// Opt-in, caller-owned acceptance profile only. Both absolute paths are required;
// there is no fallback to a normal user profile or a checkout-specific cache.
// The completed setup receipt must bind this profile to the running checkout.
export async function managedAiTestProfile(repository, {
  profilePath = process.env.SJ_PAINT_TEST_MANAGED_PROFILE,
  setupReceiptPath = process.env.SJ_PAINT_TEST_SETUP_RECEIPT,
} = {}) {
  if (![profilePath, setupReceiptPath].every(value => typeof value === 'string' && isAbsolute(value))) {
    throw new Error('Managed verification requires explicit absolute SJ_PAINT_TEST_MANAGED_PROFILE and SJ_PAINT_TEST_SETUP_RECEIPT paths.');
  }
  const profile = resolve(profilePath), receiptPath = resolve(setupReceiptPath);
  const samePath = (a,b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  const verifyPath = async (path, directory = false) => {
    const info = await lstat(path);
    if(info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile()) || !samePath(await realpath(path),path)) {
      throw new Error('Managed acceptance paths must be existing, unredirected files or directories.');
    }
  };
  await verifyPath(profile,true); await verifyPath(receiptPath);
  const receiptBytes = await readFile(receiptPath), receipt = JSON.parse(receiptBytes);
  if (receipt.status !== 'ready' || typeof receipt.userDataPath !== 'string' || !isAbsolute(receipt.userDataPath) || !samePath(resolve(receipt.userDataPath),profile) ||
      typeof receipt.repository !== 'string' || !isAbsolute(receipt.repository) || !samePath(resolve(receipt.repository),resolve(repository)) || receipt.finalState?.ownsProcess !== false ||
      receipt.finalState?.cleanupPending !== false) throw new Error('Managed acceptance setup receipt does not establish this profile.');
  const registryPath = resolve(profile, 'ai/active.json');
  await verifyPath(registryPath);
  const registryBytes = await readFile(registryPath), registry = JSON.parse(registryBytes);
  for (const feature of ['u2net', 'efficientsam-ti']) {
    const entry = registry.features?.[feature];
    if (entry?.runtimeId !== 'win32-x64-onnx' || !/^r\/[a-f0-9]{16}$/.test(entry.runtime) ||
        !/^m\/[a-f0-9]{16}$/.test(entry.model) || !/^[a-f0-9]{64}$/.test(entry.manifestDigest)) {
      throw new Error(`Managed acceptance registry lacks the expected ${feature} installation.`);
    }
  }
  return { profile, registryPath, receiptPath,
    receiptSha256: createHash('sha256').update(receiptBytes).digest('hex'),
    registryBeforeSha256: createHash('sha256').update(registryBytes).digest('hex'), registryBefore: registry };
}

export function managedAiTestEnvironment(environment) {
  const result = { ...environment, SJ_PAINT_TEST_LOCAL_AI: '0', SJ_PAINT_TEST_CLIPBOARD: '0' };
  const overrides = new Set(['SJ_PAINT_PYTHON', 'SJ_PAINT_U2NETP_MODEL', 'SJ_PAINT_EFFICIENTSAM_ENCODER',
    'SJ_PAINT_EFFICIENTSAM_DECODER', 'SJ_PAINT_GENERATIVE_PYTHON', 'SJ_PAINT_SDXL_MODEL']);
  for (const key of Object.keys(result)) if (overrides.has(key.toUpperCase())) delete result[key];
  return result;
}

export function desktopVerificationArguments(args) {
  if (!args.length) return { workflow: '', photoFixture: null };
  const workflow = args.slice(0, 2).join(' ');
  if (['--workflow managed-ai', '--workflow managed-generation'].includes(workflow) && args.length === 4 && args[2] === '--photo-fixture' && isAbsolute(args[3])) {
    return { workflow, photoFixture: args[3] };
  }
  if (args.length === 2 && ['--workflow hidden-capture', '--workflow quit-cancel', '--workflow managed-quit', '--workflow files'].includes(workflow)) return { workflow, photoFixture: null };
  throw new Error('Unknown desktop workflow. Managed AI and generation require --workflow <managed-ai|managed-generation> --photo-fixture <absolute existing photo path>.');
}
