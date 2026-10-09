#!/usr/bin/env node
import { resolve } from 'node:path';
import { build, clean, configure, type BuildOptions } from './build.js';
import { CliArgumentError, CliCommandError, normalizeError } from './errors.js';
import { ensureZig, listZigVersions, removeZigVersion } from './toolchain.js';

const usage = `Marmotta - build tool for Node.js addons with Zig

Usage: marmotta <command> [options]

Commands:
  configure           validate project and toolchain
  build               compile the C/C++ addon
  rebuild             clean and rebuild the addon
  clean               remove the generated addon
  install             install Zig if it is not already available
  list                list Zig versions managed by Marmotta
  remove <version>    remove a Zig version managed by Marmotta

Options:
  -C, --directory     project directory (default: current directory)
  -o, --output-dir    directory where <name>.node is generated
      --target        Zig target, e.g. aarch64-macos or x86_64-windows
      --debug         compile without optimizations
  -h, --help          show this help
  -v, --version       show the version

Environment:
  MARMOTTA_ZIG_DIR    custom directory for managed Zig toolchains and build state
`;

type ParsedArgs = { command: string; positional: string[]; options: BuildOptions; help: boolean };

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...tokens] = argv;
  const options: BuildOptions = { directory: process.cwd() };
  const positional: string[] = [];
  let help = command === 'help' || command === '--help' || command === '-h';

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '-h' || token === '--help') help = true;
    else if (token === '--debug') options.debug = true;
    else if (token === '-C' || token === '--directory' || token === '-o' || token === '--output-dir' || token === '--target') {
      const value = tokens[index + 1];
      if (!value || value.startsWith('-')) {
        throw new CliArgumentError(`Missing value for ${token}`);
      }
      index += 1;
      if (token === '-C' || token === '--directory') options.directory = resolve(value);
      else if (token === '-o' || token === '--output-dir') options.outputDir = value;
      else options.target = value;
    } else if (token.startsWith('-')) {
      throw new CliArgumentError(`Unknown option: ${token}`);
    } else positional.push(token);
  }

  return { command, positional, options, help };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(usage);
    return;
  }
  if (parsed.command === '--version' || parsed.command === '-v') {
    console.log('marmotta 0.5.0');
    return;
  }

  switch (parsed.command) {
    case 'configure':
      await configure(parsed.options);
      break;
    case 'build':
      await build(parsed.options);
      break;
    case 'rebuild':
      await clean(parsed.options);
      await build(parsed.options);
      break;
    case 'clean':
      await clean(parsed.options);
      break;
    case 'install':
      await ensureZig();
      console.log('Zig toolchain is ready.');
      break;
    case 'list': {
      const versions = await listZigVersions();
      console.log(versions.length > 0 ? versions.join('\n') : 'No Zig versions installed by Marmotta.');
      break;
    }
    case 'remove': {
      const version = parsed.positional[0];
      if (!version) {
        throw new CliArgumentError('Specify the Zig version to remove.');
      }
      await removeZigVersion(version);
      console.log(`Removed Zig version ${version}.`);
      break;
    }
    default:
      throw new CliCommandError(`Unknown command: ${parsed.command}\n\n${usage}`);
  }
}

main().catch((error: unknown) => {
  const normalized = normalizeError(error);
  console.error(`marmotta [${normalized.code}]: ${normalized.message}`);
  process.exitCode = normalized.exitCode;
});
