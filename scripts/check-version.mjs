#!/usr/bin/env node
// Fails when src/version.ts drifts from package.json. The version is a constant in the source
// because a standalone executable cannot read package.json at runtime; this check keeps the
// constant, the npm package, and the executables reporting the same version.
import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const versionSource = await readFile(new URL('../src/version.ts', import.meta.url), 'utf8');
const declared = /MARMOTTA_VERSION\s*=\s*'([^']+)'/.exec(versionSource)?.[1];

if (declared !== packageJson.version) {
  console.error(
    `Version mismatch: package.json declares ${packageJson.version} but src/version.ts declares ${declared ?? 'nothing'}.`,
  );
  console.error('Update both so the npm package and the standalone executables report the same version.');
  process.exit(1);
}

console.log(`Version is consistent: ${packageJson.version}`);
