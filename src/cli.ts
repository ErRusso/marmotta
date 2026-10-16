#!/usr/bin/env node
import { resolve } from 'node:path';
import { build, clean, configure, type BuildOptions } from './build.js';
import { CliArgumentError, CliCommandError, normalizeError } from './errors.js';
import { ensureZig, listZigVersions, removeZigVersion } from './toolchain.js';
import { logger } from './logger.js';

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
      --json          output machine-readable JSON lines
  -h, --help          show this help
  -v, --version       show the version

Environment:
  MARMOTTA_HOME       absolute path that replaces ~/.marmotta as Marmotta's root directory
  MARMOTTA_ZIG_DIR    absolute path of an existing Zig installation to use instead of downloading Zig
  MARMOTTA_LOG        minimum log level: trace, debug, info (default), warn, error, fatal, silent`;

type ParsedArgs = { command: string; positional: string[]; options: BuildOptions; help: boolean; version: boolean };

// Flags are recognized before or after the command, so `marmotta --json build` and
// `marmotta build --json` behave the same. The first positional token names the command.
function parseArgs(argv: string[]): ParsedArgs {
  const options: BuildOptions = { directory: process.cwd() };
  const positionals: string[] = [];
  let help = false;
  let version = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '-h' || token === '--help') help = true;
    else if (token === '-v' || token === '--version') version = true;
    else if (token === '--debug') options.debug = true;
    else if (token === '--json') { /* the output format is applied before parsing; see main() */ }
    else if (token === '-C' || token === '--directory' || token === '-o' || token === '--output-dir' || token === '--target') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) {
        throw new CliArgumentError(`Missing value for ${token}`);
      }
      index += 1;
      if (token === '-C' || token === '--directory') options.directory = resolve(value);
      else if (token === '-o' || token === '--output-dir') options.outputDir = value;
      else options.target = value;
    } else if (token.startsWith('-')) {
      throw new CliArgumentError(`Unknown option: ${token}`);
    } else positionals.push(token);
  }

  const [command, ...rest] = positionals;
  return {
    command: command ?? 'help',
    positional: rest,
    options,
    // No positional token means help, unless the user asked for --version instead.
    help: help || command === 'help' || (command === undefined && !version),
    version,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // The output format is resolved from the raw arguments before parsing, so argument-parsing
  // failures are reported in the requested format too.
  logger.setFormat(argv.includes('--json') ? 'json' : 'text');
  const parsed = parseArgs(argv);

  if (parsed.help) {
    logger.info(usage);
    return;
  }
  if (parsed.version) {
    logger.info('marmotta 0.6.0');
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
      logger.info('Zig toolchain is ready.');
      break;
    case 'list': {
      const versions = await listZigVersions();
      if (versions.length === 0) logger.info('No Zig versions installed by Marmotta.');
      // JSON consumers get one record per version; text mode prints the list unchanged.
      else if (logger.format === 'json') for (const version of versions) logger.info(version);
      else logger.info(versions.join('\n'));
      break;
    }
    case 'remove': {
      const version = parsed.positional[0];
      if (!version) {
        throw new CliArgumentError('Specify the Zig version to remove.');
      }
      await removeZigVersion(version);
      logger.info(`Removed Zig version ${version}.`);
      break;
    }
    default:
      throw new CliCommandError(`Unknown command: ${parsed.command}\n\n${usage}`);
  }
}

main().catch((error: unknown) => {
  const normalized = normalizeError(error);
  // Text mode keeps the historical "marmotta [CODE]: message" line; JSON records carry the code
  // and exit code as structured fields instead of embedding them in the message.
  if (logger.format === 'json') {
    logger.error(normalized.message, { code: normalized.code, exitCode: normalized.exitCode });
  } else {
    logger.error(`marmotta [${normalized.code}]: ${normalized.message}`);
  }
  process.exitCode = normalized.exitCode;
});
