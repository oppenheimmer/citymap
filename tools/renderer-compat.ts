import type { Plugin } from 'vite';

/** Compatibility fixes for the pinned w-gl 0.21 build; installed files stay untouched. */
export function rendererCompat(): Plugin {
  return {
    name: 'citymap-renderer-compat',
    transform(source, id) {
      id = id.split('?')[0];
      if (!id.includes('/node_modules/w-gl/')) return;
      let code = source.replace(/ Please ping @\w+ so that we can add fallback/g, '');
      if (id.endsWith('/build/wgl.module.js') || id.endsWith('/src/createScene.ts')) {
        const immediate = /if \(immediate\) \{\s*return frame\(\);\s*\}/;
        if (!immediate.test(code)) throw new Error('Review renderer scheduling compatibility before changing w-gl.');
        // An immediate export draw must not leave a callback drawing a disposed scene.
        code = code.replace(immediate, 'if (immediate) { if (frameToken) { cancelAnimationFrame(frameToken); frameToken = 0; } return frame(); }');
      }
      if (id.endsWith('/build/wgl.module.js') || id.endsWith('/src/lines/makeThickWireProgram.ts')) {
        // Uniform-color lines have no color attributes. Passing undefined to the
        // divisor API changes attribute zero and prevents resized PNG roads drawing.
        const divisors = /gle\.vertexAttribDivisorANGLE\(locations\.attributes\.a(?:From|To)Color, [01]\);/g;
        if (code.match(divisors)?.length !== 4) throw new Error('Review renderer thick-line compatibility before changing w-gl.');
        code = code.replace(divisors, statement => `if (allowColors) ${statement}`);
        const upload = /(gl\.bindBuffer\(gl\.ARRAY_BUFFER, lineBuffer\);\s*)gl\.bufferData\(gl\.ARRAY_BUFFER, data, gl\.DYNAMIC_DRAW\);/g;
        if (code.match(upload)?.length !== 1) throw new Error('Review renderer thick-line upload compatibility before changing w-gl.');
        // Progressive drawing must not upload every earlier batch again.
        code = code.replace(upload, '$1if (wireCollection.isDirtyBuffer) { gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW); wireCollection.isDirtyBuffer = false; }');
        const factory = code.indexOf('function makeThickWireProgram(');
        const allocation = 'lineBuffer = gl.createBuffer();';
        const allocatedAt = code.indexOf(allocation, factory) + allocation.length;
        if (factory < 0 || allocatedAt < allocation.length) throw new Error('Review renderer thick-line allocation compatibility before changing w-gl.');
        code = code.slice(0, allocatedAt) + '\nwireCollection.isDirtyBuffer = true;' + code.slice(allocatedAt);
      }
      if (id.endsWith('/build/wgl.module.js') || /\/src\/lines\/make(?:Thick)?WireProgram\.ts$/.test(id)) {
        // Upload only the view's bytes; batches can share a larger worker buffer.
        const data = /((?:let|var) data = )wireCollection\.buffer;/g;
        const expected = id.endsWith('/build/wgl.module.js') ? 2 : 1;
        if (code.match(data)?.length !== expected) throw new Error('Review renderer buffer-view compatibility before changing w-gl.');
        code = code.replace(data, '$1wireCollection.positions;');
      }
      return { code, map: null };
    },
  };
}
