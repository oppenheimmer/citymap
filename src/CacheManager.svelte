<script lang="ts">
  import { clearCityCache } from './lib/city-storage.ts';
  import { clearCellCache } from './lib/live/cell-cache.ts';
  import { clearLocalMaps, cloudCities, listCityCache, listCellCache } from './lib/cache-manager.ts';
  import type { CloudObject } from './lib/cache-manager.ts';
  import type { LocalCacheEntry } from './lib/cache-generation.ts';
  import { formatBytes } from './lib/load-status.ts';
  import { responseJson } from './lib/data/response-body.ts';

  let dialog: HTMLDialogElement;
  let cities = $state.raw<LocalCacheEntry[] | undefined>([]), cells = $state.raw<LocalCacheEntry[] | undefined>([]);
  let objects = $state.raw<CloudObject[]>([]), cursor = $state<string>();
  let configured = $state(false), connected = $state(false), token = $state('');
  let busy = $state(false), message = $state(''), error = $state(''), filter = $state(''), shown = $state(50);
  const cloud = $derived(cloudCities(objects));
  const local = $derived([...(cities || []).map(entry => ({ ...entry, kind: 'city' as const })), ...(cells || []).map(entry => ({ ...entry, kind: 'cell' as const }))].filter(entry => `${entry.label} ${entry.detail || ''}`.toLowerCase().includes(filter.trim().toLowerCase())));
  let abort: AbortController | undefined;
  const date = (value: number | string) => Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString() : 'Date unavailable';
  async function api(query = '', body?: unknown) {
    const signal = AbortSignal.any([AbortSignal.timeout(query === '?status=1' ? 5000 : 25_000), ...(abort ? [abort.signal] : [])]);
    const response = await fetch(`/api/cache${query}`, { method: body ? 'POST' : 'GET', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal, cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
    const result = await responseJson(response, 2 * 1024 * 1024) as { error?: string; configured?: boolean; objects?: CloudObject[]; cursor?: string; remaining?: boolean; deleted?: number };
    if (!response.ok) throw new Error(result.error || 'R2 is unavailable.');
    return result;
  }
  async function refreshLocal() { [cities, cells] = await Promise.all([listCityCache(), listCellCache()]); }
  async function run(work: () => Promise<void>, refresh = true) {
    if (busy) return;
    busy = true; error = ''; message = ''; abort = new AbortController();
    try { await work(); } catch (e) { error = e instanceof Error ? e.message : 'The cache could not be changed. Retry to finish.'; }
    finally { if (refresh) await refreshLocal(); busy = false; }
  }
  function open() {
    filter = ''; shown = 50; dialog.showModal();
    void run(async () => {
      await Promise.all([refreshLocal(), (async () => {
        try { configured = !!(await api('?status=1')).configured; }
        catch { configured = false; }
      })()]);
    }, false);
  }
  async function cloudList(more = false) {
    const result = await api(more && cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
    if (!Array.isArray(result.objects)) throw new Error('R2 returned an invalid list.');
    objects = more ? [...objects, ...result.objects] : result.objects;
    cursor = result.cursor; connected = true;
  }
  async function removeCloud(city?: string) {
    let remaining = true, batches = 0;
    while (remaining) {
      const result = await api('', city ? { scope: 'city', city } : { scope: 'all' });
      remaining = !!result.remaining; batches++;
      message = `Clearing R2 maps… ${batches} batch${batches === 1 ? '' : 'es'} finished.`;
    }
    await cloudList();
  }
  function clearAll(cloudToo = false) {
    void run(async () => {
      const local = await clearLocalMaps(); message = local.message;
      if (cloudToo) {
        try { await removeCloud(); message = local.ok ? 'Local and R2 map caches cleared. Designs are preserved.' : `${local.message} R2 maps cleared.`; }
        catch (e) { message = local.message; throw e; }
      }
    });
  }
</script>

<button onclick={open}>Manage cached maps</button>
<dialog bind:this={dialog} aria-labelledby="cache-title" onkeydown={event => event.stopPropagation()} onclose={() => { abort?.abort(); token = ''; connected = false; objects = []; cursor = undefined; }}>
  <div class="heading"><h2 id="cache-title">Cached maps</h2><button aria-label="Close cached maps" onclick={() => dialog.close()}>Close</button></div>
  <p>Saved designs are preserved. Roads already on screen stay visible. Loading a map again can fill the cache again.</p>
  <fieldset disabled={busy}>
    <div class="actions"><button onclick={() => clearAll()}>Clear all local maps</button>{#if connected}<button class="danger" onclick={() => clearAll(true)}>Clear local and R2 maps</button>{/if}<button onclick={() => void run(async () => { await refreshLocal(); if (connected) await cloudList(); })}>Refresh cache list</button></div>
    <h3>This browser</h3>
    {#if cities === undefined || cells === undefined}<p class="warning">{cities === undefined && cells === undefined ? 'Local caches are unavailable.' : 'One local cache is unavailable. This list may be incomplete.'}</p>{/if}
    <p>{cities?.length ?? 'Unknown'} city datasets · {cells?.length ?? 'Unknown'} road fragments · {formatBytes([...(cities || []), ...(cells || [])].reduce((sum, entry) => sum + entry.bytes, 0))}</p>
    <label for="cache-filter">Filter cached maps</label><input id="cache-filter" type="search" bind:value={filter} oninput={() => shown = 50}>
    <p class="hint">Fragments can cover more than one city. Older entries may show an area ID instead of a city name. Remove deletes one stored record; overlapping records can still contain the same roads.</p>
    <ul aria-label="Local cached maps">
      {#each local.slice(0, shown) as entry (`${entry.kind}:${entry.key}`)}<li>
        <div><strong>{entry.label}</strong><small>{entry.kind === 'city' ? 'City dataset' : 'Road fragment'} · {formatBytes(entry.bytes)} · {date(entry.savedAt)}</small>{#if entry.detail}<small>{entry.detail}</small>{/if}</div>
        <button aria-label={`Remove local ${entry.label} ${entry.detail || entry.kind}`} onclick={() => void run(async () => { const ok = await (entry.kind === 'city' ? clearCityCache(entry.key) : clearCellCache(entry.key)); if (!ok) throw new Error('This local map could not be removed. Retry later.'); message = 'Local map removed. Designs are preserved.'; })}>Remove</button>
      </li>{/each}
    </ul>
    {#if !local.length}<p>No matching cached maps.</p>{/if}
    {#if local.length > shown}<button onclick={() => shown += 50}>Show more local maps</button>{/if}
    <h3>Shared R2 storage</h3>
    <p>R2 holds prepared city datasets. Live road fragments are stored in this browser. Removing an R2 city removes all its revisions and files for everyone.</p>
    {#if configured}
      {#if !connected}<form onsubmit={event => { event.preventDefault(); void run(() => cloudList()); }}><label for="cache-admin">Administrator key</label><input id="cache-admin" type="password" bind:value={token} autocomplete="off" spellcheck="false" maxlength="512" required><button type="submit">Connect to R2</button></form>
      {:else}<p>{cloud.length} cities in the loaded list{cursor ? ' · more files available' : ''}</p><ul aria-label="R2 cached cities">{#each cloud as entry (entry.key)}<li><div><strong>{entry.key}</strong><small>{entry.count} files · {formatBytes(entry.bytes)} · {date(entry.modified)}</small></div><button class="danger" aria-label={`Remove R2 ${entry.key}`} onclick={() => void run(async () => { await removeCloud(entry.key); message = 'City removed from R2. Local copies are unchanged.'; })}>Remove from R2</button></li>{/each}</ul>{#if cursor}<button onclick={() => void run(() => cloudList(true))}>Load more R2 files</button>{/if}<button class="danger" onclick={() => void run(async () => { await removeCloud(); message = 'R2 map cache cleared. Local copies are unchanged.'; })}>Clear all R2 maps</button>{/if}
    {:else}<p>R2 management is not configured. Set the server administrator key and dedicated R2 map credentials to enable it.</p>{/if}
    <p class="hint">Cloud deletion clears the R2 origin. Bundled Monaco files, CDN copies and caches on other devices may remain. R2 search data and road-service wait limits are preserved.</p>
  </fieldset>
  <p aria-live="polite">{busy ? message || 'Reading cache…' : message}</p>
  {#if error}<p role="alert" class="warning">{error}</p>{/if}
</dialog>

<style>
  dialog { border: 0; border-radius: 10px; padding: 22px; background: #f8faf6; color: #263124; width: min(720px, calc(100% - 24px)); max-height: 90dvh; overflow: auto; }
  dialog::backdrop { background: #20282080; }
  .heading, .actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  h2 { margin: 0; } h3 { margin-bottom: 8px; }
  p { font-size: 14px; line-height: 1.6; }
  fieldset { border: 0; padding: 0; min-width: 0; }
  label { display: block; font-size: 14px; margin-bottom: 6px; }
  input { padding: 10px; width: 100%; font-size: 16px; border: 1px solid #bcc5b7; border-radius: 6px; margin-bottom: 10px; }
  ul { padding: 0; list-style: none; }
  li { display: flex; gap: 10px; align-items: center; justify-content: space-between; padding: 12px 0; border-top: 1px solid #d7ded2; }
  li div { min-width: 0; overflow-wrap: anywhere; } small { display: block; margin-top: 5px; color: #52604c; }
  .hint { font-size: 12px; color: #52604c; } .warning { color: #8e2525; } .danger { color: #8e2525; }
  @media (max-width: 750px) { button { min-height: 44px; } li { flex-wrap: wrap; } }
</style>
