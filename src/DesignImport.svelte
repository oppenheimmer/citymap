<script lang="ts">
  import type { ImportedDesign } from './lib/import-design.ts';
  let { generation, allowFixtures = false, onimport }: { generation: number; allowFixtures?: boolean; onimport: (value: ImportedDesign) => void } = $props();
  let picker: HTMLInputElement;
  let importing = $state(false), error = $state('');
  async function selected(event: Event) {
    const input = event.currentTarget as HTMLInputElement, file = input.files?.[0], run = generation;
    input.value = '';
    if (!file) return;
    importing = true; error = '';
    try {
      if (file.size > 64 * 1024) throw new Error('Design files must be 64 KB or smaller.');
      const { importDesign } = await import('./lib/import-design.ts');
      const value = importDesign(await file.text(), location.origin, location.pathname, allowFixtures);
      if (generation === run) onimport(value);
    } catch (cause) { if (generation === run) error = cause instanceof Error ? cause.message : 'This design file could not be read.'; }
    finally { importing = false; }
  }
</script>

<div class="design-import">
  <button disabled={importing} onclick={() => picker.click()}>{importing ? 'Reading design…' : 'Import design'}</button>
  <input bind:this={picker} type="file" accept=".citymap.json,.json,application/json" aria-label="Import design file" hidden onchange={selected}>
  <p>Restore a Citymap JSON file. Settings only; road data loads separately.</p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .design-import { margin-top: 18px; }
  p { color: #626d60; font-size: 13px; line-height: 1.5; }
  .error { color: #8e2525; }
  @media (max-width: 750px) { button { min-height: 44px; } }
</style>
