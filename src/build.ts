import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { loadProject, type ProjectConfig } from './project.js';
import { ensureMarmottaRoot, ensureZig, marmottaRoot, runZig } from './toolchain.js';
import { hostImportsSource, readDefSymbols } from './windows-host.js';

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

async function compile(config: ProjectConfig, options: BuildOptions, cleanOnly: boolean): Promise<void> {
  const outputDir = options.outputDir ? resolve(options.directory, options.outputDir) : config.outputDir;
  const output = join(outputDir, `${config.name}.node`);
  if (cleanOnly) {
    await rm(output, { force: true });
    console.log(`Removed ${output}`);
    return;
  }

  const zig = await ensureZig(config.zigVersion);
  await ensureMarmottaRoot();
  const temporaryDir = await mkdtemp(join(marmottaRoot, 'build-'));
  const hasCpp = config.sources.some(isCpp);
  const windowsTarget = isWindowsTarget(options.target);
  const includeFlags = ['-I', nodeApiHeaders.include_dir, ...config.includeDirs.flatMap((item) => ['-I', item])];
  const objects: string[] = [];
  // NODE_GYP_MODULE_NAME is used as a bare token, so it must be a valid C identifier.
  const moduleName = config.name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');

  const commonFlags = [
    ...(windowsTarget ? [] : ['-fPIC']),
    ...(options.target ? ['-target', options.target] : []),
    ...(options.debug ? ['-O0', '-g'] : ['-O2']),
  ];

  try {
    for (const [index, source] of config.sources.entries()) {
      const object = join(temporaryDir, `source-${index}.o`);
      const compiler = isCpp(source) ? 'c++' : 'cc';
      const flags = isCpp(source) ? config.cxxFlags : config.cFlags;
      const args = [compiler, '-c', source, `-DNODE_GYP_MODULE_NAME=${moduleName}`, ...includeFlags, ...flags, '-o', object];
      args.push(...commonFlags);
      await runZig(zig, args, options.directory);
      objects.push(object);
    }

    if (windowsTarget) {
      // Bind Node-API to whichever process loads the addon (node.exe, Electron, ...), not to NODE.EXE.
      const hostImports = join(temporaryDir, 'node-api-host.c');
      const object = join(temporaryDir, 'node-api-host.o');
      await writeFile(hostImports, hostImportsSource(await readDefSymbols(nodeApiHeaders.def_paths.node_api_def)));
      await runZig(zig, ['cc', '-c', hostImports, '-o', object, ...commonFlags], options.directory);
      objects.push(object);
    }

    const linker = hasCpp ? 'c++' : 'cc';
    const args = [linker];
    if (isMacosTarget(options.target)) args.push('-shared', '-undefined', 'dynamic_lookup');
    else args.push('-shared');
    args.push(...objects, '-o', output, ...config.linkerFlags);
    if (options.target) args.push('-target', options.target);
    if (!windowsTarget && !isMacosTarget(options.target)) args.push('-Xlinker', '--allow-shlib-undefined');

    await mkdir(dirname(output), { recursive: true });
    await runZig(zig, args, options.directory);
    console.log(`Addon built: ${output}`);
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

export async function configure(options: BuildOptions): Promise<ProjectConfig> {
  const config = await loadProject(options.directory, { target: options.target });
  await ensureZig(config.zigVersion);
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
