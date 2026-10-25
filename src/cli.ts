#!/usr/bin/env node
import { resolve } from 'node:path';
import { build, clean, configure, type BuildOptions } from './build.js';
import { CliArgumentError, CliCommandError, normalizeError } from './errors.js';
import { ensureZig, listZigVersions, removeZigVersion } from './toolchain.js';
import { logger } from './logger.js';
import { MARMOTTA_VERSION } from './version.js';

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

type ParsedArgs = {
  command: string;
  positional: string[];
  options: BuildOptions;
  help: boolean;
  version: boolean;
  json: boolean;
  /** The first argument error. main() throws it once the output format is applied. */
  error?: Error;
};

// Errors that are followed by the usage block in text mode, marked where they are thrown.
const usageErrors = new WeakSet<Error>();

function withUsage<E extends Error>(error: E): E {
  usageErrors.add(error);
  return error;
}

// Flags are recognized before or after the command, so `marmotta --json build` and
// `marmotta build --json` behave the same. The first positional token names the command.
// Parsing continues past the first error, so a later --json still selects the format that error
// is reported in.
function parseArgs(argv: string[]): ParsedArgs {
  const options: BuildOptions = { directory: process.cwd() };
  const positionals: string[] = [];
  let help = false;
  let version = false;
  let json = false;
  let commandOption = false;
  let error: Error | undefined;
  const fail = (failure: Error) => {
    error ??= failure;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '-h' || token === '--help') help = true;
    else if (token === '-v' || token === '--version') version = true;
    else if (token === '--json') json = true;
    else if (token === '--debug') {
      options.debug = true;
      commandOption = true;
    } else if (token === '-C' || token === '--directory' || token === '-o' || token === '--output-dir' || token === '--target') {
      commandOption = true;
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) {
        fail(new CliArgumentError(`Missing value for ${token}`));
        continue;
      }
      index += 1;
      if (token === '-C' || token === '--directory') options.directory = resolve(value);
      else if (token === '-o' || token === '--output-dir') options.outputDir = value;
      else options.target = value;
    } else if (token.startsWith('-')) {
      fail(new CliArgumentError(`Unknown option: ${token}`));
    } else positionals.push(token);
  }

  const [command, ...rest] = positionals;
  // --version is a top-level request. Combining it with a command would print the version and
  // silently skip the requested work, so reject the combination instead.
  if (version && command !== undefined && command !== 'help') {
    fail(new CliArgumentError('--version cannot be combined with a command'));
  }
  // Command options without a command would otherwise fall through to help and exit 0, so a
  // script that forgot the command would pass without doing anything.
  if (command === undefined && commandOption && !help && !version) {
    fail(withUsage(new CliCommandError('Missing command')));
  }
  return {
    command: command ?? 'help',
    positional: rest,
    options,
    // No positional token means help, unless the user asked for --version instead.
    help: help || command === 'help' || (command === undefined && !version),
    version,
    json,
    error,
  };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  // The format is applied before any argument error is thrown, so that error and an invalid
  // MARMOTTA_LOG warning are both reported in the requested format.
  logger.setFormat(parsed.json ? 'json' : 'text');
  logger.checkLevel();
  if (parsed.error) throw parsed.error;

  if (parsed.help) {
    logger.output(usage);
    return;
  }
  if (parsed.version) {
    logger.output(`marmotta ${MARMOTTA_VERSION}`);
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
      logger.output('Zig toolchain is ready.');
      break;
    case 'list': {
      const versions = await listZigVersions();
      logger.output(versions.length > 0 ? 'Installed Zig versions' : 'No Zig versions installed by Marmotta.', {
        data: { versions },
        text: versions.length > 0 ? versions.join('\n') : undefined,
      });
      break;
    }
    case 'remove': {
      const version = parsed.positional[0];
      if (!version) {
        throw new CliArgumentError('Specify the Zig version to remove.');
      }
      await removeZigVersion(version);
      logger.output(`Removed Zig version ${version}.`);
      break;
    }
    default:
      throw withUsage(new CliCommandError(`Unknown command: ${parsed.command}`));
  }
}

main().catch((error: unknown) => {
  const normalized = normalizeError(error);
  // Text mode keeps the historical "marmotta [CODE]: message" line and appends the usage block for
  // errors marked with withUsage(); the JSON record omits it so its message stays a single line.
  const base = `marmotta [${normalized.code}]: ${normalized.message}`;
  const text = usageErrors.has(normalized) ? `${base}\n\n${usage}` : base;
  logger.failure(normalized.message, { code: normalized.code, exitCode: normalized.exitCode }, text);
  process.exitCode = normalized.exitCode;
});
