<script lang="ts">
  import { tick } from 'svelte';
  import type { SavedDesign } from './lib/city-storage.ts';
  let { records, onrestore, onexport, ondelete, onrename }: {
    records: SavedDesign[];
    onrestore: (record: SavedDesign) => void;
    onexport: (record: SavedDesign) => void;
    ondelete: (record: SavedDesign) => boolean;
    onrename: (record: SavedDesign, name: string) => boolean;
  } = $props();
  let editing = $state<string | null>(null), name = $state(''), error = $state('');
  let input = $state<HTMLInputElement>();
  const formatter = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const date = (value: string) => Number.isFinite(Date.parse(value)) ? formatter.format(new Date(value)) : 'Date unavailable';
  async function rename(record: SavedDesign) { editing = record.id; name = record.name; error = ''; await tick(); input?.focus(); input?.select(); }
  function save(record: SavedDesign) {
    if (!name.trim()) { error = 'Enter a saved design name.'; return; }
    if (onrename(record, name)) { editing = null; error = ''; }
    else error = 'This name could not be saved. Local storage may be unavailable.';
  }
  function remove(record: SavedDesign) {
    if (ondelete(record)) error = '';
    else error = 'This design could not be deleted. You can export its settings to keep a copy.';
  }
</script>

{#if records.length}<details><summary>Saved designs</summary>
  {#each records as record (record.id)}<div class="saved">
    {#if editing === record.id}
      <form onsubmit={event => { event.preventDefault(); save(record); }}>
        <label for={`saved-name-${record.id}`}>Saved design name</label>
        <input id={`saved-name-${record.id}`} bind:this={input} bind:value={name} maxlength="256">
        <div class="actions"><button type="submit">Save name</button><button type="button" onclick={() => { editing = null; error = ''; }}>Cancel rename</button></div>
      </form>
    {:else}<button class="restore" onclick={() => onrestore(record)}>{record.name}</button>{/if}
    <small>Saved <time datetime={record.savedAt}>{date(record.savedAt)}</time></small>
    <button aria-label={`Export settings ${record.name}`} onclick={() => onexport(record)}>Export JSON</button>
    <button aria-label={`Rename design ${record.name}`} onclick={() => rename(record)}>Rename</button>
    <button aria-label={`Delete design ${record.name}`} onclick={() => remove(record)}>Delete</button>
  </div>{/each}
  {#if error}<p role="alert">{error}</p>{/if}
</details>{/if}

<style>
  details { margin-top: 18px; font-size: 12px; line-height: 1.6; }
  .saved { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .restore, form, small { flex: 1 1 100%; min-width: 0; overflow-wrap: anywhere; }
  small { color: #626d60; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 4px 0 6px; }
  input { width: 100%; border: 1px solid #bcc5b7; border-radius: 6px; padding: 10px; background: #fff; font-size: 16px; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  p { color: #8e2525; }
  @media (max-width: 750px) { button { min-height: 44px; } }
</style>
