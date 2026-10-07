import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, link, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const zigAvailable = spawnSync('zig', ['version'], { stdio: 'ignore' }).status === 0;
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
});

test('reports an unknown command with an error code', () => {
  const result = spawnSync(process.execPath, [cli, 'unknown-command'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /CLI_COMMAND_ERROR/);
  assert.match(result.stderr, /Unknown command/);
});

test('classifies invalid options as argument errors', () => {
  const result = spawnSync(process.execPath, [cli, 'build', '--target'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /CLI_ARGUMENT_ERROR/);
});

test('builds and loads a C Node-API addon with Zig', { skip: !zigAvailable }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'marmotta-addon-'));
  const source = `#include <assert.h>
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
    const hostResult = spawnSync(host, ['-e', `console.log(require(${JSON.stringify(output)}).add(2, 3))`], {
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
