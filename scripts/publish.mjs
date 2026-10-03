#!/usr/bin/env node
// Publishes the package to npm under every name listed in PACKAGE_NAMES.
// Usage: node scripts/publish.mjs [--dry-run] [--tag <tag>] [--otp <code>] [--skip-tests]
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAMES = ['marmotta', '@napi-bindings/marmotta'];

const root = fileURLToPath(new URL('..', import.meta.url));
const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function parseArgs(argv) {
  const options = { dryRun: false, skipTests: false, tag: undefined, otp: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--skip-tests') options.skipTests = true;
    else if (arg === '--tag' || arg === '--otp') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) fail(`Missing value for ${arg}`);
      options[arg.slice(2)] = value;
      index += 1;
    } else fail(`Unknown option: ${arg}`);
  }
  return options;
}

function fail(message) {
  console.error(`publish: ${message}`);
  process.exit(1);
}

function run(args) {
  const result = spawnSync(npm, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(`"npm ${args.join(' ')}" failed with exit code ${result.status}`);
}

const options = parseArgs(process.argv.slice(2));
const originalManifest = readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(originalManifest);
const failures = [];

try {
  console.log(options.skipTests ? 'Building...' : 'Building and testing...');
  run(options.skipTests ? ['run', 'build'] : ['test']);

  const publishArgs = ['publish', '--access', 'public'];
  if (options.dryRun) publishArgs.push('--dry-run');
  if (options.tag) publishArgs.push('--tag', options.tag);
  if (options.otp) publishArgs.push('--otp', options.otp);

  for (const name of PACKAGE_NAMES) {
    console.log(`\nPublishing ${name}@${manifest.version}${options.dryRun ? ' (dry run)' : ''}...`);
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, name }, null, 2)}\n`);
    try {
      run(publishArgs);
    } catch (error) {
      console.error(`publish: ${name} failed: ${error.message}`);
      failures.push(name);
    }
  }
} catch (error) {
  console.error(`publish: ${error.message}`);
  failures.push('(pre-publish steps)');
} finally {
  writeFileSync(manifestPath, originalManifest);
}

if (failures.length > 0) fail(`failed: ${failures.join(', ')}`);
console.log('\nDone.');
