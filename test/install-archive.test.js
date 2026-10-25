import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { installArchive, tarExecutable } from '../dist/toolchain.js';

const tarAvailable = spawnSync('tar', ['--version'], { stdio: 'ignore' }).status === 0;
const skip = !tarAvailable && 'tar is required to exercise the archive installer';

// Builds an archive whose single top-level directory is named `name`, like the Node-API headers and
// Zig archives Marmotta installs.
async function archiveOf(directory, name, files) {
  const staging = join(directory, `staging-${name}`);
  await mkdir(join(staging, name), { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    const file = join(staging, name, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, contents);
  }
  const archivePath = join(directory, `${name}.tar`);
  // tar runs from the archive's directory with relative paths, which GNU tar (Git for Windows) and
  // bsdtar both accept; an absolute Windows path would be read as the remote syntax host:path.
  const result = spawnSync('tar', ['-cf', basename(archivePath), '-C', basename(staging), name], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return readFile(archivePath);
}

async function complete(directory) {
  return access(join(directory, 'include', 'node_api.h')).then(() => true, () => false);
}

async function leftoverInstallDirectories(root) {
  return (await readdir(root)).filter((entry) => entry.startsWith('.install-'));
}

test('installs an archive and reuses a complete destination', { skip }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'marmotta-archive-'));
  try {
    const root = join(directory, 'root');
    await mkdir(root);
    const destination = join(root, 'node-api-headers-hash');
    const archive = await archiveOf(directory, 'headers-1', { 'include/node_api.h': 'original\n' });

    await installArchive({ root, archive, archiveName: 'node-api-headers.tar', destination, isComplete: complete });
    assert.equal(await readFile(join(destination, 'include', 'node_api.h'), 'utf8'), 'original\n');
    assert.deepEqual(await leftoverInstallDirectories(root), []);

    // The destination name identifies the contents, so a complete directory is always the right one
    // and a later install never replaces it.
    const other = await archiveOf(directory, 'headers-2', { 'include/node_api.h': 'changed\n' });
    await installArchive({ root, archive: other, archiveName: 'node-api-headers.tar', destination, isComplete: complete });
    assert.equal(await readFile(join(destination, 'include', 'node_api.h'), 'utf8'), 'original\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('replaces an incomplete destination instead of reusing it', { skip }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'marmotta-archive-'));
  try {
    const root = join(directory, 'root');
    await mkdir(root);
    const destination = join(root, 'node-api-headers-hash');
    // An interrupted earlier run left a directory without the files the installer considers complete.
    await mkdir(destination);
    await writeFile(join(destination, 'leftover'), '');
    const archive = await archiveOf(directory, 'headers-1', { 'include/node_api.h': 'original\n' });

    await installArchive({ root, archive, archiveName: 'node-api-headers.tar', destination, isComplete: complete });
    assert.equal(await readFile(join(destination, 'include', 'node_api.h'), 'utf8'), 'original\n');
    assert.deepEqual(await leftoverInstallDirectories(root), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent installers of the same archive all succeed', { skip }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'marmotta-archive-'));
  try {
    const root = join(directory, 'root');
    await mkdir(root);
    const destination = join(root, 'node-api-headers-hash');
    const archive = await archiveOf(directory, 'headers-1', { 'include/node_api.h': 'original\n' });

    await Promise.all(Array.from({ length: 4 }, () =>
      installArchive({ root, archive, archiveName: 'node-api-headers.tar', destination, isComplete: complete })));

    assert.equal(await readFile(join(destination, 'include', 'node_api.h'), 'utf8'), 'original\n');
    assert.deepEqual(await leftoverInstallDirectories(root), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('extracts a Windows zip with the bundled tar.exe regardless of PATH', {
  skip: process.platform !== 'win32' && 'Zig only ships zip archives for Windows',
}, async () => {
  // Git Bash, MSYS2 and Cygwin put GNU tar first on PATH, which cannot read the zip archives Zig
  // ships for Windows. Emptying PATH proves the installer does not depend on which tar it finds there.
  const directory = await mkdtemp(join(tmpdir(), 'marmotta-archive-'));
  const originalPath = process.env.PATH;
  try {
    const staging = join(directory, 'staging');
    await mkdir(join(staging, 'zig-windows'), { recursive: true });
    await writeFile(join(staging, 'zig-windows', 'zig.exe'), '');
    // -a picks the format from the suffix, so bsdtar writes a real zip like the ones Zig publishes.
    const created = spawnSync(tarExecutable(), ['-a', '-cf', 'zig.zip', '-C', 'staging', 'zig-windows'], {
      cwd: directory,
      encoding: 'utf8',
    });
    assert.equal(created.status, 0, created.stderr);
    const archive = await readFile(join(directory, 'zig.zip'));
    assert.equal(archive.subarray(0, 2).toString('latin1'), 'PK', 'the fixture must be a zip archive');

    const root = join(directory, 'root');
    await mkdir(root);
    const destination = join(root, '0.16.0');
    process.env.PATH = join(directory, 'empty-path');
    await installArchive({
      root,
      archive,
      archiveName: 'zig.zip',
      destination,
      isComplete: (candidate) => access(join(candidate, 'zig.exe')).then(() => true, () => false),
    });
    await access(join(destination, 'zig.exe'));
  } finally {
    process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  }
});
