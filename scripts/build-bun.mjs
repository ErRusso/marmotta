#!/usr/bin/env node
// Builds standalone Marmotta executables with `bun build --compile`. Bun bundles the TypeScript
// output and cross-compiles every target from any machine, so the release workflow can build each
// target in its own job or loop over all of them from one. Pass --target to build a single target;
// without it every supported target is built.
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allTargets = [
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-linux-x64-musl',
  'bun-linux-arm64-musl',
  'bun-darwin-x64',
  'bun-darwin-arm64',
  'bun-windows-x64',
  'bun-windows-arm64',
];

const targetIndex = process.argv.indexOf('--target');
const targets = targetIndex === -1 ? allTargets : [process.argv[targetIndex + 1]];
if (targets.some((target) => !allTargets.includes(target))) {
  console.error(`Unknown target. Supported targets: ${allTargets.join(', ')}`);
  process.exit(1);
}

const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const headers = join(root, 'build', 'node-api-headers.tar');
try {
  await readFile(headers);
} catch {
  console.error(`Missing ${headers}. Run "npm run build:headers" first.`);
  process.exit(1);
}

// The archive is staged next to the bundled entry point so Bun mirrors it into the executable at
// the same relative path; src/standalone.ts reads it back from the entry point's directory.
const stagedHeaders = join(root, 'dist', 'node-api-headers.tar');
await copyFile(headers, stagedHeaders);
try {
  await mkdir(join(root, 'out'), { recursive: true });
  for (const target of targets) {
    const name = target.slice('bun-'.length);
    const suffix = target.includes('windows') ? '.exe' : '';
    const output = join(root, 'out', `marmotta-${packageJson.version}-${name}${suffix}`);
    const result = spawnSync('bun', [
      'build', join(root, 'dist', 'cli.js'),
      '--compile',
      `--target=${target}`,
      '--minify',
      '--sourcemap',
      '--bytecode',
      // The executable runs inside the user's projects: a stray .env or bunfig.toml in an addon's
      // directory must not change its behavior.
      '--no-compile-autoload-dotenv',
      '--no-compile-autoload-bunfig',
      '--asset', stagedHeaders,
      '--outfile', output,
    ], { stdio: 'inherit' });
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }

    // An unsigned macOS executable is rejected by Gatekeeper once it carries the quarantine
    // attribute; the JIT entitlements let the embedded JavaScriptCore engine compile code.
    if (target.includes('darwin')) {
      const entitlements = join(root, 'scripts', 'entitlements.plist');
      const sign = spawnSync('codesign', ['--force', '--sign', '-', '--entitlements', entitlements, output], {
        stdio: 'inherit',
      });
      if (sign.status !== 0) {
        console.error('codesign failed; the executable will not pass Gatekeeper on macOS.');
        process.exit(sign.status ?? 1);
      }
    }
    console.log(`Standalone executable ready: ${output}`);
  }
} finally {
  await rm(stagedHeaders, { force: true });
}
