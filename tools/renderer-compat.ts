import type { Plugin } from 'vite';

/** Compatibility fixes for the pinned w-gl 0.21 build; installed files stay untouched. */
export function rendererCompat(): Plugin {
  return {
    name: 'citymap-renderer-compat',
    transform(source, id) {
      if (!id.includes('/node_modules/w-gl/')) return;
      let code = source.replace(/ Please ping @\w+ so that we can add fallback/g, '');
      if (id.endsWith('/build/wgl.module.js')) {
        const immediate = /if \(immediate\) \{\s*return frame\(\);\s*\}/;
        if (!immediate.test(code)) throw new Error('Review renderer scheduling compatibility before changing w-gl.');
        // An immediate export draw must not leave a callback drawing a disposed scene.
        code = code.replace(immediate, 'if (immediate) { if (frameToken) { cancelAnimationFrame(frameToken); frameToken = 0; } return frame(); }');
      }
      return { code, map: null };
    },
  };
}
