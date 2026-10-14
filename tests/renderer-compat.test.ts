import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { rendererCompat } from '../tools/renderer-compat.ts';

async function transform(file: string, query = '') {
  const source = await readFile(new URL(`../node_modules/w-gl/${file}`, import.meta.url), 'utf8');
  const hook = rendererCompat().transform;
  assert.equal(typeof hook, 'function');
  return Reflect.apply(hook as (...args: unknown[]) => unknown, {}, [source, `/node_modules/w-gl/${file}${query}`]) as { code: string };
}

for (const file of ['build/wgl.module.js', 'src/createScene.ts']) test(`${file} cancels pending frames for Vite dev URLs and production`, async () => {
  for (const query of ['', '?v=local-test']) {
    const { code } = await transform(file, query);
    const start = code.indexOf('function renderFrame(immediate'), end = code.indexOf('function frame()', start);
    assert.ok(start > 0 && end > start);
    const pending = new Map<number, () => void>();
    let draws = 0;
    // Run the installed renderer's scheduling routine with controlled RAF calls.
    const render = new Function('requestAnimationFrame', 'cancelAnimationFrame', 'frame',
      `let frameToken = 0; ${code.slice(start, end)} return renderFrame;`)(
      (callback: () => void) => { pending.set(17, callback); return 17; },
      (token: number) => pending.delete(token), () => { draws++; },
    ) as (immediate?: boolean) => void;
    render(); assert.equal(pending.size, 1);
    render(true); assert.equal(draws, 1); assert.equal(pending.size, 0);
  }
});
for (const file of ['build/wgl.module.js', 'src/lines/makeThickWireProgram.ts']) test(`${file} never changes nonexistent uniform-color attribute divisors`, async () => {
  const { code } = await transform(file, '?v=local-test');
  const start = code.indexOf('gle.vertexAttribDivisorANGLE(locations.attributes.aPosition, 0);', code.indexOf('function makeThickWireProgram('));
  const last = 'gle.vertexAttribDivisorANGLE(locations.attributes.aToColor, 0);';
  const end = code.indexOf(last, start) + last.length;
  assert.ok(start > 0 && end > start);
  const draw = new Function('allowColors', 'gle', 'locations', 'gl', 'wireCollection', code.slice(start, end));
  for (const allowColors of [false, true]) {
    const divisors: [number, number][] = [];
    let drawn = false;
    draw(allowColors, {
      vertexAttribDivisorANGLE: (attribute: number, divisor: number) => {
        assert.ok(Number.isInteger(attribute), 'Only allocated attributes can have divisors');
        divisors.push([attribute, divisor]);
      },
      drawArraysInstancedANGLE: () => { drawn = true; },
    }, { attributes: { aPosition: 0, aFrom: 1, aTo: 2, ...(allowColors ? { aFromColor: 3, aToColor: 4 } : {}) } }, { TRIANGLES: 4 }, { count: 1 });
    assert.equal(drawn, true);
    assert.deepEqual(divisors.filter(([attribute]) => attribute === 0), [[0, 0]]);
    assert.equal(divisors.length, allowColors ? 9 : 5);
  }
});

for (const [file, factory] of [
  ['build/wgl.module.js', 'makeWireProgram'],
  ['build/wgl.module.js', 'makeThickWireProgram'],
  ['src/lines/makeWireProgram.ts', 'makeWireProgram'],
  ['src/lines/makeThickWireProgram.ts', 'makeThickWireProgram'],
]) test(`${file} ${factory} uploads exact view bytes only when changed`, async () => {
  const { code } = await transform(file, '?v=local-test');
  const factoryStart = code.indexOf(`function ${factory}(`);
  const dataStart = code.indexOf('data = wireCollection.positions;', factoryStart);
  const declaration = code.lastIndexOf('\n', dataStart) + 1;
  const last = 'wireCollection.isDirtyBuffer = false;';
  const end = code.indexOf(last, dataStart) + last.length;
  assert.ok(factoryStart >= 0 && dataStart > factoryStart && end > dataStart);
  // Execute the installed upload routine with a view surrounded by unrelated bytes.
  const upload = new Function('gl', 'wireCollection', 'drawContext', 'locations', 'lineProgram', 'lineBuffer', 'positionBuffer', 'quadPositions',
    code.slice(declaration, end) + '}');
  const backing = new Float32Array([99, 99, -1, 0, 1, 0, 88, 88]);
  const positions = backing.subarray(2, 6), quadPositions = new Float32Array(12);
  const collection = { positions, buffer: backing.buffer, color: {}, isDirtyBuffer: true };
  const received: number[][] = [];
  const gl = new Proxy({ bufferData: (_target: unknown, data: Float32Array) => {
    if (data === quadPositions) return;
    assert.equal(data.byteLength, 16);
    received.push([...data]);
  } }, { get: (target, key) => Reflect.get(target, key) || (() => {}) });
  const draw = () => upload(gl, collection, { view: {} }, { uniforms: {}, attributes: {} }, {}, {}, {}, quadPositions);
  draw(); draw();
  assert.deepEqual(received, [[-1, 0, 1, 0]]);
  collection.isDirtyBuffer = true; draw();
  assert.deepEqual(received, [[-1, 0, 1, 0], [-1, 0, 1, 0]]);
});

test('build/wgl.module.js wire programs release only their own buffers, keeping the shared shader program', async () => {
  const { code } = await transform('build/wgl.module.js', '?v=local-test');
  for (const [factory, end, buffers] of [['makeWireProgram', 'function getShadersCode$1(', 1], ['makeThickWireProgram', 'function getShadersCode$2(', 2]] as const) {
    const start = code.indexOf(`function ${factory}(`), stop = code.indexOf(end, start);
    assert.ok(start > 0 && stop > start);
    const cache = { get: () => undefined, set: () => {}, remove: () => {} };
    const glUtils = { compile: () => ({}), link: () => ({ program: true }), getLocations: () => ({ attributes: {}, uniforms: {} }) };
    const make = new Function('lineProgramCache', 'lineProgramCache$1', 'getShadersCode$1', 'getShadersCode$2', 'glUtils', `${code.slice(start, stop)} return ${factory};`)(cache, cache, () => ({}), () => ({}), glUtils);
    const deleted: unknown[] = [], programs: unknown[] = [];
    let created = 0;
    const gl = new Proxy({ createBuffer: () => ({ buffer: ++created }), deleteBuffer: (buffer: unknown) => deleted.push(buffer), deleteProgram: (program: unknown) => programs.push(program), getExtension: () => ({}) }, { get: (target, key) => Reflect.get(target, key) || (() => {}) });
    const program = make(gl, { allowColors: false, is3D: false, width: 2 });
    program.release();
    assert.deepEqual(deleted, Array.from({ length: buffers }, (_, i) => ({ buffer: i + 1 })));
    assert.deepEqual(programs, [], 'The shared shader program stays usable by other collections');
  }
});
for (const file of ['src/lines/makeWireProgram.ts', 'src/lines/makeThickWireProgram.ts']) test(`${file} exposes a buffer-only release`, async () => {
  const { code } = await transform(file, '?v=local-test');
  assert.match(code, /var api = \{ release: releaseBuffers,/);
  assert.match(code, /function releaseBuffers\(\) \{ gl\.deleteBuffer\(lineBuffer\);/);
});
