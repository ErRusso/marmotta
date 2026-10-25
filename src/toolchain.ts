import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access, chmod, mkdtemp, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve, win32 } from 'node:path';
import { createInterface } from 'node:readline';
import { logger } from './logger.js';
import {
  MarmottaDirectoryFailedError,
  MarmottaHomeInvalidError,
  MarmottaHomeUnavailableError,
  MarmottaZigDirInvalidError,
  MarmottaZigDirUnavailableError,
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

type ZigExecutable = { executable: string; args: string[] };
type ZigArtifact = { tarball?: unknown; shasum?: unknown };
export type MarmottaHome = { path: string; fromEnvironment: boolean };
// The Marmotta home is resolved once by ensureZig and travels with the command, so the Zig cache and the build
// directory always come from the same MARMOTTA_HOME value.
type ZigCommand = ZigExecutable & { home: MarmottaHome; env?: NodeJS.ProcessEnv; cacheDirectory?: string };

function isAbsoluteDirectory(value: string): boolean {
  if (process.platform !== 'win32') return isAbsolute(value);
  // Only a drive root ("C:\") or a UNC share ("\\server\share\") is a fixed location: isAbsolute() also accepts
  // "\tools", which depends on the current drive, and the device prefixes "\\.\" and "\\?\".
  const root = win32.parse(value).root.replaceAll('/', '\\');
  return /^[a-zA-Z]:\\$/.test(root) || /^\\\\(?![.?]\\)[^\\]+\\[^\\]+\\?$/.test(root);
}

// Read when a command needs it, so an invalid MARMOTTA_HOME is reported as a Marmotta error by that command.
export function marmottaHome(): MarmottaHome {
  const value = process.env.MARMOTTA_HOME;
  if (!value) return { path: join(homedir(), '.marmotta'), fromEnvironment: false };
  // Surrounding whitespace is usually a copy-paste mistake; rejecting it avoids silently using another directory.
  // "~" is not expanded either: it is a shell feature, so a quoted "~/marmotta" is rejected as relative.
  if (value.trim() !== value || !isAbsoluteDirectory(value)) throw new MarmottaHomeInvalidError(value);
  return { path: resolve(value), fromEnvironment: true };
}

// MARMOTTA_ZIG_DIR names an existing Zig installation, for systems where Zig cannot be downloaded. It follows the
// MARMOTTA_HOME rules and is read when a command needs it.
function configuredZigDirectory(): string | undefined {
  const value = process.env.MARMOTTA_ZIG_DIR;
  if (!value) return undefined;
  if (value.trim() !== value || !isAbsoluteDirectory(value)) throw new MarmottaZigDirInvalidError(value);
  return resolve(value);
}

function zigRoot(home: MarmottaHome): string {
  return join(home.path, 'toolchains', 'zig');
}

// Names the directory that failed and why, and mentions MARMOTTA_HOME when the user configured the location.
export function directoryError(home: MarmottaHome, path: string, cause: unknown): Error {
  if (!home.fromEnvironment) return new MarmottaDirectoryFailedError(path, { cause });
  const target = path === home.path
    ? `the MARMOTTA_HOME directory ${path}`
    : `${path} in the MARMOTTA_HOME directory ${home.path}`;
  return new MarmottaHomeUnavailableError(target, (cause as NodeJS.ErrnoException).code ?? String(cause), { cause });
}

// Each writer creates only the directories it writes into, so commands that only read keep working when the
// Marmotta home directory is read-only.
export async function createBuildDirectory(command: ZigCommand): Promise<string> {
  const { home } = command;
  try {
    await mkdir(home.path, { recursive: true });
    return await mkdtemp(join(home.path, 'build-'));
  } catch (error) {
    throw directoryError(home, home.path, error);
  }
}

// Zig keeps its global cache in the user's home directory; MARMOTTA_HOME moves it unless the user chose one.
// Without MARMOTTA_HOME the cache stays where Zig puts it by default, so existing caches keep being reused.
// An empty ZIG_GLOBAL_CACHE_DIR counts as unset, like an empty MARMOTTA_HOME. process.env lookups are
// case-insensitive on Windows, so this also sees a differently-cased variable. Nothing is written here: the
// cache directory is prepared when Zig first runs.
function withZigEnvironment(home: MarmottaHome, zig: ZigExecutable): ZigCommand {
  if (!home.fromEnvironment || process.env.ZIG_GLOBAL_CACHE_DIR) return { ...zig, home };
  const cacheDirectory = join(home.path, 'cache');
  // Drop an empty, differently-cased variable so the child does not receive two spellings on Windows.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'ZIG_GLOBAL_CACHE_DIR'),
  );
  return { ...zig, home, cacheDirectory, env: { ...env, ZIG_GLOBAL_CACHE_DIR: cacheDirectory } };
}

const preparedCaches = new WeakMap<ZigCommand, Promise<void>>();

// Creates the cache once per command and checks it is writable, so a read-only cache is reported as a
// MARMOTTA_HOME problem instead of as a failed Zig command. access() avoids leaving probe files behind.
function prepareZigCache(command: ZigCommand): Promise<void> {
  const { home, cacheDirectory } = command;
  if (!cacheDirectory) return Promise.resolve();
  let prepared = preparedCaches.get(command);
  if (!prepared) {
    prepared = (async () => {
      try {
        await mkdir(cacheDirectory, { recursive: true });
        await access(cacheDirectory, constants.W_OK);
      } catch (error) {
        throw directoryError(home, cacheDirectory, error);
      }
    })();
    preparedCaches.set(command, prepared);
  }
  return prepared;
}

// Re-emits a captured child stream one line at a time. readline handles CRLF and the trailing
// partial line at end of stream; empty lines are dropped so they do not become blank records.
function forwardLines(stream: NodeJS.ReadableStream | null, emit: (line: string) => void): void {
  if (!stream) return;
  const lines = createInterface({ input: stream, crlfDelay: Infinity, terminal: false });
  lines.on('line', (line) => {
    if (line.length > 0) emit(line);
  });
  // A stream error is reported by the child's own close event; swallowing it here only prevents an
  // unhandled 'error' event from crashing the process while the output was being reformatted.
  stream.on('error', () => {});
}

export function run(executable: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    // JSON output promises one JSON object per line, so raw zig/tar output cannot inherit the
    // terminal in that mode: it is captured and re-emitted as records instead. Text mode keeps the
    // live, streaming output users expect from a build.
    const capture = logger.capturesChildOutput;
    logger.debug(`Running ${basename(executable)}`, { executable, args, cwd: options.cwd ?? process.cwd() });
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    });
    if (capture) {
      const command = basename(executable);
      // Child output is a command result, not a diagnostic: it bypasses MARMOTTA_LOG so compiler
      // errors cannot be filtered out, and `stream` identifies which pipe it came from. stderr
      // carries Zig's and tar's warnings and errors, so its records are "warn" records on stderr;
      // the final failure record is the one with level "error". Each pipe keeps its own line
      // order, but two pipes cannot keep the order between them: Zig and tar write their
      // diagnostics to stderr only, so a note and the error it refers to stay together.
      forwardLines(child.stdout, (line) =>
        logger.output(line, { data: { command, stream: 'stdout' } }));
      forwardLines(child.stderr, (line) =>
        logger.output(line, { data: { command, stream: 'stderr' }, level: 'warn' }));
    }
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

async function findLocalZig(root: string, version?: string): Promise<ZigExecutable | undefined> {
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

function systemZig(): ZigExecutable | undefined {
  const result = spawnSync('zig', ['version'], { stdio: 'ignore' });
  const spawnErrorCode = result.error && 'code' in result.error ? result.error.code : undefined;
  if (result.error && spawnErrorCode !== 'ENOENT') {
    throw new ZigDiscoveryFailedError('Unable to check for Zig in PATH.', { cause: result.error });
  }
  return result.status === 0 ? { executable: 'zig', args: [] } : undefined;
}

async function downloadZig(requestedVersion?: string): Promise<{ version: string; tarball: string; archive: Buffer }> {
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

  logger.debug(`Downloading Zig ${version}`, { url: artifact.tarball });
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
  return { version, tarball: artifact.tarball, archive };
}

// Zig ships .zip archives for Windows, which only bsdtar extracts. Windows 10 1803 and later bundle bsdtar
// as System32\tar.exe, but Git Bash, MSYS2 and Cygwin put GNU tar first on PATH, and GNU tar rejects a zip
// with "This does not look like a tar archive". The bundled one is therefore preferred whenever it exists.
export function tarExecutable(): string {
  if (process.platform !== 'win32') return 'tar';
  const bundled = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  return existsSync(bundled) ? bundled : 'tar';
}

// Installs the contents of an archive under `root` without ever exposing a partial installation: the
// archive is unpacked into a private staging directory and the result is moved into place with a
// single rename. `destination` must be specific to the archive contents (a version, or a hash of the
// archive), so two first runs either find the finished directory or install an identical copy, and a
// writer never removes files that another process is already compiling with. An existing destination
// is only replaced when `isComplete` reports it as a leftover of an interrupted run.
export async function installArchive(options: {
  root: string;
  archive: Buffer;
  archiveName: string;
  destination: string;
  isComplete: (directory: string) => Promise<boolean>;
}): Promise<void> {
  const { root, archive, archiveName, destination, isComplete } = options;
  if (await isComplete(destination)) return;
  const temporaryDir = await mkdtemp(join(root, '.install-'));
  try {
    const stagingDir = join(temporaryDir, 'staged');
    await mkdir(stagingDir);
    await writeFile(join(temporaryDir, archiveName), archive);
    // tar runs from the archive's directory and is given relative paths: GNU tar reads a colon before
    // the first slash of an archive name as the remote syntax `host:path`, so an absolute Windows
    // path ("C:\...") would make it try to reach the host "C". GNU tar and bsdtar both accept this.
    await run(tarExecutable(), ['-xf', archiveName, '-C', 'staged'], { cwd: temporaryDir });
    const entries = await readdir(stagingDir, { withFileTypes: true });
    const extracted = entries.length === 1 && entries[0]?.isDirectory()
      ? join(stagingDir, entries[0].name)
      : stagingDir;
    try {
      await rename(extracted, destination);
    } catch (error) {
      // Another process may have completed the same installation while this one extracted. Its copy
      // has identical contents, so it is kept; only a genuinely incomplete destination is replaced.
      if (await isComplete(destination)) return;
      await rm(destination, { recursive: true, force: true });
      await rename(extracted, destination);
    }
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

async function downloadAndInstallZig(home: MarmottaHome, requestedVersion?: string): Promise<ZigExecutable> {
  const root = zigRoot(home);
  // Create the download directory before any network work, so an unusable location fails before the download.
  await mkdir(root, { recursive: true });
  const { version, tarball, archive } = await downloadZig(requestedVersion);
  const destination = join(root, version);
  await installArchive({
    root,
    archive,
    archiveName: basename(new URL(tarball).pathname),
    destination,
    isComplete: async (directory) => {
      try {
        await access(join(directory, process.platform === 'win32' ? 'zig.exe' : 'zig'));
        return true;
      } catch {
        return false;
      }
    },
  });
  const executable = join(destination, process.platform === 'win32' ? 'zig.exe' : 'zig');
  if (process.platform !== 'win32') await chmod(executable, 0o755);
  return { executable, args: [] };
}

// File system failures keep the ZIG_INSTALL_FAILED code but say which path failed and why.
function installFailureMessage(home: MarmottaHome, error: unknown): string {
  const { code, path } = error as NodeJS.ErrnoException;
  if (!code || !path) return 'Zig installation failed.';
  const location = home.fromEnvironment ? ` in the MARMOTTA_HOME directory ${home.path}` : '';
  return `Zig installation failed: ${code} on ${path}${location}.`;
}

async function installZig(home: MarmottaHome, version?: string): Promise<ZigExecutable> {
  try {
    return await downloadAndInstallZig(home, version);
  } catch (error) {
    if (isMarmottaError(error)) throw error;
    throw new ZigInstallFailedError(installFailureMessage(home, error), { cause: error });
  }
}

async function findZig(home: MarmottaHome, version?: string): Promise<ZigExecutable> {
  const root = zigRoot(home);
  if (version !== undefined) return await findLocalZig(root, version) ?? installZig(home, version);
  return systemZig() ?? await findLocalZig(root) ?? installZig(home);
}

// The configured Zig replaces every other source, including a zigVersion pin: falling back to PATH or to a
// download would bypass a toolchain that was chosen because it cannot be replaced.
async function configuredZig(directory: string): Promise<ZigExecutable> {
  const executable = join(directory, process.platform === 'win32' ? 'zig.exe' : 'zig');
  try {
    await access(executable, constants.X_OK);
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code ?? String(error);
    throw new MarmottaZigDirUnavailableError(executable, reason, { cause: error });
  }
  return { executable, args: [] };
}

// Resolves MARMOTTA_HOME once; the returned command carries it and the Zig environment for runZig and
// createBuildDirectory. Finding an existing Zig writes nothing, so it also works with a read-only home.
export async function ensureZig(version?: string): Promise<ZigCommand> {
  if (version !== undefined) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new ZigVersionInvalidError(version);
  }
  const home = marmottaHome();
  const zigDirectory = configuredZigDirectory();
  const zig = zigDirectory === undefined ? await findZig(home, version) : await configuredZig(zigDirectory);
  const command = withZigEnvironment(home, zig);
  logger.debug(`Using Zig: ${command.executable}`, {
    executable: command.executable,
    home: home.path,
    cacheDirectory: command.cacheDirectory,
  });
  return command;
}


export async function listZigVersions(): Promise<string[]> {
  const root = zigRoot(marmottaHome());
  logger.debug(`Reading Zig versions in ${root}`);
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
  const root = zigRoot(marmottaHome());
  try {
    await rm(join(root, version), { recursive: true, force: true });
  } catch (error) {
    throw new ZigInstallFailedError(`Unable to remove Zig ${version}.`, { cause: error });
  }
}

export async function runZig(command: ZigCommand, args: string[], cwd: string): Promise<void> {
  await prepareZigCache(command);
  await run(command.executable, [...command.args, ...args], { cwd, env: command.env });
}
