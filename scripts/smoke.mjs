#!/usr/bin/env node
// Smoke-tests a standalone Marmotta executable the way a user without Node.js would run it:
// usage: node scripts/smoke.mjs <path-to-executable>
//
// The binary must report the package version, install Zig, compile the README's hello addon, and
// the resulting .node file must load in the Node.js running this script. Configuration that must
// not reach the executable (NODE_OPTIONS, a stray .env or bunfig.toml) is planted around it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const binaryArgument = process.argv[2];
if (!binaryArgument) {
  console.error('usage: node scripts/smoke.mjs <path-to-executable>');
  process.exit(2);
}
const binary = resolve(binaryArgument);
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

// The host Node.js loads the compiled addon, so it must start with a clean environment: the
// planted NODE_OPTIONS points at a file that does not exist and would make Node.js exit at once.
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !['NODE_OPTIONS', 'BUN_OPTIONS'].includes(name.toUpperCase())),
);

function run(args, options = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, `${binary} ${args.join(' ')} exited with ${result.status}\n${result.stderr}\n${result.stdout}`);
  return result;
}

const hostileEnv = {
  ...cleanEnv,
  // NODE_OPTIONS must not reach either executable. BUN_OPTIONS is deliberately absent: Bun parses
  // it before the entrypoint runs, so a compiled executable cannot opt out of it, and unlike
  // NODE_OPTIONS it only exists for users who explicitly configure Bun.
  NODE_OPTIONS: '--require /nonexistent/marmotta-smoke.js',
};

const version = run(['--version'], { env: hostileEnv });
assert.equal(version.stdout, `marmotta ${packageJson.version}\n`, 'the executable must report the package version');
assert.equal(version.stderr, '');

run(['--help'], { env: hostileEnv });

const directory = await mkdtemp(join(tmpdir(), 'marmotta-smoke-'));
// A private MARMOTTA_HOME keeps the run out of the developer's real ~/.marmotta and always
// exercises a first-run headers extraction. It lives outside the project directory: source
// discovery would otherwise find the C sources of the downloaded Zig toolchain.
const home = await mkdtemp(join(tmpdir(), 'marmotta-smoke-home-'));
const environment = { ...hostileEnv, MARMOTTA_HOME: home };
try {
  // Stray project configuration must not change the standalone executable's behavior. Bun loads
  // these files from the process working directory, which is why every project command below runs
  // with cwd set to this directory.
  await writeFile(join(directory, '.env'), 'ZIG_GLOBAL_CACHE_DIR=/nonexistent\nMARMOTTA_ZIG_DIR=/nonexistent\n');
  await writeFile(join(directory, 'bunfig.toml'), '[install]\nregistry = "https://example.invalid"\n');
  // The calls are assigned before the assert on purpose: `zig cc -O2` defines NDEBUG, and an
  // assert() wrapping a call would compile the call away, leaving an addon with no properties.
  await writeFile(join(directory, 'hello.c'), `#include <assert.h>
#include <node_api.h>

static napi_value Hello(napi_env env, napi_callback_info info) {
  napi_status status;
  napi_value result;
  status = napi_create_string_utf8(env, "world", NAPI_AUTO_LENGTH, &result);
  assert(status == napi_ok);
  return result;
}

static napi_value Initialize(napi_env env, napi_value exports) {
  napi_status status;
  napi_property_descriptor desc = { "hello", 0, Hello, 0, 0, 0, napi_default, 0 };
  status = napi_define_properties(env, exports, 1, &desc);
  assert(status == napi_ok);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
`);
  await writeFile(join(directory, 'marmotta.config.json'), JSON.stringify({ name: 'hello' }));

  run(['install'], { cwd: directory, env: environment });
  run(['list'], { cwd: directory, env: environment });
  run(['configure', '-C', directory], { cwd: directory, env: environment });
  run(['build', '-C', directory], { cwd: directory, env: environment });

  const addon = join(directory, 'hello.node');
  const loaded = spawnSync(process.execPath, ['-e', `console.log(require(${JSON.stringify(addon)}).hello())`], {
    encoding: 'utf8',
    env: cleanEnv,
  });
  assert.equal(loaded.status, 0, `the compiled addon must load in Node.js\n${loaded.stderr}`);
  assert.equal(loaded.stdout.trim(), 'world');

  run(['clean', '-C', directory], { cwd: directory, env: environment });
  run(['rebuild', '-C', directory], { cwd: directory, env: environment });
  run(['remove', '0.0.1'], { cwd: directory, env: environment });

  const unknown = spawnSync(binary, ['unknown-command'], { encoding: 'utf8', env: environment });
  assert.equal(unknown.status, 2, 'unknown commands must fail with the usage exit code');
} finally {
  await rm(directory, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
}

console.log(`Smoke test passed: ${binary}`);
