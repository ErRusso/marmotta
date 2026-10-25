#!/usr/bin/env node
// Rewrites the MARMOTTA_VERSION constant from package.json. npm runs this as the "version" lifecycle
// script after bumping package.json and before committing the release, so `npm version` cannot leave
// the standalone executables reporting the previous version. `npm test` still runs check-version,
// which catches a manual edit of package.json that skipped this script.
import { readFile, writeFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const versionFile = new URL('../src/version.ts', import.meta.url);
const source = await readFile(versionFile, 'utf8');
const pattern = /(MARMOTTA_VERSION\s*=\s*')[^']+(')/;

if (!pattern.test(source)) {
  console.error('Could not find MARMOTTA_VERSION in src/version.ts.');
  process.exit(1);
}

await writeFile(versionFile, source.replace(pattern, `$1${packageJson.version}$2`));
console.log(`Updated src/version.ts to ${packageJson.version}`);
