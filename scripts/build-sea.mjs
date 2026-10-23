#!/usr/bin/env node
// Builds a Node.js Single Executable Application (see the "Single Executable Applications" page in
// the Node.js API docs): the CLI is bundled into one ESM file, the Node-API headers archive is
// embedded as an asset, and both are injected into a copy of this Node.js runtime. Requires
// Node.js 25.5 or newer for `node --build-sea`.
import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 25 || (major === 25 && minor < 5)) {
  console.error(`Node.js 25.5 or newer is required to build the SEA (found ${process.versions.node}).`);
  process.exit(1);
}

const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const suffix = process.platform === 'win32' ? '.exe' : '';
// --build-sea only produces an executable for the platform of this Node.js build, so the name uses
// that platform with the same spelling as the Bun artifacts (windows, not win32) to keep checksums
// and download scripts consistent.
const platform = process.platform === 'win32' ? 'windows' : process.platform;
// The executable goes to out/, like the Bun artifacts, so .gitignore, smoke commands and the docs
// all point at one place; build/ only holds intermediate files (bundle, SEA config, headers archive).
const output = process.argv[2]
  ?? join(root, 'out', `marmotta-v${packageJson.version}-${platform}-${process.arch}${suffix}`);
const bundle = join(root, 'build', 'marmotta.bundle.mjs');
const headers = join(root, 'build', 'node-api-headers.tar');
const seaConfig = join(root, 'build', 'sea-config.json');

try {
  await access(headers);
} catch {
  console.error(`Missing ${headers}. Run "npm run build:headers" first.`);
  process.exit(1);
}

// Everything the CLI uses must be in the bundle: a SEA resolves only built-in modules at runtime.
await rm(bundle, { force: true });
await build({
  entryPoints: [join(root, 'dist', 'cli.js')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: `node${major}`,
  sourcemap: 'inline',
  logLevel: 'info',
  // Dependencies such as pino call require() for Node.js built-ins. esbuild cannot turn those calls
  // into imports in an ESM bundle and leaves a shim that throws "Dynamic require ... is not
  // supported" unless a real require() exists in the module scope.
  banner: {
    js: [
      "import { createRequire as __marmottaCreateRequire } from 'node:module';",
      'const require = __marmottaCreateRequire(process.execPath);',
    ].join('\n'),
  },
});

await mkdir(dirname(output), { recursive: true });
await writeFile(seaConfig, `${JSON.stringify({
  main: bundle,
  mainFormat: 'module',
  output,
  disableExperimentalSEAWarning: true,
  // The executable runs inside the user's projects: NODE_OPTIONS must not change its behavior.
  execArgvExtension: 'none',
  useCodeCache: true,
  assets: { 'node-api-headers.tar': headers },
}, null, 2)}\n`);

const result = spawnSync(process.execPath, ['--build-sea', seaConfig], { stdio: 'inherit' });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

// An unsigned macOS executable is rejected by Gatekeeper once it carries the quarantine attribute;
// an ad-hoc signature is enough for local use and for CI downloads via curl.
if (process.platform === 'darwin') {
  const sign = spawnSync('codesign', ['--sign', '-', output], { stdio: 'inherit' });
  if (sign.status !== 0) {
    console.error('codesign failed; the executable will not pass Gatekeeper on macOS.');
    process.exit(sign.status ?? 1);
  }
}

console.log(`Standalone executable ready: ${output}`);
