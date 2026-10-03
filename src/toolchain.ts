import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { access, chmod, mkdtemp, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { isMarmottaError, MarmottaError } from './errors.js';

export const marmottaRoot = join(homedir(), '.marmotta');
const zigRoot = join(marmottaRoot, 'toolchains', 'zig');
const indexUrl = 'https://ziglang.org/download/index.json';

type ZigCommand = { executable: string; args: string[] };
type ZigArtifact = { tarball?: unknown; shasum?: unknown };

function run(executable: string, args: string[], options: { cwd?: string } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, stdio: 'inherit' });
    child.once('error', (cause: Error) => {
      reject(new MarmottaError('TOOLCHAIN_SPAWN_FAILED', `Unable to start ${basename(executable)}.`, { cause }));
    });
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else {
        const reason = code === null ? `was terminated by signal ${signal ?? 'unknown'}` : `exited with code ${code}`;
        reject(new MarmottaError('TOOLCHAIN_COMMAND_FAILED', `${basename(executable)} ${reason}.`));
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
    throw new MarmottaError('PLATFORM_NOT_SUPPORTED', `Unsupported platform: ${process.platform}/${process.arch}`);
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

async function findLocalZig(): Promise<ZigCommand | undefined> {
  try {
    const versions = await readdir(zigRoot, { withFileTypes: true });
    for (const version of versions) {
      if (!version.isDirectory()) continue;
      const versionDir = join(zigRoot, version.name);
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
              throw new MarmottaError('ZIG_DISCOVERY_FAILED', `Unable to verify ${candidate}.`, { cause: error });
            }
          }
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new MarmottaError('ZIG_DISCOVERY_FAILED', `Unable to inspect ${zigRoot}.`, { cause: error });
    }
  }
  return undefined;
}

function systemZig(): ZigCommand | undefined {
  const result = spawnSync('zig', ['version'], { stdio: 'ignore' });
  const spawnErrorCode = result.error && 'code' in result.error ? result.error.code : undefined;
  if (result.error && spawnErrorCode !== 'ENOENT') {
    throw new MarmottaError('ZIG_DISCOVERY_FAILED', 'Unable to check for Zig in PATH.', { cause: result.error });
  }
  return result.status === 0 ? { executable: 'zig', args: [] } : undefined;
}

export async function ensureMarmottaRoot(): Promise<void> {
  try {
    await mkdir(marmottaRoot, { recursive: true });
  } catch (error) {
    throw new MarmottaError('MARMOTTA_DIRECTORY_FAILED', `Unable to create ${marmottaRoot}.`, { cause: error });
  }
}

async function downloadAndInstallZig(): Promise<ZigCommand> {
  let response: Response;
  try {
    response = await fetch(indexUrl);
  } catch (error) {
    throw new MarmottaError('ZIG_DOWNLOAD_FAILED', 'Failed to download the Zig index.', { cause: error });
  }
  if (!response.ok) {
    throw new MarmottaError('ZIG_DOWNLOAD_FAILED', `Failed to download the Zig index: HTTP ${response.status}`);
  }
  const index: unknown = await response.json();
  if (typeof index !== 'object' || index === null || Array.isArray(index)) {
    throw new MarmottaError('ZIG_INSTALL_FAILED', 'Invalid Zig download index.');
  }

  const versions = Object.keys(index).filter((version) => /^\d+\.\d+\.\d+$/.test(version)).sort(compareVersions);
  const version = versions.at(-1);
  if (!version) throw new MarmottaError('ZIG_INSTALL_FAILED', 'No stable Zig release found.');
  const release = (index as Record<string, unknown>)[version];
  const artifact = typeof release === 'object' && release !== null
    ? (release as Record<string, ZigArtifact>)[platformKey()]
    : undefined;
  if (typeof artifact?.tarball !== 'string') {
    throw new MarmottaError('ZIG_INSTALL_FAILED', `No Zig package available for ${platformKey()}.`);
  }

  let archiveResponse: Response;
  try {
    archiveResponse = await fetch(artifact.tarball);
  } catch (error) {
    throw new MarmottaError('ZIG_DOWNLOAD_FAILED', 'Failed to download the Zig package.', { cause: error });
  }
  if (!archiveResponse.ok) {
    throw new MarmottaError('ZIG_DOWNLOAD_FAILED', `Failed to download Zig: HTTP ${archiveResponse.status}`);
  }
  const archive = Buffer.from(await archiveResponse.arrayBuffer());
  if (typeof artifact.shasum === 'string') {
    const checksum = createHash('sha256').update(archive).digest('hex');
    if (checksum !== artifact.shasum) {
      throw new MarmottaError('ZIG_CHECKSUM_MISMATCH', 'Invalid Zig package checksum.');
    }
  }

  await mkdir(zigRoot, { recursive: true });
  const temporaryDir = await mkdtemp(join(zigRoot, '.download-'));
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
    const installDir = join(zigRoot, version);
    await rm(installDir, { recursive: true, force: true });
    await rename(installSource, installDir);
    const executable = join(installDir, process.platform === 'win32' ? 'zig.exe' : 'zig');
    if (process.platform !== 'win32') await chmod(executable, 0o755);
    return { executable, args: [] };
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

async function installZig(): Promise<ZigCommand> {
  try {
    return await downloadAndInstallZig();
  } catch (error) {
    if (isMarmottaError(error)) throw error;
    throw new MarmottaError('ZIG_INSTALL_FAILED', 'Zig installation failed.', { cause: error });
  }
}

export async function ensureZig(): Promise<ZigCommand> {
  await ensureMarmottaRoot();
  const system = systemZig();
  if (system) return system;
  const local = await findLocalZig();
  return local ?? installZig();
}

export async function listZigVersions(): Promise<string[]> {
  try {
    return (await readdir(zigRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort(compareVersions);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new MarmottaError('ZIG_DISCOVERY_FAILED', `Unable to read Zig versions in ${zigRoot}.`, {
      cause: error,
    });
  }
}

export async function removeZigVersion(version: string): Promise<void> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new MarmottaError('ZIG_VERSION_INVALID', `Invalid Zig version: ${version}`, { exitCode: 2 });
  }
  try {
    await rm(join(zigRoot, version), { recursive: true, force: true });
  } catch (error) {
    throw new MarmottaError('ZIG_INSTALL_FAILED', `Unable to remove Zig ${version}.`, { cause: error });
  }
}

export async function runZig(command: ZigCommand, args: string[], cwd: string): Promise<void> {
  await run(command.executable, [...command.args, ...args], { cwd });
}