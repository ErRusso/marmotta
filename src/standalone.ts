import { createRequire } from 'node:module';
import { basename } from 'node:path';

type SeaModule = { isSea(): boolean; getAsset(key: string): ArrayBuffer };
type BunEmbeddedFile = { name: string; arrayBuffer(): Promise<ArrayBuffer> };
type BunGlobal = { isStandaloneExecutable?: boolean; embeddedFiles?: BunEmbeddedFile[] };

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

function bunRuntime(): BunGlobal | undefined {
  const bun = (globalThis as { Bun?: BunGlobal }).Bun;
  return bun?.isStandaloneExecutable === true ? bun : undefined;
}

// True when Marmotta runs from a single-file executable built by Node.js SEA or `bun build
// --compile`. In that mode the npm package files (node_modules, package.json) are not on disk:
// everything the CLI needs must be embedded in the executable and extracted on demand.
export function isStandalone(): boolean {
  return seaRuntime() || bunRuntime() !== undefined;
}

// Reads a file embedded in the executable at build time. Returns undefined outside a standalone
// build, where the file is not embedded anywhere.
export async function readEmbeddedAsset(name: string): Promise<Buffer | undefined> {
  if (seaRuntime()) {
    // sea.getAsset throws when the asset is missing, so a SEA built without it reports a missing
    // asset instead of an unhandled Node.js error.
    try {
      return Buffer.from((require('node:sea') as SeaModule).getAsset(name));
    } catch {
      return undefined;
    }
  }
  const bun = bunRuntime();
  if (!bun) return undefined;
  // `bun build --compile --asset` lists the embedded files on Bun.embeddedFiles. Their names are the
  // only stable reference to the copy inside the executable: with --bytecode, import.meta.url keeps
  // the build machine's path, and Bun's virtual file system root is not part of the public API.
  const embedded = bun.embeddedFiles?.find((file) => basename(file.name) === name);
  return embedded ? Buffer.from(await embedded.arrayBuffer()) : undefined;
}
