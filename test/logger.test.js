import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { Logger } from '../dist/logger.js';

function capture(format = 'json', level = 'info') {
  const stdout = [];
  const stderr = [];
  return {
    logger: new Logger({
      format,
      level,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    }),
    stdout,
    stderr,
  };
}

// Splits captured chunks on newlines and parses each record, which fails if a record is not
// newline-terminated or if two records share a line.
function records(chunks) {
  return chunks.join('').split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

test('writes one newline-terminated JSON record per call and routes levels to the right stream', () => {
  const { logger, stdout, stderr } = capture();

  logger.info('first record');
  logger.info('second record', { addon: 'hello.node' });
  logger.warn('cache miss');
  logger.error('compile failed', { code: 'TOOLCHAIN_COMMAND_FAILED' });

  for (const chunk of [...stdout, ...stderr]) assert.ok(chunk.endsWith('\n'), JSON.stringify(chunk));

  const [first, second] = records(stdout);
  assert.equal(first.level, 'info');
  assert.equal(first.message, 'first record');
  assert.equal(typeof first.time, 'number');
  assert.deepEqual(second.data, { addon: 'hello.node' });

  const [warned, failed] = records(stderr);
  assert.equal(warned.level, 'warn');
  assert.equal(warned.message, 'cache miss');
  assert.equal(failed.level, 'error');
  assert.deepEqual(failed.data, { code: 'TOOLCHAIN_COMMAND_FAILED' });
});

test('keeps text output plain, multi-line, and includes the data payload', () => {
  const { logger, stdout, stderr } = capture('text');

  logger.info('marmotta 0.6.0');
  logger.info('Commands:\n  build\n  clean');
  logger.warn('careful', { code: 'SOMETHING' });

  assert.deepEqual(stdout, ['marmotta 0.6.0', 'Commands:\n  build\n  clean']);
  assert.match(stderr[0], /^careful\n/);
  assert.match(stderr[0], /code: 'SOMETHING'/);
});

test('emits records for empty messages instead of dropping them', () => {
  const json = capture();
  json.logger.info('');
  json.logger.error('', { code: 'SOMETHING' });
  assert.equal(records(json.stdout)[0].message, '');
  assert.deepEqual(records(json.stderr)[0].data, { code: 'SOMETHING' });

  const text = capture('text');
  text.logger.info('');
  assert.deepEqual(text.stdout, ['']);
});

test('keeps JSON records valid when context is circular', () => {
  const { logger, stdout } = capture();
  const context = { addon: 'hello.node' };
  context.self = context;

  logger.info('context', context);

  const [record] = records(stdout);
  assert.equal(record.data.self, '[Circular]');
  assert.equal(record.data.addon, 'hello.node');
});

test('does not throw on null-prototype objects in either format', () => {
  const context = Object.create(null);
  context.self = context;

  const json = capture();
  assert.doesNotThrow(() => json.logger.info('null-prototype', context));
  assert.equal(records(json.stdout)[0].data.self, '[Circular]');

  const text = capture('text');
  assert.doesNotThrow(() => text.logger.info('null-prototype', context));
  assert.match(text.stdout[0], /self/);
});

test('debug records are hidden until the level allows them', () => {
  const quiet = capture();
  quiet.logger.debug('hidden');
  assert.deepEqual(quiet.stdout, []);
  assert.deepEqual(quiet.stderr, []);

  const loud = capture('json', 'debug');
  loud.logger.debug('visible');
  assert.equal(records(loud.stdout)[0].message, 'visible');

  const text = capture('text', 'warn');
  text.logger.info('hidden');
  text.logger.warn('shown');
  assert.deepEqual(text.stdout, []);
  assert.deepEqual(text.stderr, ['shown']);
});

test('falls back to info for an invalid MARMOTTA_LOG value', () => {
  const stdout = [];
  const stderr = [];
  const logger = new Logger({ format: 'json', level: 'bogus', stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) });
  logger.info('visible');
  logger.debug('hidden');

  assert.match(stderr[0], /ignoring invalid MARMOTTA_LOG value/);
  assert.equal(records(stdout).length, 1);
});

test('MARMOTTA_LOG configures the default logger level', () => {
  // A file:// URL imports correctly on Windows, where "D:\..." is read as a URL scheme.
  const moduleUrl = new URL('../dist/logger.js', import.meta.url).href;
  const script = `import(${JSON.stringify(moduleUrl)}).then(({ logger }) => { logger.info('hidden'); logger.error('shown'); });`;
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, MARMOTTA_LOG: 'error' },
  });

  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'shown');
});
