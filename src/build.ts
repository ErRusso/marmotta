import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { loadProject, type ProjectConfig } from './project.js';
import { ensureMarmottaRoot, ensureZig, marmottaRoot, runZig } from './toolchain.js';

const require = createRequire(import.meta.url);
type NodeApiHeaders = { include_dir: string; def_paths: { node_api_def: string } };
const nodeApiHeaders = require('node-api-headers') as NodeApiHeaders;

export type BuildOptions = {
  directory: string;
  output?: string;
  target?: string;
  debug?: boolean;
};

function isCpp(source: string): boolean {
  return ['.cc', '.cpp', '.cxx'].includes(extname(source).toLowerCase());
}

function isWindowsTarget(target: string | undefined): boolean {
  return target ? target.includes('windows') : process.platform === 'win32';
}

function isMacosTarget(target: string | undefined): boolean {
  return target ? target.includes('macos') || target.includes('darwin') : process.platform === 'darwin';
}

function windowsMachine(target: string | undefined): string {
  if (target?.includes('aarch64') || target?.includes('arm64')) return 'arm64';
  if (target?.includes('i386') || target?.includes('i686')) return 'i386';
  if (target?.includes('x86_64') || target?.includes('amd64')) return 'i386:x86-64';
  return process.arch === 'arm64' ? 'arm64' : 'i386:x86-64';
}

async function compile(config: ProjectConfig, options: BuildOptions, cleanOnly: boolean): Promise<void> {
  const output = options.output ? resolve(options.directory, options.output) : config.output;
  if (cleanOnly) {
    await rm(output, { force: true });
    console.log(`Rimosso ${output}`);
    return;
  }

  const zig = await ensureZig();
  await ensureMarmottaRoot();
  const temporaryDir = await mkdtemp(join(marmottaRoot, 'build-'));
  const hasCpp = config.sources.some(isCpp);
  const windowsTarget = isWindowsTarget(options.target);
  const includeFlags = ['-I', nodeApiHeaders.include_dir, ...config.includeDirs.flatMap((item) => ['-I', item])];
  const objects: string[] = [];

  try {
    if (windowsTarget) {
      const importLibrary = join(temporaryDir, 'libnode_api.a');
      await runZig(zig, [
        'dlltool',
        '-m',
        windowsMachine(options.target),
        '-d',
        nodeApiHeaders.def_paths.node_api_def,
        '-l',
        importLibrary,
      ], options.directory);
    }

    for (const [index, source] of config.sources.entries()) {
      const object = join(temporaryDir, `source-${index}.o`);
      const compiler = isCpp(source) ? 'c++' : 'cc';
      const flags = isCpp(source) ? config.cxxFlags : config.cFlags;
      const args = [compiler, '-c', source, ...includeFlags, ...flags, '-o', object];
      if (!windowsTarget) args.push('-fPIC');
      if (options.target) args.push('-target', options.target);
      if (options.debug) args.push('-O0', '-g');
      else args.push('-O2');
      await runZig(zig, args, options.directory);
      objects.push(object);
    }

    const linker = hasCpp ? 'c++' : 'cc';
  const args = [linker];
  if (isMacosTarget(options.target)) args.push('-shared', '-undefined', 'dynamic_lookup');
  else args.push('-shared');
  args.push(...objects, '-o', output, ...config.linkerFlags);
    if (options.target) args.push('-target', options.target);
    if (windowsTarget) args.push('-L', temporaryDir, '-lnode_api');
  else if (!isMacosTarget(options.target)) args.push('-Xlinker', '--allow-shlib-undefined');

    await mkdir(dirname(output), { recursive: true });
    await runZig(zig, args, options.directory);
    console.log(`Addon creato: ${output}`);
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

export async function configure(options: BuildOptions): Promise<ProjectConfig> {
  const config = await loadProject(options.directory);
  await ensureZig();
  console.log(`Configurazione pronta: ${config.name} (${config.sources.length} sorgenti)`);
  return config;
}

export async function build(options: BuildOptions): Promise<void> {
  const config = await loadProject(options.directory);
  await compile(config, options, false);
}

export async function clean(options: BuildOptions): Promise<void> {
  const config = await loadProject(options.directory);
  await compile(config, options, true);
}