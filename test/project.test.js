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

test('scopre sorgenti C e C++ e ignora cartelle generate', async () => {
  await withProject(async (directory) => {
    await mkdir(join(directory, 'src'));
    await mkdir(join(directory, 'node_modules', 'dependency'), { recursive: true });
    await mkdir(join(directory, 'build'));
    await writeFile(join(directory, 'src', 'addon.cc'), '');
    await writeFile(join(directory, 'hello.c'), '');
    await writeFile(join(directory, 'node_modules', 'dependency', 'ignored.c'), '');
    await writeFile(join(directory, 'build', 'ignored.cpp'), '');

    const config = await loadProject(directory);
    assert.deepEqual(config.sources.map((source) => source.split('/').at(-1)), ['hello.c', 'addon.cc']);
    assert.equal(config.output, join(directory, `${basename(directory)}.node`));
  });
});

test('carica le opzioni esplicite e risolve i percorsi relativi', async () => {
  await withProject(async (directory) => {
    await writeFile(join(directory, 'addon.cpp'), '');
    await writeFile(join(directory, 'marmotta.config.json'), JSON.stringify({
      name: 'hello-addon',
      sources: ['addon.cpp'],
      includeDirs: ['include'],
      cxxFlags: ['-std=c++17'],
      output: 'build/hello.node',
    }));

    const config = await loadProject(directory);
    assert.deepEqual(config.sources, [join(directory, 'addon.cpp')]);
    assert.deepEqual(config.includeDirs, [join(directory, 'include')]);
    assert.deepEqual(config.cxxFlags, ['-std=c++17']);
    assert.equal(config.output, join(directory, 'build', 'hello.node'));
  });
});

test('rifiuta configurazioni con tipi errati e sorgenti mancanti', async () => {
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