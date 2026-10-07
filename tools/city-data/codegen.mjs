import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const compile = require('pbf/compile');
const resolve = require('resolve-protobuf-schema');
const schema = fileURLToPath(new URL('../../src/proto/city.proto', import.meta.url));
const output = new URL('../../src/proto/city.js', import.meta.url);
// Emit native ESM so the same generated codec works in Node and browser workers.
const code = compile.raw(resolve.sync(schema)).replace(/^var (\w+) = exports\.\1 =/gm, 'export const $1 =');
if (code.includes('exports.')) throw new Error('Unexpected compiler export shape');

if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8') !== code) {
    throw new Error('city.js is stale. Run npm run data:codegen.');
  }
} else {
  await writeFile(output, code);
}
