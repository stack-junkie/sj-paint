import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['src/version.js', 'VERSION', 'package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md'];
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
const readWorking = path => readFileSync(resolve(root, path), 'utf8');
const readStaged = path => git('show', `:${path}`);
const readHead = path => git('show', `HEAD:${path}`);

function canonical(text) {
  const match = text.match(/^export const VERSION = (['"])([^'"\r\n]+)\1;?\s*$/);
  if (!match || !semver.test(match[2])) throw new Error('src/version.js must contain one canonical export: export const VERSION = \'<semver>\';');
  return match[2];
}

function compareVersions(left, right) {
  const a = semver.exec(left), b = semver.exec(right);
  if (!a || !b) throw new Error('Versions must use valid semantic versioning.');
  for (let i = 1; i <= 3; i++) {
    if (BigInt(a[i]) !== BigInt(b[i])) return BigInt(a[i]) > BigInt(b[i]) ? 1 : -1;
  }
  if (a[4] === b[4]) return 0;
  if (!a[4]) return 1;
  if (!b[4]) return -1;
  const first = a[4].split('.'), second = b[4].split('.');
  for (let i = 0; i < Math.max(first.length, second.length); i++) {
    if (first[i] === second[i]) continue;
    if (first[i] === undefined) return -1;
    if (second[i] === undefined) return 1;
    const an = /^\d+$/.test(first[i]), bn = /^\d+$/.test(second[i]);
    if (an && bn) return BigInt(first[i]) > BigInt(second[i]) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return first[i] > second[i] ? 1 : -1;
  }
  return 0;
}

function section(changelog, version) {
  const heading = new RegExp(`^## \\[${escape(version)}\\](?:[^\\r\\n]*)$`, 'gm');
  const matches = [...changelog.matchAll(heading)];
  if (matches.length !== 1) throw new Error(`CHANGELOG.md must contain exactly one heading for [${version}].`);
  const start = matches[0].index + matches[0][0].length;
  return changelog.slice(start).split(/^## /m)[0].trim();
}

function check(read) {
  const data = Object.fromEntries(files.map(path => [path, read(path)]));
  const version = canonical(data['src/version.js']);
  const packageData = JSON.parse(data['package.json']);
  const lockData = JSON.parse(data['package-lock.json']);
  const values = [
    ['VERSION', data.VERSION.trim()], ['package.json', packageData.version],
    ['package-lock.json root', lockData.version], ['package-lock.json packages root', lockData.packages?.['']?.version],
  ];
  for (const [path, value] of values) if (value !== version) throw new Error(`${path} has ${JSON.stringify(value)}; expected ${version}.`);
  const markers = [...data['README.md'].matchAll(/<!-- sj-paint-version: ([^\r\n]+) -->/g)];
  if (markers.length !== 1 || markers[0][1] !== version) throw new Error(`README.md must contain one <!-- sj-paint-version: ${version} --> marker.`);
  const visible = [...data['README.md'].matchAll(/^Version: (\S+)[ \t]*$/gm)];
  if (visible.length !== 1 || visible[0][1] !== version) throw new Error(`README.md must contain one visible Version: ${version} line.`);
  section(data['CHANGELOG.md'], version);
  return { version, data, packageData, lockData };
}

function checkStaged() {
  const { version, data } = check(readStaged);
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (head.error) throw head.error;
  if (head.status !== 0) {
    if (head.status !== 128) throw new Error('Unable to determine whether HEAD exists.');
    console.log(`Initial staged snapshot is consistent at ${version}.`);
    return;
  }
  const changed = git('diff', '--cached', '--name-only', '-z', 'HEAD', '--').split('\0').filter(Boolean);
  const material = changed.filter(path => /^(src|electron)\//.test(path) && path !== 'src/version.js' && !/\.(test|spec)\.[^/]+$/.test(path) && !/\.md$/i.test(path));
  const previous = canonical(readHead('src/version.js'));
  if (material.length && compareVersions(version, previous) <= 0) {
    throw new Error(`Staged runtime changes require a version newer than ${previous} and a changelog entry. Run npm run version:bump -- <semver>, describe the change, and stage those files.`);
  }
  if (compareVersions(version, previous) < 0) throw new Error(`Version cannot move backward from ${previous} to ${version}.`);
  if (material.length || version !== previous) {
    if (readHead('CHANGELOG.md') === data['CHANGELOG.md'] || !/^[-*] \S/m.test(section(data['CHANGELOG.md'], version))) {
      throw new Error(`Stage a descriptive changelog entry under [${version}]. The bump command creates a heading without inventing release notes.`);
    }
  }
  console.log(`Staged version ${version} is consistent${material.length ? ` across ${material.length} runtime change(s)` : ''}.`);
}

function bump(version) {
  if (!semver.test(version ?? '')) throw new Error('Usage: node scripts/version.mjs bump <semver>');
  const current = check(readWorking);
  if (compareVersions(version, current.version) <= 0) throw new Error(`The next version must have higher precedence than ${current.version}.`);
  current.packageData.version = version;
  current.lockData.version = version;
  current.lockData.packages[''].version = version;
  let readme = current.data['README.md']
    .replace(`<!-- sj-paint-version: ${current.version} -->`, `<!-- sj-paint-version: ${version} -->`)
    .replace(new RegExp(`^Version: ${escape(current.version)}[ \\t]*$`, 'm'), `Version: ${version}`)
    .replaceAll(`sj-paint-${current.version}-`, `sj-paint-${version}-`)
    .replaceAll(`/releases/download/v${current.version}/`, `/releases/download/v${version}/`)
    .replaceAll(`/releases/tag/v${current.version}`, `/releases/tag/v${version}`)
    .replaceAll(`[v${current.version} `, `[v${version} `);
  const changelog = current.data['CHANGELOG.md'];
  if (new RegExp(`^## \\[${escape(version)}\\]`, 'm').test(changelog)) throw new Error(`CHANGELOG.md already contains [${version}].`);
  const firstHeading = changelog.search(/^## /m);
  if (firstHeading < 0) throw new Error('CHANGELOG.md is missing its release section.');
  const updates = {
    'src/version.js': `export const VERSION = '${version}';\n`, VERSION: `${version}\n`,
    'package.json': `${JSON.stringify(current.packageData, null, 2)}\n`,
    'package-lock.json': `${JSON.stringify(current.lockData, null, 2)}\n`, 'README.md': readme,
    'CHANGELOG.md': `${changelog.slice(0, firstHeading)}## [${version}] - Unreleased\n\n${changelog.slice(firstHeading)}`,
  };
  // Validate the complete proposed set before touching any file.
  check(path => updates[path]);
  const written = [];
  try {
    for (const [path, content] of Object.entries(updates)) { writeFileSync(resolve(root, path), content); written.push(path); }
  } catch (error) {
    for (const path of written.reverse()) writeFileSync(resolve(root, path), current.data[path]);
    throw error;
  }
  console.log(`Updated ${current.version} to ${version}. Add real release notes under [${version}] before staging a runtime change.`);
}

try {
  const [command = 'check', argument, ...extra] = process.argv.slice(2);
  if (extra.length || (command !== 'bump' && argument !== undefined)) throw new Error('Usage: node scripts/version.mjs check|staged|bump <semver>');
  if (command === 'check') console.log(`Version ${check(readWorking).version} is consistent.`);
  else if (command === 'staged') checkStaged();
  else if (command === 'bump') bump(argument);
  else throw new Error('Usage: node scripts/version.mjs check|staged|bump <semver>');
} catch (error) {
  console.error(`Version check failed: ${error.message}`);
  process.exitCode = 1;
}
