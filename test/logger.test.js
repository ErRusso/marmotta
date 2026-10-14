import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Logger } from '../dist/logger.js';

function capture(format = 'json') {
  const stdout = [];
  const stderr = [];
  return {
    logger: new Logger({
      debug: true,
      format,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    }),
    stdout,
    stderr,
  };
}

test('writes structured JSON lines without prefixing the payload', () => {
  const { logger, stdout, stderr } = capture();

  logger.info('build complete', { addon: 'hello.node', target: 'x64-linux' });
  logger.warn('cache miss');
  logger.error('compile failed', { code: 'TOOLCHAIN_COMMAND_FAILED' });

  assert.deepEqual(JSON.parse(stdout[0]), {
    level: 'info',
    message: 'build complete',
    data: { addon: 'hello.node', target: 'x64-linux' },
  });
  assert.equal(stderr[0], JSON.stringify({ level: 'warn', message: 'cache miss' }));
  assert.deepEqual(JSON.parse(stderr[1]), {
    level: 'error',
    message: 'compile failed',
    data: { code: 'TOOLCHAIN_COMMAND_FAILED' },
  });
});

test('keeps text output readable and keeps debug data attached to debug logs', () => {
  const { logger, stdout, stderr } = capture('text');

  logger.info('ready');
  logger.debug('compiler path', '/opt/zig/zig');

  assert.equal(stdout[0], '[INFO] ready');
  assert.match(stdout[1], /^\[DEBUG\] compiler path\n/);
  assert.match(stdout[1], /"\/opt\/zig\/zig"/);
  assert.equal(stderr.length, 0);
});

test('keeps JSON records valid when context is circular', () => {
  const stdout = [];
  const logger = new Logger({ format: 'json', stdout: (line) => stdout.push(line) });
  const context = {};
  context.self = context;

  logger.info('context', context);
  assert.equal(JSON.parse(stdout[0]).data, '[object Object]');
});

test('debug mode defaults to disabled', () => {
  const stdout = [];
  const logger = new Logger({ format: 'json', stdout: (line) => stdout.push(line) });

  logger.debug('hidden');
  assert.equal(stdout.length, 0);

  logger.setDebugMode(true);
  logger.debug('visible');
  assert.equal(JSON.parse(stdout[0]).message, 'visible');
});
