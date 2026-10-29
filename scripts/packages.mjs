#!/usr/bin/env node
// Renders the package-manager recipes for a Marmotta release and, with --build, builds
// .deb, .rpm, .apk, and Arch Linux packages from the standalone executables using nfpm.
//
// Usage:
//   node scripts/packages.mjs --artifacts dist --out packages
//   node scripts/packages.mjs --artifacts dist --out packages --build
//   node scripts/packages.mjs --version 0.8.0 --sums dist/SHA256SUMS --artifacts dist --out packages
//
// The checksums are read from SHA256SUMS when --sums is given; otherwise they are computed from
// the release assets in --artifacts. Only the Linux assets are packaged as native packages; the
// Homebrew, Nix, Scoop, and winget recipes reference the matching macOS/Windows assets.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createReadStream, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

export const REPOSITORY = packageJson.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
const REPOSITORY_SLUG = new URL(REPOSITORY).pathname.replace(/^\//, '');
export const MAINTAINER = `${packageJson.author.name} <${packageJson.author.email}>`;
export const DESCRIPTION = 'Node.js native addon build tool using Zig';

// Every standalone executable published by the release workflow. `ext` is used for the Windows
// assets, and `key` is the platform suffix used in the release file name.
export const ASSETS = [
  { key: 'linux-x64', ext: '' },
  { key: 'linux-arm64', ext: '' },
  { key: 'linux-x64-musl', ext: '' },
  { key: 'linux-arm64-musl', ext: '' },
  { key: 'darwin-x64', ext: '' },
  { key: 'darwin-arm64', ext: '' },
  { key: 'windows-x64', ext: '.exe' },
  { key: 'windows-arm64', ext: '.exe' },
];

// nfpm builds all of the native Linux packages from these configs. Alpine uses the musl
// executables; Debian, RPM, and Arch use the glibc executables.
const assetsByKey = new Map(ASSETS.map((asset) => [asset.key, asset]));
const NFPM_CONFIGS = [
  { id: 'linux-amd64', asset: assetsByKey.get('linux-x64'), arch: 'amd64' },
  { id: 'linux-arm64', asset: assetsByKey.get('linux-arm64'), arch: 'arm64' },
  { id: 'linux-amd64-musl', asset: assetsByKey.get('linux-x64-musl'), arch: 'amd64' },
  { id: 'linux-arm64-musl', asset: assetsByKey.get('linux-arm64-musl'), arch: 'arm64' },
];

// Package targets produced by `--build`. `arch` is the package-manager architecture name.
const PACKAGE_TARGETS = [
  { packager: 'deb', config: 'linux-amd64', arch: 'amd64', target: (version) => `marmotta_${version}_amd64.deb` },
  { packager: 'deb', config: 'linux-arm64', arch: 'arm64', target: (version) => `marmotta_${version}_arm64.deb` },
  { packager: 'rpm', config: 'linux-amd64', arch: 'x86_64', target: (version) => `marmotta-${version}-1.x86_64.rpm` },
  { packager: 'rpm', config: 'linux-arm64', arch: 'aarch64', target: (version) => `marmotta-${version}-1.aarch64.rpm` },
  { packager: 'archlinux', config: 'linux-amd64', arch: 'x86_64', target: (version) => `marmotta-${version}-1-x86_64.pkg.tar.zst` },
  { packager: 'archlinux', config: 'linux-arm64', arch: 'aarch64', target: (version) => `marmotta-${version}-1-aarch64.pkg.tar.zst` },
  { packager: 'apk', config: 'linux-amd64-musl', arch: 'x86_64', target: (version) => `marmotta-${version}-r0.x86_64.apk` },
  { packager: 'apk', config: 'linux-arm64-musl', arch: 'aarch64', target: (version) => `marmotta-${version}-r0.aarch64.apk` },
];

const RECIPES = [
  ['homebrew/marmotta.rb', 'homebrew/marmotta.rb'],
  ['aur/PKGBUILD', 'aur/PKGBUILD'],
  ['rpm/marmotta.spec', 'rpm/marmotta.spec'],
  ['alpine/APKBUILD', 'alpine/APKBUILD'],
  ['nix/default.nix', 'nix/default.nix'],
  ['scoop/marmotta.json', 'scoop/marmotta.json'],
  ['winget/version.yaml', 'winget/napi-bindings.marmotta.yaml'],
  ['winget/installer.yaml', 'winget/napi-bindings.marmotta.installer.yaml'],
  ['winget/locale.en-US.yaml', 'winget/napi-bindings.marmotta.locale.en-US.yaml'],
];

const RPM_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RPM_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// RPM %changelog requires dates in the C-locale `ddd MMM dd yyyy` format (for example
// `Fri Jan 02 2026`); rpmbuild rejects ISO `YYYY-MM-DD` dates.
export function formatChangelogDate(
  input = process.env.SOURCE_DATE_EPOCH ? Number(process.env.SOURCE_DATE_EPOCH) * 1000 : Date.now(),
) {
  let date;
  if (input instanceof Date) {
    date = input;
  } else if (typeof input === 'string') {
    const rpmMatch = /^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) (\d{2}) (\d{4})$/.exec(input);
    if (rpmMatch) {
      const monthIndex = RPM_MONTHS.indexOf(rpmMatch[2]);
      if (monthIndex === -1) throw new Error(`Invalid changelog date: ${input}`);
      date = new Date(Date.UTC(Number(rpmMatch[4]), monthIndex, Number(rpmMatch[3])));
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
      date = new Date(`${input}T00:00:00Z`);
    } else {
      date = new Date(input);
    }
  } else {
    date = new Date(input);
  }
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid changelog date: ${input}`);
  }
  const dayName = RPM_WEEKDAYS[date.getUTCDay()];
  const monthName = RPM_MONTHS[date.getUTCMonth()];
  const day = String(date.getUTCDate()).padStart(2, '0');
  const year = date.getUTCFullYear();
  const formatted = `${dayName} ${monthName} ${day} ${year}`;
  if (typeof input === 'string' && /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{4}$/.test(input) && formatted !== input) {
    throw new Error(`Invalid changelog date: ${input} (expected ${formatted})`);
  }
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input) && date.toISOString().slice(0, 10) !== input) {
    throw new Error(`Invalid changelog date: ${input}`);
  }
  return formatted;
}

export function assetName(version, asset) {
  return `marmotta-v${version}-${asset.key}${asset.ext}`;
}

function assetKey(asset) {
  return asset.key.toUpperCase().replaceAll('-', '_');
}

function validateVersion(version) {
  // nfpm rewrites versions with pre-release or build metadata (`~` for deb/rpm, `_` for apk), and
  // the generated RPM spec and APKBUILD would be invalid, so only plain releases are supported.
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid release version: ${version} (expected a plain MAJOR.MINOR.PATCH version)`);
  }
}

export function parseChecksums(text) {
  const checksums = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match) checksums.set(match[2], match[1].toLowerCase());
  }
  return checksums;
}

export function hexToSri(hex) {
  if (!/^[a-fA-F0-9]{64}$/.test(hex)) throw new Error(`Invalid SHA-256 hash: ${hex}`);
  return `sha256-${Buffer.from(hex, 'hex').toString('base64')}`;
}

async function hashFile(path, algorithm) {
  const hash = createHash(algorithm);
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

async function sha256File(path) {
  return hashFile(path, 'sha256');
}

async function sha512Artifact(directory, name) {
  try {
    return await hashFile(resolve(directory, name), 'sha512');
  } catch (error) {
    throw new Error(
      `Cannot compute the SHA-512 checksum for ${name}: ${error.message}. The Alpine APKBUILD requires the release assets in --artifacts.`,
    );
  }
}

// The release recipes download LICENSE from raw.githubusercontent.com at the release tag. Prefer the
// committed blob for that tag so rendering an older version with --version cannot hash the wrong
// file; fall back to the working tree when the tag is not available locally.
function licenseAtTag(version) {
  const result = spawnSync('git', ['show', `v${version}:LICENSE`], {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0 || !result.stdout || result.stdout.length === 0) return undefined;
  return result.stdout.toString('utf8');
}

export async function checksumsFromArtifacts(directory, version) {
  validateVersion(version);
  const checksums = new Map();
  for (const asset of ASSETS) {
    const name = assetName(version, asset);
    checksums.set(name, await sha256File(resolve(directory, name)));
  }
  return checksums;
}

// Confirms that the executables on disk are the ones the recipes point at. Without this, a stale
// dist/ directory would produce packages whose binaries do not match the published SHA256SUMS.
export async function verifyArtifacts(directory, checksums, version) {
  validateVersion(version);
  for (const asset of ASSETS) {
    const name = assetName(version, asset);
    const expected = checksums.get(name);
    if (!expected) throw new Error(`Missing SHA-256 checksum for ${name}`);
    const actual = await sha256File(resolve(directory, name));
    if (actual !== expected) {
      throw new Error(`${name}: SHA-256 mismatch (SHA256SUMS has ${expected}, file has ${actual})`);
    }
  }
}

async function renderTemplate(templateName, outputPath, context) {
  const templatePath = resolve(root, 'packaging/templates', templateName);
  // Always emit LF: the recipes are shell scripts and YAML that run on Linux, and a CRLF checkout
  // on Windows must not leak into the published artifacts.
  const source = (await readFile(templatePath, 'utf8')).replace(/\r\n/g, '\n');
  const rendered = source.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, name) => {
    if (!(name in context)) throw new Error(`Unknown template variable ${match} in ${templateName}`);
    return String(context[name]);
  });
  if (rendered.includes('{{')) throw new Error(`Unrendered template variable in ${templateName}`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, rendered);
}

export async function renderPackages({
  version = packageJson.version,
  checksums,
  outDir = resolve(root, 'packaging/out'),
  artifactsDir = resolve(root, 'dist'),
  changelogDate = formatChangelogDate(),
} = {}) {
  validateVersion(version);
  if (!checksums) throw new Error('renderPackages requires a checksum map');

  const context = {
    VERSION: version,
    REPOSITORY,
    REPOSITORY_SLUG,
    MAINTAINER,
    DESCRIPTION,
    CHANGELOG_DATE: formatChangelogDate(changelogDate),
    LICENSE_URL: `https://raw.githubusercontent.com/${REPOSITORY_SLUG}/v${version}/LICENSE`,
  };

  const missing = [];
  for (const asset of ASSETS) {
    const name = assetName(version, asset);
    const sha256 = checksums.get(name);
    if (!sha256) {
      missing.push(name);
      continue;
    }
    const key = assetKey(asset);
    context[`ASSET_${key}`] = name;
    context[`SHA256_${key}`] = sha256;
    context[`SHA256_UPPER_${key}`] = sha256.toUpperCase();
    context[`SRI_${key}`] = hexToSri(sha256);
    // aports requires SHA-512 checksums; the musl assets are the only ones used by the APKBUILD.
    if (asset.key.endsWith('-musl')) {
      context[`SHA512_${key}`] = await sha512Artifact(artifactsDir, name);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing SHA-256 checksum${missing.length === 1 ? '' : 's'} for: ${missing.join(', ')}`);
  }

  const license = (licenseAtTag(version) ?? (await readFile(resolve(root, 'LICENSE'), 'utf8'))).replace(/\r\n/g, '\n');
  context.SHA256_LICENSE = createHash('sha256').update(license).digest('hex');
  context.SHA512_LICENSE = createHash('sha512').update(license).digest('hex');

  await mkdir(resolve(outDir, 'recipes'), { recursive: true });
  // Write the normalized license so the hash above matches the file users download from
  // raw.githubusercontent (which always serves LF line endings), even on a CRLF checkout.
  await writeFile(resolve(outDir, 'LICENSE'), license);
  const readme = (await readFile(resolve(root, 'packaging/README.md'), 'utf8')).replace(/\r\n/g, '\n');
  await writeFile(resolve(outDir, 'recipes/README.md'), readme);

  const recipes = ['README.md'];
  for (const [template, output] of RECIPES) {
    await renderTemplate(template, resolve(outDir, 'recipes', output), context);
    recipes.push(output);
  }

  const packageConfigs = [];
  for (const config of NFPM_CONFIGS) {
    const key = assetKey(config.asset);
    const output = `nfpm/nfpm-${config.id}.yaml`;
    await renderTemplate('nfpm/nfpm.yaml', resolve(outDir, output), {
      ...context,
      NFPM_ARCH: config.arch,
      BINARY: JSON.stringify(resolve(artifactsDir, context[`ASSET_${key}`])),
      LICENSE_FILE: JSON.stringify(resolve(outDir, 'LICENSE')),
    });
  }
  for (const target of PACKAGE_TARGETS) {
    const config = `nfpm/nfpm-${target.config}.yaml`;
    packageConfigs.push({
      packager: target.packager,
      arch: target.arch,
      config,
      target: target.target(version),
    });
  }

  const manifest = {
    version,
    repository: REPOSITORY,
    assets: Object.fromEntries(
      ASSETS.map((asset) => [asset.key, { filename: assetName(version, asset), sha256: checksums.get(assetName(version, asset)) }]),
    ),
    recipes,
    packageConfigs,
    artifacts: [],
  };
  await writeFile(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function commandExists(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`"${command} ${args.join(' ')}" exited with ${result.status}\n${result.stderr ?? ''}`);
  }
  return result.stdout;
}

function captureBuffer(command, args, options = {}) {
  const result = spawnSync(command, args, { maxBuffer: 1024 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`"${command} ${args.join(' ')}" exited with ${result.status}\n${result.stderr?.toString() ?? ''}`);
  }
  return result.stdout;
}

function tarArgs(member, listOnly) {
  const action = listOnly ? 't' : 'xO';
  const flag = `-${action}`;
  if (member.endsWith('.gz')) return [`-z${action}`];
  if (member.endsWith('.xz')) return [`-J${action}`];
  if (member.endsWith('.zst')) return ['--zstd', flag];
  throw new Error(`Unsupported archive member: ${member}`);
}

function checkLine(haystack, expected, description) {
  const lines = haystack.split(/\r?\n/).map((line) => line.trim());
  if (!lines.includes(expected)) {
    throw new Error(`${description}: expected a line ${JSON.stringify(expected)}`);
  }
}

function checkLineMatches(haystack, pattern, description) {
  const lines = haystack.split(/\r?\n/).map((line) => line.trim());
  if (!lines.some((line) => pattern.test(line))) {
    throw new Error(`${description}: expected a line matching ${pattern}`);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const RPM_HEADER_MAGIC = 0x8eade801;
const RPM_TYPE_STRING = 6;
const RPM_TAGS = { name: 1000, version: 1001, release: 1002, arch: 1022 };

// Reads one RPM header (magic, index, data store). Only the string tags used for verification are
// decoded; the header is skipped for the rest. This avoids depending on the rpm binary.
function readRpmHeader(buffer, offset) {
  if (offset + 16 > buffer.length) throw new Error('Truncated RPM header');
  if (buffer.readUInt32BE(offset) !== RPM_HEADER_MAGIC) {
    throw new Error(`Invalid RPM header at offset ${offset}`);
  }
  const indexCount = buffer.readUInt32BE(offset + 8);
  const dataSize = buffer.readUInt32BE(offset + 12);
  const indexOffset = offset + 16;
  const dataOffset = indexOffset + indexCount * 16;
  const end = dataOffset + dataSize;
  if (end > buffer.length) throw new Error('Truncated RPM header data');

  const strings = new Map();
  const tags = new Set(Object.values(RPM_TAGS));
  for (let index = 0; index < indexCount; index += 1) {
    const entry = indexOffset + index * 16;
    const tag = buffer.readUInt32BE(entry);
    const type = buffer.readUInt32BE(entry + 4);
    const valueOffset = buffer.readUInt32BE(entry + 8);
    if (type !== RPM_TYPE_STRING || !tags.has(tag)) continue;
    const start = dataOffset + valueOffset;
    const stop = buffer.indexOf(0, start);
    strings.set(tag, buffer.toString('utf8', start, stop === -1 ? end : stop));
  }
  return { strings, next: Math.ceil(end / 8) * 8 };
}

export function readRpmMetadata(buffer) {
  // Layout: 96-byte lead, signature header, main header. Both headers are padded to 8 bytes.
  const signature = readRpmHeader(buffer, 96);
  const main = readRpmHeader(buffer, signature.next);
  return {
    name: main.strings.get(RPM_TAGS.name),
    version: main.strings.get(RPM_TAGS.version),
    release: main.strings.get(RPM_TAGS.release),
    arch: main.strings.get(RPM_TAGS.arch),
  };
}

function rpmListing(path) {
  if (commandExists('rpm')) return capture('rpm', ['-qpl', path]);
  if (commandExists('bsdtar')) return capture('bsdtar', ['-tf', path]);
  throw new Error('rpm or bsdtar is required to list RPM contents');
}

// Verifies the structure of an nfpm-built package without installing it. This is intentionally
// tool-light: the same checks run in the release workflow and in the test suite.
export function verifyPackage({ path, type, version, arch }) {
  if (!commandExists('tar')) throw new Error('tar is required to verify packages');

  if (type === 'deb') {
    if (!commandExists('ar')) throw new Error('ar is required to verify Debian packages');
    const members = capture('ar', ['t', path]).split('\n').map((line) => line.trim()).filter(Boolean);
    const controlMember = members.find((member) => /^control\.tar\.(gz|xz|zst)$/.test(member));
    const dataMember = members.find((member) => /^data\.tar\.(gz|xz|zst)$/.test(member));
    if (!controlMember || !dataMember) throw new Error(`${path}: missing Debian control or data archive`);

    const control = captureBuffer('tar', tarArgs(controlMember, false), {
      input: captureBuffer('ar', ['p', path, controlMember]),
    }).toString('utf8');
    checkLine(control, 'Package: marmotta', path);
    checkLine(control, `Version: ${version}`, path);
    checkLine(control, `Architecture: ${arch}`, path);

    const data = captureBuffer('tar', tarArgs(dataMember, true), {
      input: captureBuffer('ar', ['p', path, dataMember]),
    }).toString('utf8');
    checkLine(data, './usr/bin/marmotta', path);
    checkLine(data, './usr/share/doc/marmotta/copyright', path);
    return;
  }

  if (type === 'rpm') {
    const metadata = readRpmMetadata(readFileSync(path));
    for (const [field, expected] of [['name', 'marmotta'], ['version', version], ['arch', arch]]) {
      if (metadata[field] !== expected) {
        throw new Error(`${path}: expected RPM ${field} ${JSON.stringify(expected)}, got ${JSON.stringify(metadata[field])}`);
      }
    }
    const listing = rpmListing(path);
    checkLine(listing, '/usr/bin/marmotta', path);
    checkLine(listing, '/usr/share/licenses/marmotta/LICENSE', path);
    return;
  }

  if (type === 'apk') {
    const listing = capture('tar', ['-tzf', path]);
    checkLine(listing, 'usr/bin/marmotta', path);
    checkLine(listing, 'usr/share/licenses/marmotta/LICENSE', path);
    const info = capture('tar', ['-xzOf', path, '.PKGINFO']);
    checkLine(info, 'pkgname = marmotta', path);
    checkLine(info, `pkgver = ${version}`, path);
    checkLine(info, `arch = ${arch}`, path);
    return;
  }

  if (type === 'archlinux') {
    const [tool, listArgs, infoArgs] = commandExists('bsdtar')
      ? ['bsdtar', ['-tf', path], ['-xOf', path, '.PKGINFO']]
      : ['tar', ['--zstd', '-tf', path], ['--zstd', '-xOf', path, '.PKGINFO']];
    const listing = capture(tool, listArgs);
    checkLine(listing, 'usr/bin/marmotta', path);
    checkLine(listing, 'usr/share/licenses/marmotta/LICENSE', path);
    const info = capture(tool, infoArgs);
    checkLine(info, 'pkgname = marmotta', path);
    // nfpm records the package release in pkgver for Arch Linux (`1.2.3-1`).
    checkLineMatches(info, new RegExp(`^pkgver = ${escapeRegExp(version)}(?:-\\d+)?$`), path);
    checkLine(info, `arch = ${arch}`, path);
    return;
  }

  throw new Error(`Unknown package type: ${type}`);
}

export async function buildPackages({ outDir = resolve(root, 'packaging/out'), nfpm = process.env.NFPM || 'nfpm' } = {}) {
  const manifestPath = resolve(outDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const outputDirectory = resolve(outDir, 'artifacts');
  await mkdir(outputDirectory, { recursive: true });

  if (!commandExists(nfpm)) {
    throw new Error(`nfpm not found (${nfpm}); install nfpm or set NFPM to its path`);
  }

  const artifacts = [];
  for (const item of manifest.packageConfigs) {
    const target = resolve(outputDirectory, item.target);
    const result = spawnSync(
      nfpm,
      ['package', '--config', resolve(outDir, item.config), '--packager', item.packager, '--target', target],
      { stdio: 'inherit', env: { ...process.env, SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH ?? '315532800' } },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`nfpm failed to build ${item.target} with exit code ${result.status}`);
    await access(target);
    verifyPackage({ path: target, type: item.packager, version: manifest.version, arch: item.arch });
    artifacts.push({ ...item, path: `artifacts/${item.target}`, bytes: (await stat(target)).size });
  }

  manifest.artifacts = artifacts;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function parseArgs(argv) {
  const options = { build: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--build') {
      options.build = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (['--version', '--sums', '--artifacts', '--out', '--nfpm'].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) throw new Error(`Missing value for ${arg}`);
      options[arg.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`usage: node scripts/packages.mjs [options]

  --version <version>   release version (default: package.json)
  --sums <file>         SHA256SUMS file (default: compute from --artifacts)
  --artifacts <dir>     directory with the release executables (default: dist)
  --out <dir>           output directory (default: packaging/out)
  --build               build .deb, .rpm, .apk, and Arch Linux packages with nfpm
  --nfpm <path>         nfpm executable (default: $NFPM or "nfpm")
`);
    return;
  }

  const version = options.version ?? packageJson.version;
  const artifactsDir = resolve(options.artifacts ?? 'dist');
  const outDir = resolve(options.out ?? 'packaging/out');
  const checksums = options.sums
    ? parseChecksums(await readFile(resolve(options.sums), 'utf8'))
    : await checksumsFromArtifacts(artifactsDir, version);

  // When the recipes come from a published SHA256SUMS and we are about to build packages, make
  // sure the executables in --artifacts are the exact files those checksums describe.
  if (options.build && options.sums) {
    await verifyArtifacts(artifactsDir, checksums, version);
  }

  const manifest = await renderPackages({ version, checksums, outDir, artifactsDir });
  console.log(`Rendered ${manifest.recipes.length} recipes and ${manifest.packageConfigs.length} package configs in ${outDir}`);

  if (options.build) {
    const built = await buildPackages({ outDir, nfpm: options.nfpm });
    console.log(`Built ${built.artifacts.length} packages in ${resolve(outDir, 'artifacts')}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`packages: ${error.message}`);
    process.exit(1);
  });
}
