#!/usr/bin/env node
// Stages the Node-API headers from node_modules into build/node-api-headers.tar, the archive the
// standalone executables embed (Node.js SEA "assets", Bun "--asset"). The archive's top-level
// directory is named node-api-headers-<version> for readability; the executable installs it under a
// hash of the archive contents, so a binary embedding a newer version never reuses an old extraction.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const packageJsonPath = require.resolve('node-api-headers/package.json');
const headersRoot = dirname(packageJsonPath);
const { version } = JSON.parse(await readFile(packageJsonPath, 'utf8'));
const directoryName = `node-api-headers-${version}`;
const buildDir = join(root, 'build');
const output = join(buildDir, 'node-api-headers.tar');

await mkdir(buildDir, { recursive: true });
const staging = await mkdtemp(join(buildDir, '.stage-'));
try {
  const staged = join(staging, directoryName);
  await mkdir(staged);
  await cp(join(headersRoot, 'include'), join(staged, 'include'), { recursive: true });
  await mkdir(join(staged, 'def'));
  // Only node_api.def is consumed, by the Windows host-binding generation in src/windows-host.ts.
  await cp(join(headersRoot, 'def', 'node_api.def'), join(staged, 'def', 'node_api.def'));
  // tar runs from build/ with relative paths: GNU tar reads a colon before the first slash of an
  // archive name as the remote syntax `host:path`, so the absolute Windows path ("C:\...") would
  // make it try to reach the host "C". GNU tar and bsdtar both accept this form.
  const result = spawnSync('tar', ['-cf', basename(output), '-C', basename(staging), directoryName], {
    cwd: buildDir,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`tar exited with code ${result.status ?? `signal ${result.signal}`}`);
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}

console.log(`Node-API headers archive ready: ${output} (${directoryName})`);
