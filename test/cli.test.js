import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const cli = new URL('../dist/cli.js', import.meta.url);
const zigAvailable = spawnSync('zig', ['version'], { stdio: 'ignore' }).status === 0;

test('mostra l’aiuto senza inizializzare la toolchain', () => {
  const result = spawnSync(process.execPath, [cli.pathname, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /configure/);
  assert.match(result.stdout, /build/);
});

test('segnala un comando sconosciuto con codice di errore', () => {
  const result = spawnSync(process.execPath, [cli.pathname, 'unknown-command'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /CLI_COMMAND_ERROR/);
  assert.match(result.stderr, /Comando non riconosciuto/);
});

test('classifica le opzioni non valide come errori di argomento', () => {
  const result = spawnSync(process.execPath, [cli.pathname, 'build', '--target'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /CLI_ARGUMENT_ERROR/);
});

test('compila e carica un addon C Node-API con Zig', { skip: !zigAvailable }, async () => {
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

NAPI_MODULE(hello, Initialize)
`;

  try {
    await mkdir(join(directory, 'build'));
    await writeFile(join(directory, 'hello.c'), source);
    const output = join(directory, 'build', 'hello.node');
    const result = spawnSync(process.execPath, [cli.pathname, 'build', '-C', directory, '-o', output], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const requireFromProject = createRequire(join(directory, 'package.json'));
    assert.equal(requireFromProject(output).hello(), 'world');

    await writeFile(join(directory, 'hello.cpp'), source);
    await writeFile(join(directory, 'marmotta.config.json'), JSON.stringify({
      sources: ['hello.cpp'],
      output: 'build/hello-cpp.node',
    }));
    const cppResult = spawnSync(process.execPath, [cli.pathname, 'build', '-C', directory], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const cppDetails = JSON.stringify({
      signal: cppResult.signal,
      error: cppResult.error?.message,
      output: (cppResult.stderr || cppResult.stdout).slice(-3000),
    });
    assert.equal(cppResult.status, 0, cppDetails);
    assert.equal(requireFromProject(join(directory, 'build', 'hello-cpp.node')).hello(), 'world');

    for (const [target, fileName] of [
      ['x86_64-windows-gnu', 'hello-windows-x64.node'],
      ['aarch64-windows-gnu', 'hello-windows-arm64.node'],
    ]) {
      const windowsOutput = join(directory, 'build', fileName);
      const windowsResult = spawnSync(process.execPath, [
        cli.pathname,
        'build',
        '-C',
        directory,
        '-o',
        windowsOutput,
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