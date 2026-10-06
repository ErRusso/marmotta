import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { test } from 'node:test';
import { loadProject } from '../dist/project.js';

async function withProject(run) {
  const directory = await mkdtemp(join(tmpdir(), 'marmotta-test-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('discovers C and C++ sources and ignores generated directories', async () => {
  await withProject(async (directory) => {
    await mkdir(join(directory, 'src'));
    await mkdir(join(directory, 'node_modules', 'dependency'), { recursive: true });
    await mkdir(join(directory, 'build'));
    await writeFile(join(directory, 'src', 'addon.cc'), '');
    await writeFile(join(directory, 'hello.c'), '');
    await writeFile(join(directory, 'node_modules', 'dependency', 'ignored.c'), '');
    await writeFile(join(directory, 'build', 'ignored.cpp'), '');

    const config = await loadProject(directory);
    assert.deepEqual(config.sources.map((source) => basename(source)), ['hello.c', 'addon.cc']);
    assert.equal(config.outputDir, directory);
  });
});

test('loads explicit options and resolves relative paths', async () => {
  await withProject(async (directory) => {
    await writeFile(join(directory, 'addon.cpp'), '');
    await writeFile(join(directory, 'marmotta.config.json'), JSON.stringify({
      name: 'hello-addon',
      sources: ['addon.cpp'],
      includeDirs: ['include'],
      cxxFlags: ['-std=c++17'],
      outputDir: 'build',
    }));

    const config = await loadProject(directory);
    assert.deepEqual(config.sources, [join(directory, 'addon.cpp')]);
    assert.deepEqual(config.includeDirs, [join(directory, 'include')]);
    assert.deepEqual(config.cxxFlags, ['-std=c++17']);
    assert.equal(config.outputDir, join(directory, 'build'));
  });
});

test('prefers a JavaScript config and evaluates it with the build context', async () => {
  await withProject(async (directory) => {
    await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
    await writeFile(join(directory, 'addon.c'), '');
    await writeFile(join(directory, 'marmotta.config.json'), '{ invalid json');
    await writeFile(join(directory, 'marmotta.config.js'), `
      export default async ({ target, platform, arch }) => ({
        name: target ? 'cross-build' : 'host-build',
        sources: ['addon.c'],
        cFlags: [platform, arch],
      });
    `);

    const config = await loadProject(directory, { target: 'aarch64-macos' });
    assert.equal(config.name, 'cross-build');
    assert.deepEqual(config.sources, [join(directory, 'addon.c')]);
    assert.deepEqual(config.cFlags, [process.platform, process.arch]);

    await writeFile(join(directory, 'marmotta.config.js'), `
      export default {
        name: 'static-build',
        sources: ['addon.c'],
      };
    `);
    const staticConfig = await loadProject(directory);
    assert.equal(staticConfig.name, 'static-build');
  });
});

test('reloads a changed CommonJS JavaScript config', async () => {
  await withProject(async (directory) => {
    await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'commonjs' }));
    await writeFile(join(directory, 'addon.c'), '');
    const configPath = join(directory, 'marmotta.config.js');
    await writeFile(configPath, "module.exports = { name: 'first-build', sources: ['addon.c'] };\n");

    const firstConfig = await loadProject(directory);
    assert.equal(firstConfig.name, 'first-build');

    await writeFile(configPath, "module.exports = { name: 'updated-build', sources: ['addon.c'] };\n");
    const updatedConfig = await loadProject(directory);
    assert.equal(updatedConfig.name, 'updated-build');
  });
});

test('includes JavaScript configuration load causes in the error message', async () => {
  await withProject(async (directory) => {
    await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
    const configPath = join(directory, 'marmotta.config.js');

    await writeFile(configPath, 'export default {');
    await assert.rejects(loadProject(directory), (error) =>
      error instanceof Error
      && 'code' in error
      && error.code === 'PROJECT_CONFIG_LOAD_FAILED'
      && error.message.includes('Unexpected end')
      && error.cause instanceof SyntaxError);

    await writeFile(configPath, "throw new Error('config runtime failure');\n");
    await assert.rejects(loadProject(directory), (error) =>
      error instanceof Error
      && 'code' in error
      && error.code === 'PROJECT_CONFIG_LOAD_FAILED'
      && error.message.includes('config runtime failure')
      && error.cause instanceof Error
      && error.cause.message === 'config runtime failure');
  });
});

test('rejects configurations with wrong types and missing sources', async () => {
  await withProject(async (directory) => {
    await writeFile(join(directory, 'marmotta.config.json'), JSON.stringify({ sources: ['missing.c'] }));
    await assert.rejects(loadProject(directory), (error) =>
      error instanceof Error
      && 'code' in error
      && error.code === 'PROJECT_SOURCE_NOT_FOUND'
      && error.cause instanceof Error
      && 'code' in error.cause
      && error.cause.code === 'ENOENT');

    await writeFile(join(directory, 'marmotta.config.json'), JSON.stringify({ cFlags: '-Wall' }));
    await assert.rejects(loadProject(directory), (error) =>
      error instanceof Error && 'code' in error && error.code === 'PROJECT_CONFIG_INVALID');
  });
});