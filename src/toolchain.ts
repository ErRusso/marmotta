import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { access, chmod, mkdtemp, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve, win32 } from 'node:path';
import {
  MarmottaDirectoryFailedError,
  MarmottaHomeInvalidError,
  MarmottaHomeUnavailableError,
  PlatformNotSupportedError,
  ToolchainCommandFailedError,
  ToolchainSpawnFailedError,
  ZigChecksumMismatchError,
  ZigDiscoveryFailedError,
  ZigDownloadFailedError,
  ZigInstallFailedError,
  ZigVersionInvalidError,
  isMarmottaError,
} from './errors.js';

const indexUrl = 'https://ziglang.org/download/index.json';

type ZigCommand = { executable: string; args: string[] };
type ZigArtifact = { tarball?: unknown; shasum?: unknown };
type MarmottaHome = { path: string; fromEnvironment: boolean };

function isAbsoluteHome(value: string): boolean {
  if (process.platform !== 'win32') return isAbsolute(value);
  // Only a drive root ("C:\") or a UNC share ("\\server\share\") is a fixed location: isAbsolute() also accepts
  // "\tools", which depends on the current drive, and device paths such as "\\.\pipe" or "\\?\C:\".
  const root = win32.parse(value).root.replaceAll('/', '\\');
  return /^[a-zA-Z]:\\$/.test(root) || /^\\\\[^\\?.][^\\]*\\[^\\]+\\?$/.test(root);
}

// Read on every call so an invalid MARMOTTA_HOME is reported as a Marmotta error by the command that needs it.
function marmottaHome(): MarmottaHome {
  const value = process.env.MARMOTTA_HOME;
  if (!value) return { path: join(homedir(), '.marmotta'), fromEnvironment: false };
  if (!isAbsoluteHome(value)) throw new MarmottaHomeInvalidError(value);
  return { path: resolve(value), fromEnvironment: true };
}

function zigRoot(): string {
  return join(marmottaHome().path, 'toolchains', 'zig');
}

// Zig keeps its global cache in the user's home directory; MARMOTTA_HOME moves it unless the user chose one.
// An empty ZIG_GLOBAL_CACHE_DIR counts as unset, like an empty MARMOTTA_HOME. process.env lookups are
// case-insensitive on Windows, so this also sees a differently-cased variable.
function zigCacheDirectory(home: MarmottaHome): string | undefined {
  return home.fromEnvironment && !process.env.ZIG_GLOBAL_CACHE_DIR ? join(home.path, 'cache') : undefined;
}

function directoryError(home: MarmottaHome, path: string, cause: unknown): Error {
  return home.fromEnvironment
    ? new MarmottaHomeUnavailableError(home.path, { cause })
    : new MarmottaDirectoryFailedError(path, { cause });
}

function run(executable: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: 'inherit' });
    child.once('error', (cause: Error) => {
      reject(new ToolchainSpawnFailedError(basename(executable), { cause }));
    });
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else {
        const reason = code === null ? `was terminated by signal ${signal ?? 'unknown'}` : `exited with code ${code}`;
        reject(new ToolchainCommandFailedError(basename(executable), reason));
      }
    });
  });
}

function platformKey(): string {
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : undefined;
  const platform = process.platform === 'darwin' ? 'macos'
    : process.platform === 'linux' ? 'linux'
      : process.platform === 'win32' ? 'windows' : undefined;
  if (!arch || !platform) {
    throw new PlatformNotSupportedError(`${process.platform}/${process.arch}`);
  }
  return `${arch}-${platform}`;
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function findLocalZig(version?: string): Promise<ZigCommand | undefined> {
  const root = zigRoot();
  try {
    const versions = await readdir(root, { withFileTypes: true });
    for (const entry of versions) {
      if (!entry.isDirectory() || (version !== undefined && entry.name !== version)) continue;
      const versionDir = join(root, entry.name);
      const entries = await readdir(versionDir, { withFileTypes: true });
      for (const entry of entries) {
        const candidateDir = entry.isDirectory() ? join(versionDir, entry.name) : versionDir;
        for (const executable of ['zig', 'zig.exe']) {
          const candidate = join(candidateDir, executable);
          try {
            await access(candidate);
            return { executable: candidate, args: [] };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw new ZigDiscoveryFailedError(`Unable to verify ${candidate}.`, { cause: error });
            }
          }
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ZigDiscoveryFailedError(`Unable to inspect ${root}.`, { cause: error });
    }
  }
  return undefined;
}

function systemZig(): ZigCommand | undefined {
  const result = spawnSync('zig', ['version'], { stdio: 'ignore' });
  const spawnErrorCode = result.error && 'code' in result.error ? result.error.code : undefined;
  if (result.error && spawnErrorCode !== 'ENOENT') {
    throw new ZigDiscoveryFailedError('Unable to check for Zig in PATH.', { cause: result.error });
  }
  return result.status === 0 ? { executable: 'zig', args: [] } : undefined;
}

// Writability is not probed here: commands that only read the directory keep working when it is read-only,
// and a read-only directory is reported by the first command that writes into it.
export async function ensureMarmottaRoot(): Promise<void> {
  const home = marmottaHome();
  const cache = zigCacheDirectory(home);
  try {
    await mkdir(home.path, { recursive: true });
    if (cache) await mkdir(cache, { recursive: true });
  } catch (error) {
    throw directoryError(home, home.path, error);
  }
}

async function makeTemporaryDirectory(parent: string, prefix: string): Promise<string> {
  const home = marmottaHome();
  try {
    await mkdir(parent, { recursive: true });
    return await mkdtemp(join(parent, prefix));
  } catch (error) {
    throw directoryError(home, parent, error);
  }
}

export function createBuildDirectory(): Promise<string> {
  return makeTemporaryDirectory(marmottaHome().path, 'build-');
}

function zigEnvironment(): NodeJS.ProcessEnv | undefined {
  const cache = zigCacheDirectory(marmottaHome());
  if (!cache) return undefined;
  // Drop an empty, differently-cased variable so the child does not receive two spellings on Windows.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'ZIG_GLOBAL_CACHE_DIR'),
  );
  return { ...env, ZIG_GLOBAL_CACHE_DIR: cache };
}

async function downloadAndInstallZig(requestedVersion?: string): Promise<ZigCommand> {
  let response: Response;
  try {
    response = await fetch(indexUrl);
  } catch (error) {
    throw new ZigDownloadFailedError('Failed to download the Zig index.', { cause: error });
  }
  if (!response.ok) {
    throw new ZigDownloadFailedError(`Failed to download the Zig index: HTTP ${response.status}`);
  }
  const index: unknown = await response.json();
  if (typeof index !== 'object' || index === null || Array.isArray(index)) {
    throw new ZigInstallFailedError('Invalid Zig download index.');
  }

  const versions = Object.keys(index).filter((version) => /^\d+\.\d+\.\d+$/.test(version)).sort(compareVersions);
  const version = requestedVersion ?? versions.at(-1);
  if (!version) throw new ZigInstallFailedError('No stable Zig release found.');
  if (!versions.includes(version)) {
    throw new ZigInstallFailedError(`Zig ${version} is not available as a stable release.`);
  }
  const release = (index as Record<string, unknown>)[version];
  const artifact = typeof release === 'object' && release !== null
    ? (release as Record<string, ZigArtifact>)[platformKey()]
    : undefined;
  if (typeof artifact?.tarball !== 'string') {
    throw new ZigInstallFailedError(`No Zig ${version} package available for ${platformKey()}.`);
  }

  let archiveResponse: Response;
  try {
    archiveResponse = await fetch(artifact.tarball);
  } catch (error) {
    throw new ZigDownloadFailedError('Failed to download the Zig package.', { cause: error });
  }
  if (!archiveResponse.ok) {
    throw new ZigDownloadFailedError(`Failed to download Zig: HTTP ${archiveResponse.status}`);
  }
  const archive = Buffer.from(await archiveResponse.arrayBuffer());
  if (typeof artifact.shasum === 'string') {
    const checksum = createHash('sha256').update(archive).digest('hex');
    if (checksum !== artifact.shasum) throw new ZigChecksumMismatchError();
  }

  const root = zigRoot();
  const temporaryDir = await makeTemporaryDirectory(root, '.download-');
  const archivePath = join(temporaryDir, basename(new URL(artifact.tarball).pathname));
  const extractionDir = join(temporaryDir, 'extracted');
  try {
    await mkdir(extractionDir);
    await writeFile(archivePath, archive);
    await run('tar', ['-xf', archivePath, '-C', extractionDir]);
    const extractedEntries = await readdir(extractionDir, { withFileTypes: true });
    const installSource = extractedEntries.length === 1 && extractedEntries[0]?.isDirectory()
      ? join(extractionDir, extractedEntries[0].name)
      : extractionDir;
    const installDir = join(root, version);
    await rm(installDir, { recursive: true, force: true });
    await rename(installSource, installDir);
    const executable = join(installDir, process.platform === 'win32' ? 'zig.exe' : 'zig');
    if (process.platform !== 'win32') await chmod(executable, 0o755);
    return { executable, args: [] };
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

async function installZig(version?: string): Promise<ZigCommand> {
  try {
    return await downloadAndInstallZig(version);
  } catch (error) {
    if (isMarmottaError(error)) throw error;
    throw new ZigInstallFailedError('Zig installation failed.', { cause: error });
  }
}

export async function ensureZig(version?: string): Promise<ZigCommand> {
  if (version !== undefined) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new ZigVersionInvalidError(version);
  }
  await ensureMarmottaRoot();
  if (version !== undefined) {
    const local = await findLocalZig(version);
    return local ?? installZig(version);
  }
  const system = systemZig();
  if (system) return system;
  const local = await findLocalZig();
  return local ?? installZig();
}

export async function listZigVersions(): Promise<string[]> {
  const root = zigRoot();
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort(compareVersions);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new ZigDiscoveryFailedError(`Unable to read Zig versions in ${root}.`, { cause: error });
  }
}

export async function removeZigVersion(version: string): Promise<void> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new ZigVersionInvalidError(version);
  const root = zigRoot();
  try {
    await rm(join(root, version), { recursive: true, force: true });
  } catch (error) {
    throw new ZigInstallFailedError(`Unable to remove Zig ${version}.`, { cause: error });
  }
}

export async function runZig(command: ZigCommand, args: string[], cwd: string): Promise<void> {
  await run(command.executable, [...command.args, ...args], { cwd, env: zigEnvironment() });
}