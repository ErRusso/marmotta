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

// Each sink call is one complete record: JSON records parse directly, without splitting on newlines.
function records(chunks) {
  return chunks.map((chunk) => JSON.parse(chunk));
}

test('writes one JSON record per call to the matching stream', () => {
  const { logger, stdout, stderr } = capture();

  logger.info('first record');
  logger.info('second record', { addon: 'hello.node' });
  logger.warn('cache miss');
  logger.error('compile failed', { code: 'TOOLCHAIN_COMMAND_FAILED' });

  assert.equal(stdout.length, 2);
  assert.equal(stderr.length, 2);
  for (const chunk of [...stdout, ...stderr]) assert.ok(!chunk.endsWith('\n'), JSON.stringify(chunk));

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

  logger.info('marmotta 0.7.0');
  logger.info('Commands:\n  build\n  clean');
  logger.warn('careful', { code: 'SOMETHING' });

  assert.deepEqual(stdout, ['marmotta 0.7.0', 'Commands:\n  build\n  clean']);
  assert.match(stderr[0], /^careful\n/);
  assert.match(stderr[0], /code: 'SOMETHING'/);
});

test('uses the same sink contract in both formats', () => {
  const lines = [];
  const sink = (line) => lines.push(line);

  new Logger({ format: 'json', stdout: sink }).info('json record');
  new Logger({ format: 'text', stdout: sink }).info('text record');

  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).message, 'json record');
  assert.equal(lines[1], 'text record');
  for (const line of lines) assert.ok(!line.endsWith('\n'), JSON.stringify(line));
});

test('never filters command output with the level', () => {
  const json = capture('json', 'error');
  json.logger.output('marmotta 0.7.0');
  json.logger.output('compiler error', { data: { command: 'zig', stream: 'stderr' }, level: 'warn' });
  json.logger.info('hidden');
  json.logger.debug('hidden');
  assert.deepEqual(records(json.stdout).map((record) => record.message), ['marmotta 0.7.0']);
  assert.deepEqual(records(json.stderr).map((record) => [record.level, record.message]), [['warn', 'compiler error']]);

  const text = capture('text', 'error');
  text.logger.output('marmotta 0.7.0');
  text.logger.info('hidden');
  assert.deepEqual(text.stdout, ['marmotta 0.7.0']);
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

test('routes warn and error records to stderr only', () => {
  const { logger, stdout, stderr } = capture('json', 'trace');
  logger.debug('debug record');
  logger.output('result');
  logger.warn('warning');
  logger.failure('failed', { code: 'SOMETHING' });

  assert.deepEqual(records(stdout).map((record) => record.level), ['debug', 'info']);
  assert.deepEqual(records(stderr).map((record) => record.level), ['warn', 'error']);
});

test('falls back to info for an invalid MARMOTTA_LOG value', () => {
  const { logger, stdout, stderr } = capture('json', 'bogus');
  logger.info('visible');
  logger.debug('hidden');
  assert.deepEqual(stderr, [], 'the warning is written only by checkLevel()');

  logger.checkLevel();
  logger.checkLevel();
  assert.equal(stderr.length, 1, 'the warning is written once');
  assert.equal(records(stderr)[0].level, 'warn');
  assert.match(records(stderr)[0].message, /ignoring invalid MARMOTTA_LOG value "bogus"/);
  assert.equal(records(stdout).length, 1);
});

test('rejects inherited property names as levels', () => {
  for (const level of ['constructor', '__proto__', 'toString']) {
    const { logger, stdout, stderr } = capture('json', level);
    logger.checkLevel();
    logger.info('visible');
    logger.debug('hidden');

    assert.match(stderr[0], /ignoring invalid MARMOTTA_LOG value/, level);
    assert.equal(records(stdout).length, 1, level);
  }
});

test('treats an empty level as unset', () => {
  const { logger, stdout, stderr } = capture('json', '');
  logger.checkLevel();
  logger.info('visible');
  logger.debug('hidden');

  assert.deepEqual(stderr, []);
  assert.equal(records(stdout).length, 1);
});

test('accepts silent as a level that hides every diagnostic but not command output', () => {
  for (const format of ['json', 'text']) {
    const { logger, stdout, stderr } = capture(format, 'silent');
    logger.checkLevel();
    logger.error('hidden');
    logger.output('result');

    assert.deepEqual(stderr, [], format);
    assert.equal(stdout.length, 1, format);
  }
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
