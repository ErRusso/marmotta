import { createRequire } from 'node:module';
import { access, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { directoryError, marmottaHome, run, type MarmottaHome } from './toolchain.js';
import { InternalError, isMarmottaError } from './errors.js';
import { isStandalone, readEmbeddedAsset } from './standalone.js';

export type NodeApiHeaders = { includeDir: string; nodeApiDefPath: string };

type NodeApiHeadersModule = { include_dir: string; def_paths: { node_api_def: string } };

// The archive embedded in standalone executables by scripts/build-headers-asset.mjs. Its top-level
// directory is named node-api-headers-<version>, so extracting it also records which version is
// installed and a header upgrade re-extracts automatically.
const assetName = 'node-api-headers.tar';

let resolved: Promise<NodeApiHeaders> | undefined;

// Zig compiles in a separate process, so the headers must exist as real files. npm installs resolve
// them from node_modules; a standalone executable extracts the embedded archive once into the
// Marmotta home and reuses the extracted copy for every later build.
export function resolveNodeApiHeaders(): Promise<NodeApiHeaders> {
  resolved ??= isStandalone() ? extractEmbeddedHeaders() : Promise.resolve(npmHeaders());
  return resolved;
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

// Returns an already extracted and complete installation, ignoring incomplete ones left behind by
// an interrupted extraction: those are replaced by a fresh run.
async function findInstalledHeaders(home: MarmottaHome, root: string): Promise<NodeApiHeaders | undefined> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw directoryError(home, root, error);
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const candidate = headersIn(join(root, entry.name));
    try {
      await access(candidate.includeDir);
      await access(candidate.nodeApiDefPath);
      return candidate;
    } catch {
      // Missing files mark a partial extraction; the next candidate, or a re-extraction, replaces it.
    }
  }
  return undefined;
}

async function extractEmbeddedHeaders(): Promise<NodeApiHeaders> {
  const home = marmottaHome();
  const root = join(home.path, 'node-api-headers');
  try {
    await mkdir(root, { recursive: true });
  } catch (error) {
    throw directoryError(home, root, error);
  }
  const installed = await findInstalledHeaders(home, root);
  if (installed) return installed;

  const archive = await readEmbeddedAsset(assetName);
  if (!archive) {
    throw new InternalError(`The standalone build does not embed ${assetName}.`);
  }
  let temporaryDir: string;
  try {
    temporaryDir = await mkdtemp(join(root, '.extract-'));
  } catch (error) {
    throw directoryError(home, root, error);
  }
  try {
    const archivePath = join(temporaryDir, assetName);
    await writeFile(archivePath, archive);
    const stagingDir = join(temporaryDir, 'staged');
    await mkdir(stagingDir);
    await run('tar', ['-xf', archivePath, '-C', stagingDir]);
    const directories = (await readdir(stagingDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    if (directories.length !== 1) {
      throw new InternalError(`${assetName} must contain exactly one directory, found ${directories.length}.`);
    }
    const version = basename(directories[0].name);
    const destination = join(root, version);
    // The replacement happens by rename, so a build that starts after this one either finds the
    // finished installation or extracts its own copy; no partially written directory is visible.
    await rm(destination, { recursive: true, force: true });
    await rename(join(stagingDir, directories[0].name), destination);
    return headersIn(destination);
  } catch (error) {
    if (isMarmottaError(error)) throw error;
    throw directoryError(home, root, error);
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}
