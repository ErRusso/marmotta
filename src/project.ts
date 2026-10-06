import { readFile, readdir, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { basename, extname, join, resolve } from 'node:path';
import {
  ProjectConfigInvalidError,
  ProjectConfigLoadFailedError,
  ProjectConfigReadFailedError,
  ProjectPackageReadFailedError,
  ProjectSourceInvalidError,
  ProjectSourceNotFoundError,
  ProjectSourceReadFailedError,
  ProjectSourcesNotFoundError,
} from './errors.js';

export type ProjectConfig = {
  name: string;
  sources: string[];
  includeDirs: string[];
  cFlags: string[];
  cxxFlags: string[];
  linkerFlags: string[];
  outputDir: string;
};

export type ProjectConfigContext = {
  directory: string;
  target?: string;
  platform: NodeJS.Platform;
  arch: string;
};

type PackageJson = { name?: unknown };

const sourceExtensions = new Set(['.c', '.cc', '.cpp', '.cxx']);
const ignoredDirectories = new Set(['.git', '.marmotta', 'build', 'dist', 'node_modules']);
let configLoadId = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new ProjectConfigInvalidError(`The "${key}" property must be an array of strings.`);
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
      throw new ProjectPackageReadFailedError(directory, { cause: error });
    }
  }
  return basename(directory).replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function loadConfigInput(
  directory: string,
  context: ProjectConfigContext,
): Promise<Record<string, unknown>> {
  const jsConfigPath = join(directory, 'marmotta.config.js');
  let jsConfigStats;
  try {
    jsConfigStats = await stat(jsConfigPath);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw new ProjectConfigReadFailedError(jsConfigPath, { cause: error });
    }
  }

  if (jsConfigStats) {
    if (!jsConfigStats.isFile()) {
      throw new ProjectConfigInvalidError(`${jsConfigPath} must be a file.`);
    }
    let exported: unknown;
    try {
      const configUrl = pathToFileURL(jsConfigPath);
      configUrl.searchParams.set('marmotta-load', String(++configLoadId));
      const configModule = await import(configUrl.href) as { default?: unknown };
      exported = configModule.default;
    } catch (error) {
      throw new ProjectConfigLoadFailedError(jsConfigPath, { cause: error });
    }

    let config: unknown;
    try {
      config = typeof exported === 'function' ? await exported(context) : exported;
    } catch (error) {
      throw new ProjectConfigLoadFailedError(jsConfigPath, { cause: error });
    }
    if (!isRecord(config)) {
      throw new ProjectConfigInvalidError(
        `The default export in ${jsConfigPath} must be a configuration object or a function returning one.`,
      );
    }
    return config;
  }

  const configPath = join(directory, 'marmotta.config.json');
  let input: Record<string, unknown> = {};
  let configContents: string | undefined;
  try {
    configContents = await readFile(configPath, 'utf8');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw new ProjectConfigReadFailedError(configPath, { cause: error });
    }
  }
  if (configContents !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(configContents);
    } catch (error) {
      throw new ProjectConfigInvalidError(`Invalid JSON in ${configPath}.`, { cause: error });
    }
    if (!isRecord(parsed)) {
      throw new ProjectConfigInvalidError('The configuration must be a JSON object.');
    }
    input = parsed;
  }
  return input;
}

export async function loadProject(
  directory: string,
  options: { target?: string } = {},
): Promise<ProjectConfig> {
  const input = await loadConfigInput(directory, {
    directory,
    target: options.target,
    platform: process.platform,
    arch: process.arch,
  });
  const sources = stringArray(input.sources, 'sources');
  const includeDirs = stringArray(input.includeDirs, 'includeDirs');
  const cFlags = stringArray(input.cFlags, 'cFlags');
  const cxxFlags = stringArray(input.cxxFlags, 'cxxFlags');
  const linkerFlags = stringArray(input.linkerFlags, 'linkerFlags');
  const name = typeof input.name === 'string' && input.name.length > 0
    ? input.name.replace(/[^a-zA-Z0-9_-]/g, '_')
    : await projectName(directory);
  if (input.outputDir !== undefined && (typeof input.outputDir !== 'string' || input.outputDir.length === 0)) {
    throw new ProjectConfigInvalidError('The "outputDir" property must be a non-empty string.');
  }
  const outputDir = typeof input.outputDir === 'string' ? input.outputDir : '.';
  let discoveredSources: string[];
  try {
    discoveredSources = sources.length > 0
      ? sources.map((source) => resolve(directory, source))
      : await findSources(directory);
  } catch (error) {
    throw new ProjectSourceReadFailedError(`Unable to search for sources in ${directory}.`, { cause: error });
  }
  if (discoveredSources.length === 0) {
    throw new ProjectSourcesNotFoundError();
  }

  for (const source of discoveredSources) {
    let sourceStats;
    try {
      sourceStats = await stat(source);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') throw new ProjectSourceNotFoundError(source, { cause: error });
      throw new ProjectSourceReadFailedError(`Unable to access source: ${source}`, { cause: error });
    }
    if (!sourceStats.isFile()) throw new ProjectSourceInvalidError(source);
  }

  return {
    name,
    sources: discoveredSources,
    includeDirs: includeDirs.map((item) => resolve(directory, item)),
    cFlags,
    cxxFlags,
    linkerFlags,
    outputDir: resolve(directory, outputDir),
  };
}