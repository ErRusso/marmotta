#!/usr/bin/env node
// Renders the packaging recipes from throwaway fixture assets. CI uses the output to run each
// recipe through the tool that consumes it (abuild, makepkg, rpmspec, nix, ruby) without needing
// a real release.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ASSETS, assetName, checksumsFromArtifacts, renderPackages } from './packages.mjs';

const version = '1.2.3';
const outDir = resolve(process.argv[2] ?? 'packaging-fixtures');
const artifactsDir = resolve(outDir, 'artifacts');

await mkdir(artifactsDir, { recursive: true });
for (const asset of ASSETS) {
  const name = assetName(version, asset);
  await writeFile(resolve(artifactsDir, name), `#!/bin/sh\necho "marmotta ${version}"\n`, { mode: 0o755 });
}

const checksums = await checksumsFromArtifacts(artifactsDir, version);
await renderPackages({ version, checksums, outDir, artifactsDir, changelogDate: 'Fri Jan 02 2026' });
console.log(`Rendered fixture recipes in ${outDir}`);
