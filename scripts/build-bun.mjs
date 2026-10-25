#!/usr/bin/env node
// Builds standalone Marmotta executables with `bun build --compile`. Bun bundles the TypeScript
// output and cross-compiles every target from any machine, so the release workflow can build each
// target in its own job or loop over all of them from one. Pass --target to build a single target;
// without it every supported target is built.
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, readFile, rm } from 'node:fs/promises';
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
  await access(headers);
} catch {
  console.error(`Missing ${headers}. Run "npm run build:headers" first.`);
  process.exit(1);
}

// The archive is staged next to the bundled entry point so Bun can embed it as an asset; at runtime
// src/standalone.ts reads it from Bun.embeddedFiles. It is removed again after the build so a later
// `npm publish` cannot ship it.
const stagedHeaders = join(root, 'dist', 'node-api-headers.tar');
await copyFile(headers, stagedHeaders);
// A failed build must not skip the cleanup of the staged archive: `dist` is published to npm, so a
// checkout that failed to build would otherwise ship dist/node-api-headers.tar on the next publish.
// package.json's "files" excludes that path as a guard for the cases this cleanup cannot cover
// (SIGKILL, a crashed runner).
let exitCode = 0;
try {
  await mkdir(join(root, 'out'), { recursive: true });
  for (const target of targets) {
    const name = target.slice('bun-'.length);
    const suffix = target.includes('windows') ? '.exe' : '';
    const output = join(root, 'out', `marmotta-v${packageJson.version}-${name}${suffix}`);
    const result = spawnSync('bun', [
      'build', join(root, 'dist', 'cli.js'),
      '--compile',
      `--target=${target}`,
      '--minify',
      '--bytecode',
      // The executable runs inside the user's projects: a stray .env or bunfig.toml in an addon's
      // directory must not change its behavior.
      '--no-compile-autoload-dotenv',
      '--no-compile-autoload-bunfig',
      '--asset', stagedHeaders,
      '--outfile', output,
    ], { stdio: 'inherit' });
    if (result.status !== 0) {
      exitCode = result.status ?? 1;
      break;
    }

    // An unsigned macOS executable is rejected by Gatekeeper once it carries the quarantine
    // attribute. The hardened runtime is enabled on purpose so the JIT entitlements apply to the
    // embedded JavaScriptCore engine; the ad-hoc identity keeps the binary runnable but is not
    // notarized, which is why the README documents clearing the quarantine attribute.
    // codesign only exists on macOS, so a darwin target cross-built elsewhere stays unsigned and
    // must be signed on a Mac before release (the release workflow builds darwin on macOS).
    if (target.includes('darwin')) {
      // The hardened runtime blocks the writable executable memory JavaScriptCore needs, so without
      // allow-jit Bun is terminated on Apple silicon. Zig runs as a separate process, not loaded into
      // this one, so library validation stays enabled. These notes live here and not in the plist:
      // codesign parses entitlements with a strict XML parser, and a comment containing "--" (such
      // as a codesign flag) is invalid XML that makes it reject the whole file.
      const entitlements = join(root, 'scripts', 'entitlements.plist');
      if (process.platform !== 'darwin') {
        console.warn(`warning: ${output} is unsigned; run codesign on macOS before releasing it.`);
      } else {
        const sign = spawnSync('codesign', [
          '--force', '--sign', '-', '--options', 'runtime', '--entitlements', entitlements, output,
        ], { stdio: 'inherit' });
        if (sign.status !== 0) {
          console.error('codesign failed; the executable will not pass Gatekeeper on macOS.');
          exitCode = sign.status ?? 1;
          break;
        }
      }
    }
    console.log(`Standalone executable ready: ${output}`);
  }
} finally {
  await rm(stagedHeaders, { force: true });
}
if (exitCode !== 0) process.exit(exitCode);
