import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const toolchainModule = pathToFileURL(fileURLToPath(new URL('../dist/toolchain.js', import.meta.url))).href;
const zigVersion = '0.14.1';
const newerVersion = '0.15.0';
const hostKey = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${
  process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
}`;
const archiveExtension = process.platform === 'win32' ? 'zip' : 'tar.xz';
const executableName = process.platform === 'win32' ? 'zig.exe' : 'zig';
const tarAvailable = spawnSync('tar', ['--version'], { stdio: 'ignore' }).status === 0;

async function withToolchainEnvironment(run, getZigDirectory) {
  const directory = await mkdtemp(join(tmpdir(), 'marmotta-toolchain-test-'));
  const home = join(directory, 'home');
  const bin = join(directory, 'bin');
  const preload = join(directory, 'path-zig.mjs');

  try {
    await mkdir(home);
    await mkdir(bin);
    await writeFile(preload, `
      if (process.argv[1] === 'version') process.exit(0);
    `);

    const pathZig = join(bin, executableName);
    await copyFile(process.execPath, pathZig);
    if (process.platform !== 'win32') await chmod(pathZig, 0o755);

    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PATH: [bin, process.env.PATH ?? ''].join(delimiter),
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      MARMOTTA_TEST_TOOLCHAIN_MODULE: toolchainModule,
    };
    delete env.MARMOTTA_ZIG_DIR;
    const customZigDirectory = typeof getZigDirectory === 'function'
      ? getZigDirectory(directory)
      : getZigDirectory;
    if (customZigDirectory !== undefined) env.MARMOTTA_ZIG_DIR = customZigDirectory;
    const marmottaRoot = customZigDirectory ?? home;
    await run({ directory, home, env, marmottaRoot, zigRoot: join(marmottaRoot, 'toolchains', 'zig') });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runEnsureZig({ env, version, index, archivePath }) {
  const script = `
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      if (String(url) === 'https://ziglang.org/download/index.json') {
        return new Response(JSON.stringify(${JSON.stringify(index)}), { status: 200 });
      }
      if (${JSON.stringify(archivePath)} !== null) {
        return new Response(await (await import('node:fs/promises')).readFile(${JSON.stringify(archivePath)}));
      }
      throw new Error('Unexpected fetch: ' + url);
    };

    try {
      const { ensureZig } = await import(process.env.MARMOTTA_TEST_TOOLCHAIN_MODULE);
      const command = await ensureZig(${JSON.stringify(version)});
      console.log(JSON.stringify({ executable: command.executable, urls }));
    } catch (error) {
      console.log(JSON.stringify({ code: error.code, message: error.message, urls }));
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

function runRunZig({ env, recordPath }) {
  const script = `
    const { runZig } = await import(process.env.MARMOTTA_TEST_TOOLCHAIN_MODULE);
    await runZig({ executable: process.execPath, args: [${JSON.stringify(recordPath)}] }, [], process.cwd());
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function runRunZigResult({ env }) {
  const script = `
    const { runZig } = await import(process.env.MARMOTTA_TEST_TOOLCHAIN_MODULE);
    try {
      await runZig({ executable: process.execPath, args: [] }, [], process.cwd());
      console.log(JSON.stringify({ status: 0 }));
    } catch (error) {
      console.log(JSON.stringify({ code: error.code, exitCode: error.exitCode, message: error.message }));
      process.exitCode = error.exitCode ?? 1;
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env,
  });
  return { status: result.status, ...JSON.parse(result.stdout.trim()) };
}

function releaseIndex(...versions) {
  return Object.fromEntries(versions.map((version) => [
    version,
    { [hostKey]: { tarball: `https://ziglang.org/${version}.${archiveExtension}` } },
  ]));
}

test('uses the exact managed Zig version instead of a different Zig on PATH', async () => {
  await withToolchainEnvironment(async ({ home, env }) => {
    const localToolchain = join(home, '.marmotta', 'toolchains', 'zig', zigVersion);
    await mkdir(localToolchain, { recursive: true });
    await writeFile(join(localToolchain, executableName), '');

    const result = runEnsureZig({
      env,
      version: zigVersion,
      index: releaseIndex(zigVersion, newerVersion),
      archivePath: null,
    });

    assert.equal(result.executable, join(localToolchain, executableName));
    assert.deepEqual(result.urls, []);
  });
});

test('installs the pinned Zig release under MARMOTTA_ZIG_DIR', {
  skip: !tarAvailable && 'tar is required to build the test archive',
}, async () => {
  await withToolchainEnvironment(
    async ({ directory, zigRoot, env }) => {
      const payload = join(directory, 'payload');
      await mkdir(payload);
      await writeFile(join(payload, executableName), '');
      const archivePath = join(directory, 'custom-zig.tar');
      const archive = spawnSync('tar', ['-cf', archivePath, '-C', payload, executableName], { encoding: 'utf8' });
      assert.equal(archive.status, 0, archive.stderr);

      const result = runEnsureZig({
        env,
        version: zigVersion,
        index: releaseIndex(zigVersion, newerVersion),
        archivePath,
      });

      assert.equal(result.executable, join(zigRoot, zigVersion, executableName));
      assert.deepEqual(result.urls, [
        'https://ziglang.org/download/index.json',
        `https://ziglang.org/${zigVersion}.${archiveExtension}`,
      ]);
      await readFile(result.executable);
    },
    (directory) => join(directory, 'shared-tools'),
  );
});

test('places Zig global cache under MARMOTTA_ZIG_DIR', async () => {
  await withToolchainEnvironment(
    async ({ directory, marmottaRoot, env }) => {
      const recordPath = join(directory, 'zig-cache-env.json');
      const recordScript = join(directory, 'record-zig-env.mjs');
      await writeFile(recordScript, `
        import { writeFileSync } from 'node:fs';
        writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({
          zigCache: process.env.ZIG_GLOBAL_CACHE_DIR,
        }));
      `);

      runRunZig({ env, recordPath: recordScript });

      assert.deepEqual(JSON.parse(await readFile(recordPath, 'utf8')), {
        zigCache: join(marmottaRoot, 'cache'),
      });
    },
    (directory) => join(directory, 'shared-tools'),
  );
});

test('preserves an explicitly configured Zig global cache under MARMOTTA_ZIG_DIR', async () => {
  await withToolchainEnvironment(
    async ({ directory, env }) => {
      const explicitCache = join(directory, 'explicit-cache');
      await mkdir(explicitCache);
      env.ZIG_GLOBAL_CACHE_DIR = explicitCache;

      const recordPath = join(directory, 'explicit-zig-cache-env.json');
      const recordScript = join(directory, 'record-explicit-zig-cache-env.mjs');
      await writeFile(recordScript, `
        import { writeFileSync } from 'node:fs';
        writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({
          zigCache: process.env.ZIG_GLOBAL_CACHE_DIR,
        }));
      `);

      runRunZig({ env, recordPath: recordScript });

      assert.deepEqual(JSON.parse(await readFile(recordPath, 'utf8')), {
        zigCache: explicitCache,
      });
    },
    (directory) => join(directory, 'shared-tools'),
  );
});

test('wraps failed Zig cache directory creation in a Marmotta error', async () => {
  await withToolchainEnvironment(
    async ({ directory, env }) => {
      // A regular-file component makes recursive mkdir fail deterministically.
      const blockedParent = join(directory, 'not-a-directory');
      await writeFile(blockedParent, 'cache parent is a file');

      const result = runRunZigResult({ env });

      assert.equal(result.status, 1);
      assert.equal(result.code, 'MARMOTTA_DIRECTORY_FAILED');
      assert.equal(result.exitCode, 1);
      assert.match(result.message, /^Unable to create /);
    },
    (directory) => join(directory, 'not-a-directory', 'cache-root'),
  );
});

test('downloads the exact pinned Zig release rather than the latest indexed version', {
  skip: !tarAvailable && 'tar is required to exercise the download and extraction path',
}, async () => {
  await withToolchainEnvironment(async ({ directory, home, env }) => {
    const payload = join(directory, 'payload');
    await mkdir(payload);
    await writeFile(join(payload, executableName), '');
    const archivePath = join(directory, 'zig.tar');
    const archive = spawnSync('tar', ['-cf', archivePath, '-C', payload, executableName], { encoding: 'utf8' });
    assert.equal(archive.status, 0, archive.stderr);

    const result = runEnsureZig({
      env,
      version: zigVersion,
      index: releaseIndex(zigVersion, newerVersion),
      archivePath,
    });

    assert.equal(result.executable, join(home, '.marmotta', 'toolchains', 'zig', zigVersion, executableName));
    assert.deepEqual(result.urls, [
      'https://ziglang.org/download/index.json',
      `https://ziglang.org/${zigVersion}.${archiveExtension}`,
    ]);
    await readFile(result.executable);
  });
});

test('fails when the pinned Zig version is unavailable instead of using PATH Zig', async () => {
  await withToolchainEnvironment(async ({ env }) => {
    const result = runEnsureZig({
      env,
      version: zigVersion,
      index: releaseIndex(newerVersion),
      archivePath: null,
    });

    assert.equal(result.code, 'ZIG_INSTALL_FAILED');
    assert.match(result.message, new RegExp(`Zig ${zigVersion} is not available`));
    assert.deepEqual(result.urls, ['https://ziglang.org/download/index.json']);
  });
});
