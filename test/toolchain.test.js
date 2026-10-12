import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

async function withToolchainEnvironment(run) {
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
    // Keep tests independent of the developer's own settings (Windows variable names are case-insensitive).
    for (const name of Object.keys(env)) {
      if (['MARMOTTA_HOME', 'ZIG_GLOBAL_CACHE_DIR'].includes(name.toUpperCase())) delete env[name];
    }
    await run({ directory, home, env });
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

// Runs `body` against the toolchain module in a child process and returns the JSON it reports.
function runToolchain(env, body) {
  const script = `
    const toolchain = await import(process.env.MARMOTTA_TEST_TOOLCHAIN_MODULE);
    try {
      console.log(JSON.stringify(await (async () => { ${body} })() ?? {}));
    } catch (error) {
      console.log(JSON.stringify({ code: error.code, message: error.message }));
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

async function exists(path) {
  return access(path).then(() => true, () => false);
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

test('uses MARMOTTA_HOME instead of the home directory for managed Zig', async () => {
  await withToolchainEnvironment(async ({ directory, home, env }) => {
    const marmottaHome = join(directory, 'custom-home');
    env.MARMOTTA_HOME = marmottaHome;
    const localToolchain = join(marmottaHome, 'toolchains', 'zig', zigVersion);
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
    assert.equal(await exists(join(home, '.marmotta')), false);
  });
});

test('creates a missing MARMOTTA_HOME directory', async () => {
  await withToolchainEnvironment(async ({ directory, env }) => {
    const marmottaHome = join(directory, 'missing', 'marmotta-home');
    env.MARMOTTA_HOME = marmottaHome;

    const result = runToolchain(env, 'return { root: await toolchain.ensureMarmottaRoot() };');

    assert.deepEqual(result, { root: marmottaHome });
    assert.equal(await exists(marmottaHome), true);
  });
});

test('treats an empty MARMOTTA_HOME as unset', async () => {
  await withToolchainEnvironment(async ({ home, env }) => {
    env.MARMOTTA_HOME = '';

    const result = runToolchain(env, 'return { root: await toolchain.ensureMarmottaRoot() };');

    assert.deepEqual(result, { root: join(home, '.marmotta') });
  });
});

test('rejects a relative MARMOTTA_HOME', async () => {
  const relativePaths = ['relative/marmotta-home', ' '];
  if (process.platform === 'win32') relativePaths.push('\marmotta-home', 'C:marmotta-home');
  await withToolchainEnvironment(async ({ env }) => {
    for (const value of relativePaths) {
      env.MARMOTTA_HOME = value;
      const result = runEnsureZig({ env, version: zigVersion, index: releaseIndex(zigVersion), archivePath: null });

      assert.equal(result.code, 'MARMOTTA_HOME_INVALID', JSON.stringify(value));
      assert.match(result.message, /MARMOTTA_HOME must be an absolute path/);
      assert.deepEqual(result.urls, []);
    }
  });
});

test('reports a MARMOTTA_HOME that cannot be created', async () => {
  await withToolchainEnvironment(async ({ directory, env }) => {
    // A regular file in the path makes directory creation fail on every platform.
    const blocker = join(directory, 'not-a-directory');
    await writeFile(blocker, '');
    env.MARMOTTA_HOME = join(blocker, 'marmotta-home');

    const result = runToolchain(env, 'await toolchain.ensureMarmottaRoot();');

    assert.equal(result.code, 'MARMOTTA_HOME_UNAVAILABLE');
    assert.match(result.message, /MARMOTTA_HOME/);
  });
});

test('reports a MARMOTTA_HOME that is not writable', {
  skip: (process.platform === 'win32' || process.getuid?.() === 0)
    && 'directory permissions cannot be enforced on Windows or as root',
}, async () => {
  await withToolchainEnvironment(async ({ directory, env }) => {
    const marmottaHome = join(directory, 'read-only');
    await mkdir(marmottaHome);
    await chmod(marmottaHome, 0o555);
    env.MARMOTTA_HOME = marmottaHome;

    try {
      const result = runToolchain(env, 'await toolchain.ensureMarmottaRoot();');

      assert.equal(result.code, 'MARMOTTA_HOME_UNAVAILABLE');
      assert.match(result.message, /MARMOTTA_HOME/);
    } finally {
      await chmod(marmottaHome, 0o755);
    }
  });
});

test('keeps content Marmotta did not create when removing a Zig version from MARMOTTA_HOME', async () => {
  await withToolchainEnvironment(async ({ directory, env }) => {
    const marmottaHome = join(directory, 'shared');
    env.MARMOTTA_HOME = marmottaHome;
    const zigRoot = join(marmottaHome, 'toolchains', 'zig');
    await mkdir(join(zigRoot, zigVersion), { recursive: true });
    await writeFile(join(zigRoot, zigVersion, executableName), '');
    await writeFile(join(marmottaHome, 'user-file.txt'), 'keep');
    await writeFile(join(zigRoot, 'notes.txt'), 'keep');

    const result = runToolchain(env, `
      await toolchain.ensureMarmottaRoot();
      await toolchain.removeZigVersion(${JSON.stringify(zigVersion)});
      return { versions: await toolchain.listZigVersions() };
    `);

    assert.deepEqual(result, { versions: [] });
    assert.equal(await readFile(join(marmottaHome, 'user-file.txt'), 'utf8'), 'keep');
    assert.equal(await readFile(join(zigRoot, 'notes.txt'), 'utf8'), 'keep');
  });
});

test('moves the Zig global cache into MARMOTTA_HOME unless one is configured', async () => {
  await withToolchainEnvironment(async ({ directory, env }) => {
    const recordScript = join(directory, 'record-cache.cjs');
    const recordPath = join(directory, 'cache.json');
    await writeFile(recordScript, `require('node:fs').writeFileSync(${JSON.stringify(recordPath)},
      JSON.stringify({ cache: process.env.ZIG_GLOBAL_CACHE_DIR ?? null }));`);
    const recordCache = (environment) => {
      runToolchain(environment, `
        await toolchain.runZig({ executable: process.execPath, args: [${JSON.stringify(recordScript)}] }, [], process.cwd());
      `);
      return readFile(recordPath, 'utf8').then(JSON.parse);
    };

    assert.deepEqual(await recordCache(env), { cache: null });

    const marmottaHome = join(directory, 'custom-home');
    env.MARMOTTA_HOME = marmottaHome;
    assert.deepEqual(await recordCache(env), { cache: join(marmottaHome, 'cache') });
    assert.equal(await exists(join(marmottaHome, 'cache')), true);

    const explicitCache = join(directory, 'explicit-cache');
    assert.deepEqual(await recordCache({ ...env, ZIG_GLOBAL_CACHE_DIR: explicitCache }), { cache: explicitCache });
  });
});
