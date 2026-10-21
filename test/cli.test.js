import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, link, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

// Every CLI process inherits this environment: run it with Marmotta's defaults, not the developer's own settings.
// node --test runs each file in its own process, and Windows variable names are case-insensitive.
for (const name of Object.keys(process.env)) {
  if (['MARMOTTA_HOME', 'MARMOTTA_ZIG_DIR', 'ZIG_GLOBAL_CACHE_DIR', 'MARMOTTA_LOG'].includes(name.toUpperCase())) delete process.env[name];
}

const zigAvailable = spawnSync('zig', ['version'], { stdio: 'ignore' }).status === 0;
// The installation directory of the Zig on PATH stands in for an existing toolchain that cannot be replaced.
const pathZigDirectory = zigAvailable
  ? (process.env.PATH ?? '').split(delimiter)
    .find((entry) => isAbsolute(entry) && existsSync(join(entry, process.platform === 'win32' ? 'zig.exe' : 'zig')))
  : undefined;
// Runtimes installed through npm are .cmd shims on Windows, which only run through a shell.
const runtimeAvailable = (command) => spawnSync(command, ['--version'], {
  stdio: 'ignore',
  shell: process.platform === 'win32',
}).status === 0;

function assertAddonHello(output) {
  const result = spawnSync(process.execPath, ['-e', `console.log(require(${JSON.stringify(output)}).hello())`], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'world');
}

test('shows help without initializing the toolchain', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /configure/);
  assert.match(result.stdout, /build/);
  assert.match(result.stdout, /MARMOTTA_ZIG_DIR/);
});

test('reports the version declared in package.json', async () => {
  // The CLI reads the version from src/version.ts because a standalone executable cannot read
  // package.json at runtime; scripts/check-version.mjs and this test keep the two in step.
  const packageJson = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  const result = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `marmotta ${packageJson.version}\n`);
  assert.equal(result.stderr, '');
});

test('reports an unknown command with an error code', () => {
  const result = spawnSync(process.execPath, [cli, 'unknown-command'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /CLI_COMMAND_ERROR/);
  assert.match(result.stderr, /Unknown command/);
  assert.match(result.stderr, /Usage: marmotta <command>/);
});

test('rejects command options given without a command', () => {
  for (const args of [['--debug'], ['-C', '.'], ['--target', 'x86_64-linux'], ['--json', '-o', 'build']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stdout.length, 0, args.join(' '));
    assert.match(result.stderr, /CLI_COMMAND_ERROR/, args.join(' '));
    assert.match(result.stderr, /Missing command/, args.join(' '));
  }

  const text = spawnSync(process.execPath, [cli, '--debug'], { encoding: 'utf8' });
  assert.match(text.stderr, /Usage: marmotta <command>/);
  // --json alone only selects the format, so it still shows help.
  const json = spawnSync(process.execPath, [cli, '--json'], { encoding: 'utf8' });
  assert.equal(json.status, 0, json.stderr);
  assert.match(JSON.parse(json.stdout).message, /^Marmotta - build tool/);
});

test('classifies invalid options as argument errors', () => {
  const result = spawnSync(process.execPath, [cli, 'build', '--target'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /CLI_ARGUMENT_ERROR/);
});

const addonSource = `#include <assert.h>
#include <node_api.h>

static napi_value Method(napi_env env, napi_callback_info info) {
  napi_status status;
    napi_value world;
  status = napi_create_string_utf8(env, "world", 5, &world);
  assert(status == napi_ok);
    return world;
}

static napi_value Initialize(napi_env env, napi_value exports) {
  napi_status status;
    napi_property_descriptor desc = { "hello", 0, Method, 0, 0, 0, napi_default, 0 };
  status = napi_define_properties(env, exports, 1, &desc);
  assert(status == napi_ok);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
`;

test('builds and loads a C Node-API addon with Zig', { skip: !zigAvailable }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'marmotta-addon-'));
  const source = addonSource;

  try {
    await mkdir(join(directory, 'build'));
    await writeFile(join(directory, 'hello.c'), source);
    await writeFile(join(directory, 'marmotta.config.json'), JSON.stringify({ name: 'hello' }));
    const output = join(directory, 'build', 'hello.node');
    const result = spawnSync(process.execPath, [cli, 'build', '-C', directory, '-o', join(directory, 'build')], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assertAddonHello(output);

    await writeFile(join(directory, 'hello.cpp'), source);
    await writeFile(join(directory, 'marmotta.config.json'), JSON.stringify({
      name: 'hello-cpp',
      sources: ['hello.cpp'],
      outputDir: 'build',
    }));
    const cppResult = spawnSync(process.execPath, [cli, 'build', '-C', directory], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const cppDetails = JSON.stringify({
      signal: cppResult.signal,
      error: cppResult.error?.message,
      output: (cppResult.stderr || cppResult.stdout).slice(-3000),
    });
    assert.equal(cppResult.status, 0, cppDetails);
    assertAddonHello(join(directory, 'build', 'hello-cpp.node'));

    for (const [target, dirName] of [
      ['x86_64-windows-gnu', 'windows-x64'],
      ['aarch64-windows-gnu', 'windows-arm64'],
    ]) {
      const windowsOutputDir = join(directory, 'build', dirName);
      const windowsOutput = join(windowsOutputDir, 'hello-cpp.node');
      const windowsResult = spawnSync(process.execPath, [
        cli,
        'build',
        '-C',
        directory,
        '--output-dir',
        windowsOutputDir,
        '--target',
        target,
      ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      assert.equal(windowsResult.status, 0, windowsResult.stderr || windowsResult.stdout);
      assert.equal((await readFile(windowsOutput)).toString('ascii', 0, 2), 'MZ');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('binds Node-API to the host executable on Windows', {
  skip: !zigAvailable || process.platform !== 'win32',
}, async () => {
  // Electron and other embedders export Node-API from their own executable, not from NODE.EXE.
  const directory = await mkdtemp(join(tmpdir(), 'marmotta-host-'));
  const source = `#include <node_api.h>
#include <js_native_api.h>

static napi_value Add(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2], result;
  double left, right;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  napi_get_value_double(env, args[0], &left);
  napi_get_value_double(env, args[1], &right);
  napi_create_double(env, left + right, &result);
  return result;
}

NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "add", NAPI_AUTO_LENGTH, Add, NULL, &fn);
  napi_set_named_property(env, exports, "add", fn);
  return exports;
}
`;

  try {
    await writeFile(join(directory, 'add.c'), source);
    await writeFile(join(directory, 'marmotta.config.json'), JSON.stringify({ name: 'add' }));
    const result = spawnSync(process.execPath, [cli, 'build', '-C', directory], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = join(directory, 'add.node');
    assert.doesNotMatch((await readFile(output)).toString('latin1'), /node\.exe/i);

    const host = join(directory, 'host.exe');
    await link(process.execPath, host).catch(() => copyFile(process.execPath, host));
    const hostResult = spawnSync(host, ['-e', `console.log(String(require(${JSON.stringify(output)}).add(2, 3)))`], {
      encoding: 'utf8',
    });
    assert.equal(hostResult.status, 0, hostResult.stderr);
    assert.equal(hostResult.stdout.trim(), '5');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('loads a built addon in Deno and Bun', { skip: !zigAvailable }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'marmotta-runtimes-'));
  const source = `#include <node_api.h>

static napi_value Call(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value fn, global, arg, result;
  napi_get_cb_info(env, info, &argc, &fn, NULL, NULL);
  napi_get_global(env, &global);
  napi_create_string_utf8(env, "world", NAPI_AUTO_LENGTH, &arg);
  napi_call_function(env, global, fn, 1, &arg, &result);
  return result;
}

NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "call", NAPI_AUTO_LENGTH, Call, NULL, &fn);
  napi_set_named_property(env, exports, "call", fn);
  return exports;
}
`;

  try {
    await writeFile(join(directory, 'call.c'), source);
    await writeFile(join(directory, 'marmotta.config.json'), JSON.stringify({ name: 'call' }));
    await writeFile(join(directory, 'check.cjs'), "console.log(require('./call.node').call((value) => `hello ${value}`));\n");
    const result = spawnSync(process.execPath, [cli, 'build', '-C', directory], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    for (const [runtime, args] of [['deno', ['run', '-A', 'check.cjs']], ['bun', ['check.cjs']]]) {
      await t.test(runtime, { skip: !runtimeAvailable(runtime) && `${runtime} is not on PATH` }, () => {
        const runtimeResult = spawnSync(runtime, args, {
          cwd: directory,
          encoding: 'utf8',
          shell: process.platform === 'win32',
        });
        assert.equal(runtimeResult.status, 0, runtimeResult.stderr || runtimeResult.stdout);
        assert.equal(runtimeResult.stdout.trim(), 'hello world');
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('builds with the Zig in MARMOTTA_ZIG_DIR without downloading the pinned version', {
  skip: !pathZigDirectory && 'Zig is not on PATH',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'marmotta-zig-dir-'));
  const source = `#include <node_api.h>

static napi_value Hello(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_create_string_utf8(env, "world", NAPI_AUTO_LENGTH, &result);
  return result;
}

NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "hello", NAPI_AUTO_LENGTH, Hello, NULL, &fn);
  napi_set_named_property(env, exports, "hello", fn);
  return exports;
}
`;

  try {
    await writeFile(join(directory, 'hello.c'), source);
    // Zig 0.0.1 was never released, so the build only succeeds if Marmotta does not try to download it.
    await writeFile(join(directory, 'marmotta.config.json'), JSON.stringify({ name: 'hello', zigVersion: '0.0.1' }));
    const result = spawnSync(process.execPath, [cli, 'build', '-C', directory], {
      encoding: 'utf8',
      env: { ...process.env, MARMOTTA_ZIG_DIR: pathZigDirectory },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assertAddonHello(join(directory, 'hello.node'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('supports JSON Lines output for CI consumers', () => {
  const help = spawnSync(process.execPath, [cli, '--help', '--json'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr || help.stdout);
  assert.equal(help.stderr.length, 0);
  assert.ok(help.stdout.endsWith('\n'), 'JSON records must be newline-terminated');

  const lines = help.stdout.split('\n').filter((line) => line.length > 0);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.level, 'info');
  assert.equal(typeof entry.message, 'string');
});

test('recognizes --json before the command', () => {
  const result = spawnSync(process.execPath, [cli, '--json', 'unknown-command'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(result.stdout.length, 0);

  const entry = JSON.parse(result.stderr);
  assert.equal(entry.level, 'error');
  assert.equal(entry.message, 'Unknown command: unknown-command');
  assert.doesNotMatch(entry.message, /Usage:/, 'the usage block must not flood the JSON message');
});

test('reports CLI errors as structured JSON Lines', () => {
  const result = spawnSync(process.execPath, [cli, 'unknown-command', '--json'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout.length, 0);

  const entry = JSON.parse(result.stderr);
  assert.equal(entry.level, 'error');
  assert.equal(entry.message, 'Unknown command: unknown-command');
  assert.equal(entry.data.code, 'CLI_COMMAND_ERROR');
  assert.equal(entry.data.exitCode, 2);
});

test('reports argument errors as structured JSON Lines', () => {
  for (const args of [['build', '--bogus', '--json'], ['build', '--json', '--target']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stdout.length, 0, args.join(' '));

    const entry = JSON.parse(result.stderr);
    assert.equal(entry.level, 'error', args.join(' '));
    assert.equal(entry.data.code, 'CLI_ARGUMENT_ERROR', args.join(' '));
  }
});

test('does not let MARMOTTA_LOG hide command output', () => {
  for (const level of ['warn', 'silent']) {
    const env = { ...process.env, MARMOTTA_LOG: level };
    const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', env });
    assert.equal(version.status, 0, level);
    assert.equal(version.stdout, 'marmotta 0.6.0\n', level);

    const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', env });
    assert.equal(help.status, 0, level);
    assert.match(help.stdout, /^Marmotta - build tool/, level);
  }
});

test('still reports the final error when MARMOTTA_LOG hides diagnostics', () => {
  const env = { ...process.env, MARMOTTA_HOME: 'relative/marmotta-home', MARMOTTA_LOG: 'silent' };

  const text = spawnSync(process.execPath, [cli, 'list'], { encoding: 'utf8', env });
  assert.equal(text.status, 2);
  assert.match(text.stderr, /^marmotta \[MARMOTTA_HOME_INVALID\]:/);

  const json = spawnSync(process.execPath, [cli, 'list', '--json'], { encoding: 'utf8', env });
  assert.equal(json.status, 2);
  const entry = JSON.parse(json.stderr);
  assert.equal(entry.level, 'error');
  assert.equal(entry.data.code, 'MARMOTTA_HOME_INVALID');
});

test('MARMOTTA_LOG=debug shows diagnostics that the default level hides', async () => {
  const home = await mkdtemp(join(tmpdir(), 'marmotta-debug-'));
  try {
    const run = (level) => spawnSync(process.execPath, [cli, 'list', '--json'], {
      encoding: 'utf8',
      env: level === undefined ? { ...process.env, MARMOTTA_HOME: home } : { ...process.env, MARMOTTA_HOME: home, MARMOTTA_LOG: level },
    });
    const levels = (result) => result.stdout.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line).level);

    const quiet = run(undefined);
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.deepEqual(levels(quiet), ['info']);

    const loud = run('debug');
    assert.equal(loud.status, 0, loud.stderr);
    assert.deepEqual(levels(loud), ['debug', 'info']);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('warns about an invalid MARMOTTA_LOG value in the requested format', () => {
  const env = { ...process.env, MARMOTTA_LOG: 'bogus' };
  const json = spawnSync(process.execPath, [cli, '--version', '--json'], { encoding: 'utf8', env });
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).message, 'marmotta 0.6.0');
  const warning = JSON.parse(json.stderr);
  assert.equal(warning.level, 'warn');
  assert.match(warning.message, /ignoring invalid MARMOTTA_LOG value "bogus"/);

  const text = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', env });
  assert.equal(text.stdout, 'marmotta 0.6.0\n');
  assert.match(text.stderr, /^marmotta: ignoring invalid MARMOTTA_LOG value "bogus"/);
});

test('rejects --version combined with a command', () => {
  for (const args of [['build', '--version'], ['remove', '0.13.0', '-v'], ['--json', 'build', '--version']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /CLI_ARGUMENT_ERROR/, args.join(' '));
    assert.match(result.stderr, /--version cannot be combined with a command/, args.join(' '));
  }
});

test('lists installed Zig versions as structured data in JSON mode', async () => {
  const home = await mkdtemp(join(tmpdir(), 'marmotta-list-'));
  try {
    await mkdir(join(home, 'toolchains', 'zig', '0.13.0'), { recursive: true });
    await mkdir(join(home, 'toolchains', 'zig', '0.14.0'), { recursive: true });
    const env = { ...process.env, MARMOTTA_HOME: home };

    const json = spawnSync(process.execPath, [cli, 'list', '--json'], { encoding: 'utf8', env });
    assert.equal(json.status, 0, json.stderr);
    const entry = JSON.parse(json.stdout);
    assert.equal(entry.message, 'Installed Zig versions');
    assert.deepEqual(entry.data.versions, ['0.13.0', '0.14.0']);

    const text = spawnSync(process.execPath, [cli, 'list'], { encoding: 'utf8', env });
    assert.equal(text.status, 0, text.stderr);
    assert.equal(text.stdout, '0.13.0\n0.14.0\n');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('keeps Zig compiler errors in --json output when MARMOTTA_LOG=error', { skip: !zigAvailable }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'marmotta-json-errors-'));
  try {
    await writeFile(join(directory, 'hello.c'), '#include <node_api.h>\n\nint broken(void) { return missing_symbol; }\n');
    await writeFile(join(directory, 'marmotta.config.json'), JSON.stringify({ name: 'hello' }));

    const result = spawnSync(process.execPath, [cli, 'build', '-C', directory, '--json'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, MARMOTTA_LOG: 'error' },
    });
    assert.equal(result.status, 1, result.stdout || result.stderr);

    const entries = result.stderr.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
    const compilerEntries = entries.filter((entry) => entry.data?.command === 'zig' && entry.data?.stream === 'stderr');
    assert.ok(compilerEntries.length > 0, 'Zig compiler output must survive MARMOTTA_LOG=error');
    assert.ok(compilerEntries.every((entry) => entry.level === 'warn'), 'stderr records must not claim level info');
    assert.ok(entries.some((entry) => entry.data?.code === 'TOOLCHAIN_COMMAND_FAILED'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('keeps the plain text output for --version and --help', () => {
  const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout, 'marmotta 0.6.0\n');
  assert.equal(version.stderr.length, 0);

  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  const lines = help.stdout.split('\n');
  assert.ok(lines.length > 10, 'help must not be collapsed onto a single line');
  assert.equal(lines[0], 'Marmotta - build tool for Node.js addons with Zig');
});

test('emits one JSON record per line for a multi-step build', { skip: !zigAvailable }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'marmotta-json-lines-'));
  try {
    await writeFile(join(directory, 'hello.c'), addonSource);
    await writeFile(join(directory, 'marmotta.config.json'), JSON.stringify({ name: 'hello' }));

    const result = spawnSync(process.execPath, [cli, 'rebuild', '-C', directory, '--json'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(result.stdout.endsWith('\n'), 'stdout must end with a newline');

    const lines = result.stdout.split('\n');
    assert.equal(lines.at(-1), '');
    const entries = lines.slice(0, -1).map((line) => JSON.parse(line));
    assert.ok(entries.length >= 2, `expected several records, got ${entries.length}`);
    assert.ok(entries.every((entry) => typeof entry.level === 'string' && typeof entry.message === 'string'));
    assert.ok(entries.some((entry) => /Removed/.test(entry.message)));
    assert.ok(entries.some((entry) => /Addon built/.test(entry.message)));

    for (const line of result.stderr.split('\n').filter((line) => line.length > 0)) {
      assert.doesNotThrow(() => JSON.parse(line), `stderr line is not JSON: ${line}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reports an invalid MARMOTTA_HOME without breaking help', () => {
  const env = { ...process.env, MARMOTTA_HOME: 'relative/marmotta-home' };
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', env });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /MARMOTTA_HOME/);

  const list = spawnSync(process.execPath, [cli, 'list'], { encoding: 'utf8', env });
  assert.equal(list.status, 2);
  assert.match(list.stderr, /^marmotta \[MARMOTTA_HOME_INVALID\]: MARMOTTA_HOME must be an absolute path/);
});
