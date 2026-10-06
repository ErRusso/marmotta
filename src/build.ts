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
  outputDir?: string;
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
  const outputDir = options.outputDir ? resolve(options.directory, options.outputDir) : config.outputDir;
  const output = join(outputDir, `${config.name}.node`);
  if (cleanOnly) {
    await rm(output, { force: true });
    console.log(`Removed ${output}`);
    return;
  }

  const zig = await ensureZig();
  await ensureMarmottaRoot();
  const temporaryDir = await mkdtemp(join(marmottaRoot, 'build-'));
  const hasCpp = config.sources.some(isCpp);
  const windowsTarget = isWindowsTarget(options.target);
  const includeFlags = ['-I', nodeApiHeaders.include_dir, ...config.includeDirs.flatMap((item) => ['-I', item])];
  const objects: string[] = [];
  // NODE_GYP_MODULE_NAME is used as a bare token, so it must be a valid C identifier.
  const moduleName = config.name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');

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
      const args = [compiler, '-c', source, `-DNODE_GYP_MODULE_NAME=${moduleName}`, ...includeFlags, ...flags, '-o', object];
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
    console.log(`Addon built: ${output}`);
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

export async function configure(options: BuildOptions): Promise<ProjectConfig> {
  const config = await loadProject(options.directory, { target: options.target });
  await ensureZig();
  console.log(`Configuration ready: ${config.name} (${config.sources.length} sources)`);
  return config;
}

export async function build(options: BuildOptions): Promise<void> {
  const config = await loadProject(options.directory, { target: options.target });
  await compile(config, options, false);
}

export async function clean(options: BuildOptions): Promise<void> {
  const config = await loadProject(options.directory, { target: options.target });
  await compile(config, options, true);
}
