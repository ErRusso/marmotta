import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { MarmottaError } from './errors.js';

export type ProjectConfig = {
  name: string;
  sources: string[];
  includeDirs: string[];
  cFlags: string[];
  cxxFlags: string[];
  linkerFlags: string[];
  output: string;
};

type PackageJson = { name?: unknown };

const sourceExtensions = new Set(['.c', '.cc', '.cpp', '.cxx']);
const ignoredDirectories = new Set(['.git', '.marmotta', 'build', 'dist', 'node_modules']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new MarmottaError('PROJECT_CONFIG_INVALID', `La proprietà "${key}" deve essere un array di stringhe.`);
  }
  return value;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

async function findSources(directory: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await visit(entryPath);
      } else if (entry.isFile() && sourceExtensions.has(extname(entry.name).toLowerCase())) {
        found.push(entryPath);
      }
    }
  };
  await visit(directory);
  return found.sort();
}

async function projectName(directory: string): Promise<string> {
  try {
    const packageJson = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as PackageJson;
    if (typeof packageJson.name === 'string' && packageJson.name.length > 0) {
      return packageJson.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw new MarmottaError('PROJECT_PACKAGE_READ_FAILED', `Impossibile leggere package.json in ${directory}.`, {
        cause: error,
      });
    }
  }
  return basename(directory).replace(/[^a-zA-Z0-9_-]/g, '_');
}

export async function loadProject(directory: string): Promise<ProjectConfig> {
  const configPath = join(directory, 'marmotta.config.json');
  let input: Record<string, unknown> = {};
  let configContents: string | undefined;
  try {
    configContents = await readFile(configPath, 'utf8');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw new MarmottaError('PROJECT_CONFIG_READ_FAILED', `Impossibile leggere ${configPath}.`, { cause: error });
    }
  }
  if (configContents !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(configContents);
    } catch (error) {
      throw new MarmottaError('PROJECT_CONFIG_INVALID', `JSON non valido in ${configPath}.`, { cause: error });
    }
    if (!isRecord(parsed)) {
      throw new MarmottaError('PROJECT_CONFIG_INVALID', 'La configurazione deve essere un oggetto JSON.');
    }
    input = parsed;
  }

  const sources = stringArray(input.sources, 'sources');
  const includeDirs = stringArray(input.includeDirs, 'includeDirs');
  const cFlags = stringArray(input.cFlags, 'cFlags');
  const cxxFlags = stringArray(input.cxxFlags, 'cxxFlags');
  const linkerFlags = stringArray(input.linkerFlags, 'linkerFlags');
  const name = typeof input.name === 'string' && input.name.length > 0
    ? input.name.replace(/[^a-zA-Z0-9_-]/g, '_')
    : await projectName(directory);
  let discoveredSources: string[];
  try {
    discoveredSources = sources.length > 0
      ? sources.map((source) => resolve(directory, source))
      : await findSources(directory);
  } catch (error) {
    throw new MarmottaError('PROJECT_SOURCE_READ_FAILED', `Impossibile cercare sorgenti in ${directory}.`, { cause: error });
  }
  if (discoveredSources.length === 0) {
    throw new MarmottaError(
      'PROJECT_SOURCES_NOT_FOUND',
      'Nessun sorgente C/C++ trovato. Aggiungi "sources" a marmotta.config.json.',
    );
  }

  for (const source of discoveredSources) {
    let sourceStats;
    try {
      sourceStats = await stat(source);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        throw new MarmottaError('PROJECT_SOURCE_NOT_FOUND', `Sorgente non trovato: ${source}`, { cause: error });
      }
      throw new MarmottaError('PROJECT_SOURCE_READ_FAILED', `Impossibile accedere al sorgente: ${source}`, {
        cause: error,
      });
    }
    if (!sourceStats.isFile()) {
      throw new MarmottaError('PROJECT_SOURCE_INVALID', `Il sorgente non è un file: ${source}`);
    }
  }

  return {
    name,
    sources: discoveredSources,
    includeDirs: includeDirs.map((item) => resolve(directory, item)),
    cFlags,
    cxxFlags,
    linkerFlags,
    output: resolve(directory, typeof input.output === 'string' ? input.output : `${name}.node`),
  };
}