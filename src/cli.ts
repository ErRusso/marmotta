#!/usr/bin/env node
import { resolve } from 'node:path';
import { build, clean, configure, type BuildOptions } from './build.js';
import { MarmottaError, normalizeError } from './errors.js';
import { ensureZig, listZigVersions, removeZigVersion } from './toolchain.js';

const usage = `Marmotta - build tool per addon Node.js con Zig

Uso: marmotta <comando> [opzioni]

Comandi:
  configure           verifica progetto e toolchain
  build               compila l'addon C/C++
  rebuild             pulisce e ricompila l'addon
  clean               rimuove l'addon generato
  install             installa Zig se non è già disponibile
  list                elenca le versioni Zig gestite da Marmotta
  remove <versione>   rimuove una versione Zig gestita da Marmotta

Opzioni:
  -C, --directory     directory del progetto (predefinita: corrente)
  -o, --out           percorso del file .node generato
      --target        target Zig, ad esempio aarch64-macos o x86_64-windows
      --debug         compila senza ottimizzazioni
  -h, --help          mostra questo aiuto
  -v, --version       mostra la versione`;

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
    else if (token === '-C' || token === '--directory' || token === '-o' || token === '--out' || token === '--target') {
      const value = tokens[index + 1];
      if (!value || value.startsWith('-')) {
        throw new MarmottaError('CLI_ARGUMENT_ERROR', `Valore mancante per ${token}`, { exitCode: 2 });
      }
      index += 1;
      if (token === '-C' || token === '--directory') options.directory = resolve(value);
      else if (token === '-o' || token === '--out') options.output = value;
      else options.target = value;
    } else if (token.startsWith('-')) {
      throw new MarmottaError('CLI_ARGUMENT_ERROR', `Opzione non riconosciuta: ${token}`, { exitCode: 2 });
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
    console.log('marmotta 0.1.0');
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
      console.log('Toolchain Zig pronto.');
      break;
    case 'list': {
      const versions = await listZigVersions();
      console.log(versions.length > 0 ? versions.join('\n') : 'Nessuna versione Zig installata da Marmotta.');
      break;
    }
    case 'remove': {
      const version = parsed.positional[0];
      if (!version) {
        throw new MarmottaError('CLI_ARGUMENT_ERROR', 'Specifica la versione Zig da rimuovere.', { exitCode: 2 });
      }
      await removeZigVersion(version);
      console.log(`Rimossa versione Zig ${version}.`);
      break;
    }
    default:
      throw new MarmottaError('CLI_COMMAND_ERROR', `Comando non riconosciuto: ${parsed.command}\n\n${usage}`, {
        exitCode: 2,
      });
  }
}

main().catch((error: unknown) => {
  const normalized = normalizeError(error);
  console.error(`marmotta [${normalized.code}]: ${normalized.message}`);
  process.exitCode = normalized.exitCode;
});