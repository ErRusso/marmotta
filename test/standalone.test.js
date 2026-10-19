import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { isStandalone, readEmbeddedAsset } from '../dist/standalone.js';
import { resolveNodeApiHeaders } from '../dist/node-api-headers.js';
import { marmottaHome } from '../dist/toolchain.js';

test('plain Node.js is not a standalone build', () => {
  assert.equal(isStandalone(), false);
});

test('no asset is embedded outside a standalone build', async () => {
  assert.equal(await readEmbeddedAsset('node-api-headers.tar'), undefined);
});

test('resolves the Node-API headers from node_modules', async () => {
  // Under npm the headers come from the node-api-headers dependency; the same paths are handed to
  // Zig as the include directory and to the Windows host-binding generation as the .def file.
  const headers = await resolveNodeApiHeaders(marmottaHome());
  await access(join(headers.includeDir, 'node_api.h'));
  await access(headers.nodeApiDefPath);
});

test('resolves the headers once per process', async () => {
  const home = marmottaHome();
  const [first, second] = await Promise.all([resolveNodeApiHeaders(home), resolveNodeApiHeaders(home)]);
  assert.equal(first, second);
});
