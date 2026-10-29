import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ASSETS,
  assetName,
  buildPackages,
  checksumsFromArtifacts,
  formatChangelogDate,
  hexToSri,
  parseChecksums,
  readRpmMetadata,
  renderPackages,
  verifyArtifacts,
  verifyPackage,
} from '../scripts/packages.mjs';

const version = '1.2.3';

function hasCommand(command) {
  if (process.platform === 'win32') return false;
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

async function writeFixtures(directory) {
  for (const asset of ASSETS) {
    const name = assetName(version, asset);
    await writeFile(join(directory, name), `#!/bin/sh\necho "marmotta ${version}"\n`, { mode: 0o755 });
  }
  return checksumsFromArtifacts(directory, version);
}

async function sha512(path) {
  return createHash('sha512').update(await readFile(path)).digest('hex');
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'marmotta-packaging-'));
  const artifacts = join(directory, 'artifacts');
  const out = join(directory, 'out');
  await mkdir(artifacts, { recursive: true });
  const checksums = await writeFixtures(artifacts);
  return { directory, artifacts, out, checksums };
}

test('parseChecksums accepts GNU sha256sum output', () => {
  const first = 'a'.repeat(64);
  const second = 'B'.repeat(64);
  const checksums = parseChecksums(
    `${first}  marmotta-v1.2.3-linux-x64\n${second} *marmotta-v1.2.3-windows-x64.exe\n\nnot a checksum\n`,
  );

  assert.equal(checksums.get('marmotta-v1.2.3-linux-x64'), first);
  assert.equal(checksums.get('marmotta-v1.2.3-windows-x64.exe'), second.toLowerCase());
  assert.equal(checksums.size, 2);
});

test('hexToSri converts a SHA-256 digest to the Nix SRI format', () => {
  assert.equal(hexToSri('00'.repeat(32)), 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  assert.throws(() => hexToSri('not-a-hash'), /Invalid SHA-256 hash/);
});

test('formatChangelogDate formats dates in the RPM changelog format', () => {
  assert.equal(formatChangelogDate('2026-01-02'), 'Fri Jan 02 2026');
  assert.equal(formatChangelogDate('Fri Jan 02 2026'), 'Fri Jan 02 2026');
  assert.equal(formatChangelogDate(new Date('2026-01-02T12:00:00Z')), 'Fri Jan 02 2026');
  assert.throws(() => formatChangelogDate('Mon Jan 02 2026'), /Invalid changelog date/);
  assert.throws(() => formatChangelogDate('Foo Bar 99 2026'), /Invalid changelog date/);
  assert.throws(() => formatChangelogDate('2026-02-30'), /Invalid changelog date/);
  assert.throws(() => formatChangelogDate('not-a-date'), /Invalid changelog date/);
});

test('renderPackages rejects pre-release versions that package managers rewrite', async (t) => {
  const { directory, artifacts, out, checksums } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));

  await assert.rejects(
    renderPackages({ version: '1.2.3-rc.1', checksums, outDir: out, artifactsDir: artifacts }),
    /Invalid release version: 1\.2\.3-rc\.1.*plain MAJOR\.MINOR\.PATCH/,
  );
});

test('verifyArtifacts rejects executables that do not match SHA256SUMS', async (t) => {
  const { directory, artifacts, checksums } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));

  await verifyArtifacts(artifacts, checksums, version);

  const stale = assetName(version, { key: 'linux-x64', ext: '' });
  await writeFile(join(artifacts, stale), '#!/bin/sh\necho stale\n', { mode: 0o755 });
  await assert.rejects(verifyArtifacts(artifacts, checksums, version), /SHA-256 mismatch/);

  checksums.delete(stale);
  await assert.rejects(verifyArtifacts(artifacts, checksums, version), /Missing SHA-256 checksum/);
});

test('renderPackages writes every recipe with checksums and no placeholders', async (t) => {
  const { directory, artifacts, out, checksums } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));

  const manifest = await renderPackages({
    version,
    checksums,
    outDir: out,
    artifactsDir: artifacts,
    changelogDate: '2026-01-02',
  });

  assert.equal(manifest.version, version);
  assert.equal(Object.keys(manifest.assets).length, ASSETS.length);
  assert.equal(manifest.recipes.length, 10);
  assert.equal(manifest.packageConfigs.length, 8);

  const homebrew = await readFile(join(out, 'recipes/homebrew/marmotta.rb'), 'utf8');
  assert.match(homebrew, /class Marmotta < Formula/);
  assert.match(homebrew, /on_arm do/);
  assert.match(homebrew, /on_intel do/);
  assert.match(homebrew, /marmotta-v1\.2\.3-darwin-arm64/);
  assert.match(homebrew, new RegExp(manifest.assets['darwin-arm64'].sha256));
  assert.match(homebrew, /marmotta-v1\.2\.3-linux-x64/);
  assert.doesNotMatch(homebrew, /\{\{/);

  const aur = await readFile(join(out, 'recipes/aur/PKGBUILD'), 'utf8');
  assert.match(aur, /pkgname=marmotta-bin/);
  assert.match(aur, /source_x86_64=/);
  assert.match(aur, /source_aarch64=/);
  assert.match(aur, /v\$\{pkgver\}\/LICENSE/);
  assert.match(aur, new RegExp(manifest.assets['linux-x64'].sha256));
  assert.match(aur, new RegExp(manifest.assets['linux-arm64'].sha256));
  assert.match(aur, /depends=\('glibc'\)/);
  assert.doesNotMatch(aur, /gcc-libs/);
  assert.match(aur, /options=\('!strip' '!debug'\)/);
  assert.doesNotMatch(aur, /\{\{/);

  const alpine = await readFile(join(out, 'recipes/alpine/APKBUILD'), 'utf8');
  assert.match(alpine, /arch="x86_64 aarch64"/);
  assert.match(alpine, /options="!check !strip"/);
  assert.match(alpine, /case "\$CARCH" in/);
  assert.doesNotMatch(alpine, /source_x86_64|sha256sums/);
  assert.doesNotMatch(alpine, /\{\{/);
  assert.doesNotMatch(alpine, /\r\n/);

  const muslX64 = await sha512(join(artifacts, assetName(version, { key: 'linux-x64-musl', ext: '' })));
  const muslArm64 = await sha512(join(artifacts, assetName(version, { key: 'linux-arm64-musl', ext: '' })));
  assert.match(alpine, new RegExp(`${muslX64}  marmotta-v1\\.2\\.3-linux-x64-musl`));
  assert.match(alpine, new RegExp(`${muslArm64}  marmotta-v1\\.2\\.3-linux-arm64-musl`));

  const rpm = await readFile(join(out, 'recipes/rpm/marmotta.spec'), 'utf8');
  assert.match(rpm, /^%global __strip \/bin\/true$/m);
  assert.match(rpm, /^%global debug_package %\{nil\}$/m);
  assert.match(rpm, /^Source0:\s+.*marmotta-v1\.2\.3-linux-x64$/m);
  assert.match(rpm, /^Source1:\s+.*marmotta-v1\.2\.3-linux-arm64$/m);
  assert.match(rpm, /^\* Fri Jan 02 2026 /m);
  assert.doesNotMatch(rpm, /\{\{/);

  const nix = await readFile(join(out, 'recipes/nix/default.nix'), 'utf8');
  assert.match(nix, /x86_64-linux = \{/);
  assert.match(nix, /sha256-/);
  assert.match(nix, /dontStrip = true;/);
  assert.match(nix, /nativeBuildInputs = lib\.optionals stdenv\.isLinux \[ autoPatchelfHook \];/);
  assert.doesNotMatch(nix, /\{\{/);

  const scoop = JSON.parse(await readFile(join(out, 'recipes/scoop/marmotta.json'), 'utf8'));
  assert.equal(scoop.version, version);
  assert.equal(scoop.architecture['64bit'].hash, manifest.assets['windows-x64'].sha256);
  assert.equal(scoop.architecture.arm64.hash, manifest.assets['windows-arm64'].sha256);
  assert.equal(scoop.architecture['64bit'].bin, 'marmotta.exe');
  assert.match(scoop.architecture['64bit'].url, /#\/marmotta\.exe$/);
  assert.match(scoop.autoupdate.architecture.arm64.url, /#\/marmotta\.exe$/);
  assert.equal(scoop.autoupdate.hash.url, '$baseurl/SHA256SUMS');

  const wingetVersion = await readFile(join(out, 'recipes/winget/napi-bindings.marmotta.yaml'), 'utf8');
  assert.match(wingetVersion, /^# yaml-language-server: \$schema=/);
  assert.doesNotMatch(wingetVersion, /\{\{/);

  const wingetInstaller = await readFile(join(out, 'recipes/winget/napi-bindings.marmotta.installer.yaml'), 'utf8');
  assert.match(wingetInstaller, /PackageVersion: "1\.2\.3"/);
  assert.match(wingetInstaller, new RegExp(`InstallerSha256: ${manifest.assets['windows-x64'].sha256.toUpperCase()}`));
  assert.doesNotMatch(wingetInstaller, /\{\{/);

  const recipesReadme = await readFile(join(out, 'recipes/README.md'), 'utf8');
  assert.doesNotMatch(recipesReadme, /\r\n/);

  const nfpm = await readFile(join(out, 'nfpm/nfpm-linux-amd64.yaml'), 'utf8');
  assert.match(nfpm, /arch: amd64/);
  assert.match(nfpm, new RegExp(`src: ".*${assetName(version, { key: 'linux-x64', ext: '' })}"`));
  assert.match(nfpm, /dst: \/usr\/share\/doc\/marmotta\/copyright\n    packager: deb/);
  assert.match(nfpm, /dst: \/usr\/share\/licenses\/marmotta\/LICENSE\n    packager: rpm/);
  assert.match(nfpm, /dst: \/usr\/share\/licenses\/marmotta\/LICENSE\n    packager: apk/);
  assert.match(nfpm, /dst: \/usr\/share\/licenses\/marmotta\/LICENSE\n    packager: archlinux/);
  assert.doesNotMatch(nfpm, /\{\{/);
  assert.doesNotMatch(nfpm, /\r\n/);

  // The license hash must be the LF version served by raw.githubusercontent.com.
  const license = await readFile(join(out, 'LICENSE'), 'utf8');
  assert.doesNotMatch(license, /\r\n/);
  const expectedLicenseSha256 = createHash('sha256').update(license).digest('hex');
  const expectedLicenseSha512 = createHash('sha512').update(license).digest('hex');
  assert.match(aur, new RegExp(`${expectedLicenseSha256}`));
  assert.match(alpine, new RegExp(`${expectedLicenseSha512}  LICENSE`));

  const manifestOnDisk = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifestOnDisk, manifest);

  if (hasCommand('bash')) {
    for (const recipe of ['aur/PKGBUILD', 'alpine/APKBUILD']) {
      const result = spawnSync('bash', ['-n', join(out, 'recipes', recipe)], { encoding: 'utf8' });
      assert.equal(result.status, 0, `${recipe}: ${result.stderr}`);
    }
  }

  if (hasCommand('sh')) {
    // abuild sources the APKBUILD and has no source_$CARCH support, so each arch must set source.
    for (const [arch, asset] of [
      ['x86_64', 'linux-x64-musl'],
      ['aarch64', 'linux-arm64-musl'],
    ]) {
      const result = spawnSync('sh', ['-c', '. ./APKBUILD && printf "%s\\n%s\\n" "$source" "$sha512sums"'], {
        cwd: join(out, 'recipes/alpine'),
        encoding: 'utf8',
        env: { ...process.env, CARCH: arch },
      });
      assert.equal(result.status, 0, `${arch}: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`marmotta-v1\\.2\\.3-${asset}`));
      assert.match(result.stdout, /[0-9a-f]{128}  marmotta-v1\.2\.3-linux-/);
    }
  }

  if (hasCommand('ruby')) {
    const result = spawnSync('ruby', ['-c', join(out, 'recipes/homebrew/marmotta.rb')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }

  if (hasCommand('makepkg') && process.platform === 'linux') {
    const result = spawnSync('makepkg', ['--printsrcinfo'], {
      cwd: join(out, 'recipes/aur'),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /pkgver = 1\.2\.3/);
    assert.match(result.stdout, /source_aarch64 = .*marmotta-v1\.2\.3-linux-arm64/);
  }
});

test('renderPackages rejects an incomplete SHA256SUMS file', async (t) => {
  const { directory, artifacts, out, checksums } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));

  checksums.delete(assetName(version, { key: 'darwin-arm64', ext: '' }));
  await assert.rejects(
    renderPackages({ version, checksums, outDir: out, artifactsDir: artifacts }),
    /Missing SHA-256 checksum.*marmotta-v1\.2\.3-darwin-arm64/,
  );
});

test('buildPackages builds and verifies native packages with nfpm', async (t) => {
  const nfpm = process.env.NFPM ?? 'nfpm';
  if (!hasCommand(nfpm)) {
    t.skip(`nfpm is not available (${nfpm})`);
    return;
  }
  if (process.platform !== 'linux') {
    t.skip('native package building is only tested on Linux');
    return;
  }

  const { directory, artifacts, out, checksums } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));

  await renderPackages({ version, checksums, outDir: out, artifactsDir: artifacts });
  const manifest = await buildPackages({ outDir: out, nfpm });

  assert.equal(manifest.artifacts.length, 8);
  for (const artifact of manifest.artifacts) {
    assert.ok(artifact.bytes > 0, `${artifact.target} is empty`);
    const path = join(out, artifact.path);
    verifyPackage({ path, type: artifact.packager, version, arch: artifact.arch });
  }

  if (hasCommand('ar')) {
    const deb = join(out, 'artifacts', `marmotta_${version}_amd64.deb`);
    const debControl = spawnSync('ar', ['p', deb, 'control.tar.gz']).stdout;
    const control = spawnSync('tar', ['-xzO'], { input: debControl, encoding: 'utf8' }).stdout;
    assert.match(control, /Depends: libc6/);

    const debData = spawnSync('ar', ['p', deb, 'data.tar.gz']).stdout;
    const binary = spawnSync('tar', ['-xzO', './usr/bin/marmotta'], { input: debData, encoding: 'utf8' }).stdout;
    assert.equal(binary, `#!/bin/sh\necho "marmotta ${version}"\n`);
  }

  const apkInfo = spawnSync('tar', ['-xzOf', join(out, 'artifacts', `marmotta-${version}-r0.x86_64.apk`), '.PKGINFO'], {
    encoding: 'utf8',
  }).stdout;
  assert.match(apkInfo, /depend = libstdc\+\+/);

  const archPackage = join(out, 'artifacts', `marmotta-${version}-1-x86_64.pkg.tar.zst`);
  const [archTool, archListArgs, archInfoArgs] = hasCommand('bsdtar')
    ? ['bsdtar', ['-tf', archPackage], ['-xOf', archPackage, '.PKGINFO']]
    : ['tar', ['--zstd', '-tf', archPackage], ['--zstd', '-xOf', archPackage, '.PKGINFO']];
  const archInfo = spawnSync(archTool, archInfoArgs, { encoding: 'utf8' }).stdout;
  assert.match(archInfo, /depend = glibc/);
  assert.match(spawnSync(archTool, archListArgs, { encoding: 'utf8' }).stdout, /usr\/share\/licenses\/marmotta\/LICENSE/);

  const rpmPackage = join(out, 'artifacts', `marmotta-${version}-1.x86_64.rpm`);
  const rpmMetadata = readRpmMetadata(await readFile(rpmPackage));
  assert.deepEqual(rpmMetadata, { name: 'marmotta', version, release: '1', arch: 'x86_64' });
  assert.throws(() => readRpmMetadata(Buffer.alloc(64)), /Truncated RPM header/);

  if (hasCommand('rpm')) {
    assert.match(spawnSync('rpm', ['-qpl', rpmPackage], { encoding: 'utf8' }).stdout, /\/usr\/share\/licenses\/marmotta\/LICENSE/);
    assert.match(spawnSync('rpm', ['-qpR', rpmPackage], { encoding: 'utf8' }).stdout, /^glibc\b/m);
  } else if (hasCommand('bsdtar')) {
    assert.match(spawnSync('bsdtar', ['-tf', rpmPackage], { encoding: 'utf8' }).stdout, /usr\/share\/licenses\/marmotta\/LICENSE/);
  }
});
