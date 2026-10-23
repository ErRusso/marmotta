import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { directoryError, installArchive, type MarmottaHome } from './toolchain.js';
import { InternalError, isMarmottaError } from './errors.js';
import { isStandalone, readEmbeddedAsset } from './standalone.js';

export type NodeApiHeaders = { includeDir: string; nodeApiDefPath: string };

type NodeApiHeadersModule = { include_dir: string; def_paths: { node_api_def: string } };

// The archive embedded in standalone executables by scripts/build-headers-asset.mjs. The installed
// directory is named after a hash of the archive, not after the node-api-headers version it holds:
// the hash is the only name the running executable knows before extracting, and it makes a binary
// that embeds a different version install beside the old copy instead of reusing it.
const assetName = 'node-api-headers.tar';

// Keyed by the Marmotta home: a programmatic caller that switches MARMOTTA_HOME must not receive
// the first home's paths, which point at another extraction (or, under npm, are home-independent).
const resolved = new Map<string, Promise<NodeApiHeaders>>();

// Zig compiles in a separate process, so the headers must exist as real files. npm installs resolve
// them from node_modules; a standalone executable extracts the embedded archive once into the
// Marmotta home and reuses the extracted copy for every later build.
export function resolveNodeApiHeaders(home: MarmottaHome): Promise<NodeApiHeaders> {
  const cached = resolved.get(home.path);
  if (cached) return cached;

  const pending = (async () => (isStandalone() ? extractEmbeddedHeaders(home) : npmHeaders()))().catch(
    (error: unknown) => {
      // A transient failure must not be cached forever: programmatic callers may retry.
      if (resolved.get(home.path) === pending) resolved.delete(home.path);
      throw error;
    },
  );
  resolved.set(home.path, pending);
  return pending;
}

function npmHeaders(): NodeApiHeaders {
  const require = createRequire(import.meta.url);
  // node-api-headers computes its paths relative to its own location in node_modules, which does
  // not exist inside a standalone executable; that is why this path is only taken under npm.
  const headers = require('node-api-headers') as NodeApiHeadersModule;
  return { includeDir: headers.include_dir, nodeApiDefPath: headers.def_paths.node_api_def };
}

function headersIn(directory: string): NodeApiHeaders {
  return {
    includeDir: join(directory, 'include'),
    nodeApiDefPath: join(directory, 'def', 'node_api.def'),
  };
}

// Both files Zig consumes must be present: an interrupted extraction leaves at least one missing and
// is replaced by the next run, while a finished installation is reused as is.
async function headersInstalled(directory: string): Promise<boolean> {
  try {
    await access(join(directory, 'include'));
    await access(join(directory, 'def', 'node_api.def'));
    return true;
  } catch {
    return false;
  }
}

async function extractEmbeddedHeaders(home: MarmottaHome): Promise<NodeApiHeaders> {
  const root = join(home.path, 'node-api-headers');
  try {
    await mkdir(root, { recursive: true });
  } catch (error) {
    throw directoryError(home, root, error);
  }

  // readEmbeddedAsset returns undefined outside a standalone build and when a SEA has no such asset.
  const archive = await readEmbeddedAsset(assetName);
  if (!archive) {
    throw new InternalError(`The standalone build does not embed ${assetName}.`);
  }

  const digest = createHash('sha256').update(archive).digest('hex').slice(0, 16);
  const destination = join(root, `node-api-headers-${digest}`);
  try {
    await installArchive({ root, archive, archiveName: assetName, destination, isComplete: headersInstalled });
  } catch (error) {
    if (isMarmottaError(error)) throw error;
    throw directoryError(home, root, error);
  }
  return headersIn(destination);
}
