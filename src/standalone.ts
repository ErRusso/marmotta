import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type SeaModule = { isSea(): boolean; getAsset(key: string): ArrayBuffer };
type BunGlobal = { isStandaloneExecutable?: boolean };

const require = createRequire(import.meta.url);

function seaRuntime(): boolean {
  // process.versions.sea is the cheapest check where it exists; require('node:sea') covers Node
  // versions that only expose the module. Both are absent under plain Node.js and Bun scripts.
  if (process.versions.sea) return true;
  try {
    return (require('node:sea') as SeaModule).isSea();
  } catch {
    return false;
  }
}

function bunRuntime(): boolean {
  return (globalThis as { Bun?: BunGlobal }).Bun?.isStandaloneExecutable === true;
}

// True when Marmotta runs from a single-file executable built by Node.js SEA or `bun build
// --compile`. In that mode the npm package files (node_modules, package.json) are not on disk:
// everything the CLI needs must be embedded in the executable and extracted on demand, and paths
// such as import.meta.url point into the binary or into Bun's virtual file system.
export function isStandalone(): boolean {
  return seaRuntime() || bunRuntime();
}

// Reads a file embedded in the executable at build time. Node.js SEA stores assets under the name
// given in sea-config.json; Bun mirrors `--asset` files into its virtual file system next to the
// bundled entry point, so the entry's directory is searched for the same name. Returns undefined
// outside a standalone build, where the file is not embedded anywhere.
export async function readEmbeddedAsset(name: string): Promise<Buffer | undefined> {
  if (seaRuntime()) {
    return Buffer.from((require('node:sea') as SeaModule).getAsset(name));
  }
  if (!bunRuntime()) return undefined;
  const entryDirectory = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(entryDirectory, name), join(entryDirectory, '..', name)]) {
    try {
      return await readFile(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return undefined;
}
