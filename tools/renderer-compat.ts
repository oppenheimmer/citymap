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
      }
      return { code, map: null };
    },
  };
}
