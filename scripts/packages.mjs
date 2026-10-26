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
import { access, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
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
const NFPM_CONFIGS = [
  { id: 'linux-amd64', asset: 'linux-x64', arch: 'amd64' },
  { id: 'linux-arm64', asset: 'linux-arm64', arch: 'arm64' },
  { id: 'linux-amd64-musl', asset: 'linux-x64-musl', arch: 'amd64' },
  { id: 'linux-arm64-musl', asset: 'linux-arm64-musl', arch: 'arm64' },
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

const ALPINE_CONFIGS = [
  { arch: 'x86_64', asset: 'linux-x64-musl' },
  { arch: 'aarch64', asset: 'linux-arm64-musl' },
];

const RECIPES = [
  ['homebrew/marmotta.rb', 'homebrew/marmotta.rb'],
  ['aur/PKGBUILD', 'aur/PKGBUILD'],
  ['rpm/marmotta.spec', 'rpm/marmotta.spec'],
  ['nix/default.nix', 'nix/default.nix'],
  ['scoop/marmotta.json', 'scoop/marmotta.json'],
  ['winget/version.yaml', 'winget/napi-bindings.marmotta.yaml'],
  ['winget/installer.yaml', 'winget/napi-bindings.marmotta.installer.yaml'],
  ['winget/locale.en-US.yaml', 'winget/napi-bindings.marmotta.locale.en-US.yaml'],
];

export function assetName(version, asset) {
  return `marmotta-v${version}-${asset.key}${asset.ext}`;
}

function assetKey(asset) {
  return asset.key.toUpperCase().replaceAll('-', '_');
}

function validateVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
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

async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
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

async function renderTemplate(templateName, outputPath, context) {
  const templatePath = resolve(root, 'packaging/templates', templateName);
  let source = await readFile(templatePath, 'utf8');
  source = source.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, name) => {
    if (!(name in context)) throw new Error(`Unknown template variable ${match} in ${templateName}`);
    return String(context[name]);
  });
  if (source.includes('{{')) throw new Error(`Unrendered template variable in ${templateName}`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, source);
}

export async function renderPackages({
  version = packageJson.version,
  checksums,
  outDir = resolve(root, 'packaging/out'),
  artifactsDir = resolve(root, 'dist'),
  changelogDate = new Date().toISOString().slice(0, 10),
} = {}) {
  validateVersion(version);
  if (!checksums) throw new Error('renderPackages requires a checksum map');

  const context = {
    VERSION: version,
    REPOSITORY,
    MAINTAINER,
    DESCRIPTION,
    CHANGELOG_DATE: changelogDate,
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
    context[`SRI_${key}`] = hexToSri(sha256);
  }
  if (missing.length > 0) {
    throw new Error(`Missing SHA-256 checksum${missing.length === 1 ? '' : 's'} for: ${missing.join(', ')}`);
  }

  const license = await readFile(resolve(root, 'LICENSE'));
  context.SHA256_LICENSE = createHash('sha256').update(license).digest('hex');

  await mkdir(resolve(outDir, 'recipes'), { recursive: true });
  await copyFile(resolve(root, 'LICENSE'), resolve(outDir, 'LICENSE'));
  await copyFile(resolve(root, 'packaging/README.md'), resolve(outDir, 'recipes/README.md'));

  const recipes = ['README.md'];
  for (const [template, output] of RECIPES) {
    await renderTemplate(template, resolve(outDir, 'recipes', output), context);
    recipes.push(output);
  }

  for (const config of ALPINE_CONFIGS) {
    const key = config.asset.toUpperCase().replaceAll('-', '_');
    await renderTemplate('alpine/APKBUILD', resolve(outDir, 'recipes/alpine', config.arch, 'APKBUILD'), {
      ...context,
      ALPINE_ARCH: config.arch,
      ALPINE_PLATFORM: config.asset,
      ALPINE_SHA256: context[`SHA256_${key}`],
    });
    recipes.push(`alpine/${config.arch}/APKBUILD`);
  }

  const packageConfigs = [];
  for (const config of NFPM_CONFIGS) {
    const key = config.asset.toUpperCase().replaceAll('-', '_');
    const output = `nfpm/nfpm-${config.id}.yaml`;
    await renderTemplate('nfpm/nfpm.yaml', resolve(outDir, output), {
      ...context,
      NFPM_ARCH: config.arch,
      BINARY: resolve(artifactsDir, context[`ASSET_${key}`]),
      LICENSE_FILE: resolve(outDir, 'LICENSE'),
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

function checkContains(haystack, needle, description) {
  if (!haystack.includes(needle)) {
    throw new Error(`${description}: expected to find ${JSON.stringify(needle)}`);
  }
}

// Verifies the structure of an nfpm-built package without installing it. This is intentionally
// tool-light: the same checks run in the release workflow and in the test suite.
export function verifyPackage({ path, type, version, arch }) {
  if (!commandExists('tar')) throw new Error('tar is required to verify packages');

  if (type === 'deb') {
    const members = capture('ar', ['t', path]).split('\n').map((line) => line.trim()).filter(Boolean);
    const controlMember = members.find((member) => /^control\.tar\.(gz|xz|zst)$/.test(member));
    const dataMember = members.find((member) => /^data\.tar\.(gz|xz|zst)$/.test(member));
    if (!controlMember || !dataMember) throw new Error(`${path}: missing Debian control or data archive`);

    const control = captureBuffer('tar', tarArgs(controlMember, false), {
      input: captureBuffer('ar', ['p', path, controlMember]),
    }).toString('utf8');
    checkContains(control, 'Package: marmotta', path);
    checkContains(control, `Version: ${version}`, path);
    checkContains(control, `Architecture: ${arch}`, path);

    const data = captureBuffer('tar', tarArgs(dataMember, true), {
      input: captureBuffer('ar', ['p', path, dataMember]),
    }).toString('utf8');
    checkContains(data, './usr/bin/marmotta', path);
    checkContains(data, './usr/share/doc/marmotta/copyright', path);
    return;
  }

  if (type === 'rpm') {
    const listing = commandExists('rpm')
      ? capture('rpm', ['-qpl', path])
      : commandExists('bsdtar')
        ? capture('bsdtar', ['-tf', path])
        : undefined;
    if (listing) checkContains(listing, '/usr/bin/marmotta', path);
    return;
  }

  if (type === 'apk') {
    const listing = capture('tar', ['-tzf', path]);
    checkContains(listing, 'usr/bin/marmotta', path);
    const info = capture('tar', ['-xzOf', path, '.PKGINFO']);
    checkContains(info, 'pkgname = marmotta', path);
    checkContains(info, `pkgver = ${version}`, path);
    checkContains(info, `arch = ${arch}`, path);
    return;
  }

  if (type === 'archlinux') {
    if (commandExists('bsdtar')) {
      checkContains(capture('bsdtar', ['-tf', path]), 'usr/bin/marmotta', path);
      const info = capture('bsdtar', ['-xOf', path, '.PKGINFO']);
      checkContains(info, 'pkgname = marmotta', path);
      checkContains(info, `pkgver = ${version}`, path);
      checkContains(info, `arch = ${arch}`, path);
      return;
    }
    if (commandExists('tar')) {
      checkContains(capture('tar', ['--zstd', '-tf', path]), 'usr/bin/marmotta', path);
      checkContains(capture('tar', ['--zstd', '-xOf', path, '.PKGINFO']), 'pkgname = marmotta', path);
      return;
    }
    throw new Error('bsdtar or tar with zstd support is required to verify Arch Linux packages');
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

  const manifest = await renderPackages({ version, checksums, outDir, artifactsDir });
  console.log(`Rendered ${manifest.recipes.length} recipes and ${manifest.packageConfigs.length} package configs in ${outDir}`);

  if (options.build) {
    const built = await buildPackages({ outDir, nfpm: options.nfpm });
    console.log(`Built ${built.artifacts.length} packages in ${resolve(outDir, 'artifacts')}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`packages: ${error.message}`);
    process.exit(1);
  });
}
