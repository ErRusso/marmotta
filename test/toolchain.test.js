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
    // Node.js resolves the script argument, so `zig version` arrives as an absolute path ending in "version".
    await writeFile(preload, `
      import { basename } from 'node:path';
      if (process.argv[1] && basename(process.argv[1]) === 'version') process.exit(0);
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
      if (['MARMOTTA_HOME', 'MARMOTTA_ZIG_DIR', 'ZIG_GLOBAL_CACHE_DIR'].includes(name.toUpperCase())) delete env[name];
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

test('creates a missing MARMOTTA_HOME directory when it first writes to it', async () => {
  await withToolchainEnvironment(async ({ directory, home, env }) => {
    const marmottaHome = join(directory, 'missing', 'marmotta-home');
    env.MARMOTTA_HOME = marmottaHome;

    const result = runToolchain(env, `
      const zig = await toolchain.ensureZig();
      const created = (await import('node:fs')).existsSync(${JSON.stringify(marmottaHome)});
      return { created, cache: zig.env.ZIG_GLOBAL_CACHE_DIR, build: await toolchain.createBuildDirectory(zig) };
    `);

    // Finding Zig writes nothing; the first build creates the directory.
    assert.equal(result.created, false);
    assert.equal(result.cache, join(marmottaHome, 'cache'));
    assert.ok(result.build?.startsWith(join(marmottaHome, 'build-')), JSON.stringify(result));
    assert.equal(await exists(join(home, '.marmotta')), false);
  });
});

test('treats an empty MARMOTTA_HOME as unset', async () => {
  await withToolchainEnvironment(async ({ home, env }) => {
    env.MARMOTTA_HOME = '';

    const result = runToolchain(env, `
      const zig = await toolchain.ensureZig();
      return { env: zig.env ?? null, build: await toolchain.createBuildDirectory(zig) };
    `);

    assert.equal(result.env, null);
    assert.ok(result.build?.startsWith(join(home, '.marmotta', 'build-')), JSON.stringify(result));
  });
});

test('rejects a relative MARMOTTA_HOME', async () => {
  await withToolchainEnvironment(async ({ directory, env }) => {
    const invalidValues = ['relative/marmotta-home', '~/marmotta-home', ' ', `${directory} `, ` ${directory}`];
    if (process.platform === 'win32') {
      // Root-relative, drive-relative and device paths do not name a fixed directory.
      invalidValues.push(String.raw`\marmotta-home`, 'C:marmotta-home', String.raw`\\.\pipe`, String.raw`\\?\C:\marmotta-home`);
    }
    for (const value of invalidValues) {
      env.MARMOTTA_HOME = value;
      const result = runEnsureZig({ env, version: zigVersion, index: releaseIndex(zigVersion), archivePath: null });

      assert.equal(result.code, 'MARMOTTA_HOME_INVALID', JSON.stringify(value));
      assert.ok(result.message.includes(JSON.stringify(value)), result.message);
      assert.deepEqual(result.urls, []);
    }
  });
});

test('accepts a Windows MARMOTTA_HOME with forward slashes', { skip: process.platform !== 'win32' }, async () => {
  await withToolchainEnvironment(async ({ directory, env }) => {
    const marmottaHome = join(directory, 'forward-slashes');
    env.MARMOTTA_HOME = marmottaHome.replaceAll('\\', '/');

    const result = runToolchain(env, `
      const zig = await toolchain.ensureZig();
      return { directory: await toolchain.createBuildDirectory(zig) };
    `);

    assert.ok(result.directory?.startsWith(join(marmottaHome, 'build-')), JSON.stringify(result));
  });
});

test('reports a MARMOTTA_HOME that cannot be created', async () => {
  await withToolchainEnvironment(async ({ directory, env }) => {
    // A regular file in the path makes directory creation fail on every platform.
    const blocker = join(directory, 'not-a-directory');
    await writeFile(blocker, '');
    const marmottaHome = join(blocker, 'marmotta-home');
    env.MARMOTTA_HOME = marmottaHome;

    const result = runToolchain(env, 'await toolchain.createBuildDirectory(await toolchain.ensureZig());');

    assert.equal(result.code, 'MARMOTTA_HOME_UNAVAILABLE');
    assert.ok(result.message.startsWith(`Unable to create or write to the MARMOTTA_HOME directory ${marmottaHome} (`),
      result.message);
  });
});

test('names the failing Zig cache directory inside MARMOTTA_HOME', async () => {
  await withToolchainEnvironment(async ({ directory, env }) => {
    const marmottaHome = join(directory, 'shared');
    env.MARMOTTA_HOME = marmottaHome;
    await mkdir(marmottaHome);
    await writeFile(join(marmottaHome, 'cache'), '');

    const result = runToolchain(env, `
      const zig = await toolchain.ensureZig();
      await toolchain.runZig(zig, ['version'], process.cwd());
    `);

    assert.equal(result.code, 'MARMOTTA_HOME_UNAVAILABLE');
    assert.ok(result.message.startsWith(
      `Unable to create or write to ${join(marmottaHome, 'cache')} in the MARMOTTA_HOME directory ${marmottaHome} (`,
    ), result.message);
  });
});

test('reports a read-only MARMOTTA_HOME only when Marmotta writes to it', {
  skip: (process.platform === 'win32' || process.getuid?.() === 0)
    && 'directory permissions cannot be enforced on Windows or as root',
}, async () => {
  await withToolchainEnvironment(async ({ directory, env }) => {
    const marmottaHome = join(directory, 'read-only');
    await mkdir(marmottaHome);
    await chmod(marmottaHome, 0o555);
    env.MARMOTTA_HOME = marmottaHome;

    try {
      // Reading and finding an existing Zig write nothing, even though the cache directory does not exist.
      assert.deepEqual(runToolchain(env, 'return { versions: await toolchain.listZigVersions() };'), { versions: [] });
      assert.deepEqual(runToolchain(env, 'return { executable: (await toolchain.ensureZig()).executable };'),
        { executable: 'zig' });

      const build = runToolchain(env, 'await toolchain.createBuildDirectory(await toolchain.ensureZig());');
      assert.equal(build.code, 'MARMOTTA_HOME_UNAVAILABLE');
      assert.match(build.message, /MARMOTTA_HOME directory .* \(EACCES\)/);

      // The install fails before anything is downloaded, keeps its error code and says what failed.
      const install = runEnsureZig({ env, version: zigVersion, index: releaseIndex(zigVersion), archivePath: null });
      assert.equal(install.code, 'ZIG_INSTALL_FAILED');
      assert.match(install.message, new RegExp(`^Zig installation failed: EACCES on .* in the MARMOTTA_HOME directory`));
      assert.deepEqual(install.urls, []);
    } finally {
      await chmod(marmottaHome, 0o755);
    }
  });
});

test('reports a read-only Zig cache in MARMOTTA_HOME before running Zig', {
  skip: (process.platform === 'win32' || process.getuid?.() === 0)
    && 'directory permissions cannot be enforced on Windows or as root',
}, async () => {
  await withToolchainEnvironment(async ({ directory, env }) => {
    const marmottaHome = join(directory, 'shared');
    const cache = join(marmottaHome, 'cache');
    await mkdir(cache, { recursive: true });
    await chmod(cache, 0o555);
    env.MARMOTTA_HOME = marmottaHome;

    try {
      const result = runToolchain(env, `
        const zig = await toolchain.ensureZig();
        await toolchain.runZig(zig, ['version'], process.cwd());
      `);

      assert.equal(result.code, 'MARMOTTA_HOME_UNAVAILABLE');
      assert.ok(result.message.includes(`${cache} in the MARMOTTA_HOME directory`), result.message);
    } finally {
      await chmod(cache, 0o755);
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
    // The Zig on PATH in this environment is Node.js, so running it with the script records Zig's environment.
    const recordCache = (environment) => {
      runToolchain(environment, `
        const zig = await toolchain.ensureZig();
        await toolchain.runZig(zig, [${JSON.stringify(recordScript)}], process.cwd());
      `);
      return readFile(recordPath, 'utf8').then(JSON.parse);
    };

    assert.deepEqual(await recordCache(env), { cache: null });

    const marmottaHome = join(directory, 'custom-home');
    env.MARMOTTA_HOME = marmottaHome;
    const movedCache = { cache: join(marmottaHome, 'cache') };
    assert.deepEqual(await recordCache(env), movedCache);
    assert.equal(await exists(join(marmottaHome, 'cache')), true);
    // An empty value is a template default, not a choice of cache directory.
    assert.deepEqual(await recordCache({ ...env, ZIG_GLOBAL_CACHE_DIR: '' }), movedCache);

    const explicitCache = join(directory, 'explicit-cache');
    assert.deepEqual(await recordCache({ ...env, ZIG_GLOBAL_CACHE_DIR: explicitCache }), { cache: explicitCache });
  });
});

test('uses the Zig in MARMOTTA_ZIG_DIR instead of PATH, managed versions or a download', async () => {
  await withToolchainEnvironment(async ({ directory, home, env }) => {
    const zigDirectory = join(directory, 'existing-zig');
    await mkdir(zigDirectory);
    await writeFile(join(zigDirectory, executableName), '', { mode: 0o755 });
    const managedToolchain = join(home, '.marmotta', 'toolchains', 'zig', zigVersion);
    await mkdir(managedToolchain, { recursive: true });
    await writeFile(join(managedToolchain, executableName), '');
    env.MARMOTTA_ZIG_DIR = zigDirectory;

    // Unpinned, Zig is on PATH; zigVersion is managed; newerVersion would have to be downloaded.
    for (const version of [undefined, zigVersion, newerVersion]) {
      const result = runEnsureZig({ env, version, index: releaseIndex(zigVersion, newerVersion), archivePath: null });

      assert.equal(result.executable, join(zigDirectory, executableName), JSON.stringify(result));
      assert.deepEqual(result.urls, []);
    }
  });
});

test('fails instead of downloading Zig when MARMOTTA_ZIG_DIR has no runnable Zig', async () => {
  await withToolchainEnvironment(async ({ directory, env }) => {
    const zigDirectory = join(directory, 'missing-zig');
    await mkdir(zigDirectory);
    env.MARMOTTA_ZIG_DIR = zigDirectory;
    const expected = join(zigDirectory, executableName);

    const missing = runEnsureZig({ env, version: zigVersion, index: releaseIndex(zigVersion), archivePath: null });
    assert.equal(missing.code, 'MARMOTTA_ZIG_DIR_UNAVAILABLE');
    assert.equal(missing.message, `MARMOTTA_ZIG_DIR does not contain a Zig executable that can be run: ${expected} (ENOENT).`);
    assert.deepEqual(missing.urls, []);

    if (process.platform !== 'win32') {
      // Windows has no execute permission to check.
      await writeFile(expected, '', { mode: 0o644 });
      const notExecutable = runEnsureZig({ env, version: zigVersion, index: releaseIndex(zigVersion), archivePath: null });
      assert.equal(notExecutable.code, 'MARMOTTA_ZIG_DIR_UNAVAILABLE');
      assert.match(notExecutable.message, /\(EACCES\)\.$/);
      assert.deepEqual(notExecutable.urls, []);
    }
  });
});

test('rejects a relative MARMOTTA_ZIG_DIR and treats an empty one as unset', async () => {
  await withToolchainEnvironment(async ({ directory, env }) => {
    for (const value of ['relative/zig', '~/zig', ' ', `${directory} `]) {
      env.MARMOTTA_ZIG_DIR = value;
      const result = runEnsureZig({ env, version: zigVersion, index: releaseIndex(zigVersion), archivePath: null });

      assert.equal(result.code, 'MARMOTTA_ZIG_DIR_INVALID', JSON.stringify(value));
      assert.ok(result.message.includes(JSON.stringify(value)), result.message);
      assert.deepEqual(result.urls, []);
    }

    env.MARMOTTA_ZIG_DIR = '';
    assert.equal(runEnsureZig({ env, index: releaseIndex(zigVersion), archivePath: null }).executable, 'zig');
  });
});
