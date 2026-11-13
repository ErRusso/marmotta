import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import { test } from 'node:test';
import { build, clean, configure } from '../dist/build.js';
import { loadProject } from '../dist/project.js';

const zigAvailable = spawnSync('zig', ['version'], { stdio: 'ignore' }).status === 0;

async function withProject(run) {
  const directory = await mkdtemp(join(tmpdir(), 'marmotta-test-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// A project under process.cwd() guarantees a relative path to it exists, on any drive layout.
// Needed for the relative-directory tests to actually exercise a relative path on Windows.
async function withProjectInCwd(run) {
  const directory = await mkdtemp(join(process.cwd(), '.marmotta-test-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Returns a path from process.cwd() to `directory`, failing the test if none exists (for example
// when the two are on different Windows drives), so the caller really exercises a relative path.
function relativeFromCwd(directory) {
  const relativePath = relative(process.cwd(), directory);
  assert.ok(!isAbsolute(relativePath), 'the project must be reachable through a relative path');
  return relativePath;
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

test('resolves discovered sources and paths from a relative project directory', async () => {
  await withProjectInCwd(async (directory) => {
    await mkdir(join(directory, 'src'));
    await mkdir(join(directory, 'include'));
    await writeFile(join(directory, 'src', 'addon.c'), '');
    await writeFile(join(directory, 'marmotta.config.json'), JSON.stringify({
      includeDirs: ['include'],
      outputDir: 'build',
    }));

    const relativeDirectory = relativeFromCwd(directory);
    const config = await loadProject(relativeDirectory);
    const projectDirectory = resolve(relativeDirectory);
    assert.deepEqual(config.sources, [join(projectDirectory, 'src', 'addon.c')]);
    assert.deepEqual(config.includeDirs, [join(projectDirectory, 'include')]);
    assert.equal(config.outputDir, join(projectDirectory, 'build'));
    for (const path of [...config.sources, ...config.includeDirs, config.outputDir]) {
      assert.ok(isAbsolute(path), `${path} should be absolute`);
    }
  });
});

test('builds and cleans a project given as a relative directory', { skip: !zigAvailable }, async () => {
  await withProjectInCwd(async (directory) => {
    await writeFile(join(directory, 'addon.c'), 'int marmotta_relative_build(void) { return 42; }\n');
    await writeFile(join(directory, 'marmotta.config.json'), JSON.stringify({
      name: 'relative-addon',
      outputDir: 'build',
    }));

    const relativeDirectory = relativeFromCwd(directory);
    const projectDirectory = resolve(relativeDirectory);
    const output = join(projectDirectory, 'build', 'relative-addon.node');
    await build({ directory: relativeDirectory });
    assert.equal((await stat(output)).isFile(), true);

    await clean({ directory: relativeDirectory });
    await assert.rejects(stat(output), (error) =>
      error instanceof Error && 'code' in error && error.code === 'ENOENT');
  });
});

test('cleans a relative project directory without needing Zig', async () => {
  await withProjectInCwd(async (directory) => {
    await writeFile(join(directory, 'marmotta.config.json'), JSON.stringify({
      name: 'relative-addon',
      outputDir: 'build',
    }));

    const relativeDirectory = relativeFromCwd(directory);
    const projectDirectory = resolve(relativeDirectory);
    const output = join(projectDirectory, 'build', 'relative-addon.node');
    await mkdir(join(projectDirectory, 'build'));
    await writeFile(output, 'stale addon');

    // clean() does not invoke Zig, so this keeps relative-directory coverage without conditional skip.
    await clean({ directory: relativeDirectory });
    assert.equal(existsSync(output), false);
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
      zigVersion: '0.14.1',
    }));

    const config = await loadProject(directory);
    assert.deepEqual(config.sources, [join(directory, 'addon.cpp')]);
    assert.deepEqual(config.includeDirs, [join(directory, 'include')]);
    assert.deepEqual(config.cxxFlags, ['-std=c++17']);
    assert.equal(config.outputDir, join(directory, 'build'));
    assert.equal(config.zigVersion, '0.14.1');
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
        zigVersion: '0.14.1',
      });
    `);

    const config = await loadProject(directory, { target: 'aarch64-macos' });
    assert.equal(config.name, 'cross-build');
    assert.deepEqual(config.sources, [join(directory, 'addon.c')]);
    assert.deepEqual(config.cFlags, [process.platform, process.arch]);
    assert.equal(config.zigVersion, '0.14.1');

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

    await writeFile(join(directory, 'marmotta.config.json'), JSON.stringify({ zigVersion: '0.14' }));
    await assert.rejects(loadProject(directory), (error) =>
      error instanceof Error && 'code' in error && error.code === 'PROJECT_CONFIG_INVALID');
  });
});

test('cleans the addon when the project has no sources', async () => {
  await withProject(async (directory) => {
    await writeFile(join(directory, 'marmotta.config.json'), JSON.stringify({ name: 'hello', outputDir: '.' }));
    const output = join(directory, 'hello.node');
    await writeFile(output, 'stale addon');

    const config = await loadProject(directory, { requireSources: false });
    assert.equal(config.name, 'hello');
    assert.equal(config.outputDir, directory);
    assert.deepEqual(config.sources, []);

    await clean({ directory });
    assert.equal(existsSync(output), false);
  });
});

test('cleans the addon when a configured source is missing', async () => {
  await withProject(async (directory) => {
    await writeFile(join(directory, 'marmotta.config.json'), JSON.stringify({
      name: 'hello',
      sources: ['src/gone.c'],
    }));
    const configuredOutput = join(directory, 'hello.node');
    const overriddenOutput = join(directory, 'build', 'hello.node');
    await writeFile(configuredOutput, 'stale addon');
    await mkdir(join(directory, 'build'));
    await writeFile(overriddenOutput, 'stale addon');

    await clean({ directory, outputDir: 'build' });
    assert.equal(existsSync(overriddenOutput), false);
    assert.equal(existsSync(configuredOutput), true);
  });
});

test('still rejects missing sources for build and configure', async () => {
  await withProject(async (directory) => {
    const configPath = join(directory, 'marmotta.config.json');
    await writeFile(configPath, JSON.stringify({ name: 'hello' }));
    for (const command of [build, configure]) {
      await assert.rejects(command({ directory }), (error) =>
        error instanceof Error && 'code' in error && error.code === 'PROJECT_SOURCES_NOT_FOUND');
    }

    await writeFile(configPath, JSON.stringify({ name: 'hello', sources: ['src/gone.c'] }));
    for (const command of [build, configure]) {
      await assert.rejects(command({ directory }), (error) =>
        error instanceof Error && 'code' in error && error.code === 'PROJECT_SOURCE_NOT_FOUND');
    }
  });
});