<script lang="ts">
  import { onMount } from 'svelte';
  import MapCanvas from './MapCanvas.svelte';
  import { bbox, boundaryFromNominatim, publicUrl } from './lib/domain.ts';
  import type { Boundary, Camera, Design, Geometry, LoadProgress, Providers, SourceInfo } from './lib/domain.ts';
  import type { SceneController } from './lib/SceneController.ts';
  import type { WorkerLoad } from './lib/worker-protocol.ts';
  import { request } from './lib/request.ts';
  import { parseUrl, shareUrl } from './lib/url-state.ts';
  import { clearCityCache, designs, recents, remember, removeDesign, saveDesign } from './lib/city-storage.ts';
  import type { SavedDesign } from './lib/city-storage.ts';

  const link = parseUrl(location.search);
  let query = $state(link.query);
  let results = $state.raw<Boundary[]>([]);
  let recent = $state.raw<Boundary[]>(recents());
  let saved = $state.raw<SavedDesign[]>(designs());
  let selected = $state.raw<Boundary | null>(link.boundary || null);
  let design = $state<Design>(link.design);
  let useCache = $state(link.cache);
  let status = $state('Search for a city or try a sample.');
  let error = $state(link.warning || '');
  let searching = $state(false), loading = $state(false), ready = $state(false), mounted = $state(false);
  let generation = $state(0);
  let source = $state.raw<SourceInfo | null>(null);
  let progress = $state.raw<LoadProgress | null>(null);
  let options = $state.raw<(WorkerLoad & { forceNetwork?: boolean }) | null>(null);
  let confirmation = $state<number | null>(null);
  let metrics = $state.raw<{ first: number; total: number; segments: number } | null>(null);
  let exporting = $state(false), exportWidth = $state(1280), exportHeight = $state(960), transparent = $state(false);
  let exportError = $state('');
  let shareText = $state(''), bboxText = $state('');
  let controller: SceneController | null = null;
  let exportDialog: HTMLDialogElement;
  let exportAbort: AbortController | undefined;
  let searchAbort: AbortController | undefined;
  let searchRun = 0;
  let historyTimer: ReturnType<typeof setTimeout> | undefined;
  let providers: Providers;
  // This request cache is not UI state and does not need reactive entries.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const searchCache = new Map<string, Boundary[]>();
  const presets = [
    { name: 'Paper', background: '#f7f2e8', roads: '#1a1a1a', labels: '#161616' },
    { name: 'Night', background: '#152737', roads: '#e1e7d9', labels: '#f8f2de' },
    { name: 'Moss', background: '#edf1e7', roads: '#356047', labels: '#244735' },
    { name: 'Plum', background: '#302a3b', roads: '#e4d8c7', labels: '#fbecd4' },
  ];

  function copy(): Design { return { ...design, label: { ...design.label }, camera: controller?.camera() || design.camera }; }
  function boundaryForShare(): Boundary {
    return { ...selected!, revision: source?.kind === 'r2' ? source.revision : selected?.revision, manifestSha256: source?.kind === 'r2' ? source.manifestSha256 : selected?.manifestSha256 };
  }
  function url() { return selected ? shareUrl(location.origin, location.pathname, boundaryForShare(), copy(), useCache) : ''; }
  function history() {
    clearTimeout(historyTimer);
    if (!ready || !selected) return;
    historyTimer = setTimeout(() => { window.history.replaceState(null, '', url()); }, 250);
  }
  $effect(() => { void [design.roadColor, design.roadOpacity, design.backgroundColor, design.backgroundOpacity, design.label.text, design.label.x, design.label.y, design.label.size, design.label.color, design.label.opacity]; history(); });
  function cancel() {
    generation++; mounted = false; loading = false; ready = false; controller = null;
    confirmation = null; progress = null; status = 'Load cancelled.';
  }
  function choose(boundary: Boundary, allowLarge = true, forceNetwork = false, restore?: Design) {
    generation++; mounted = false; ready = false; controller = null; source = null; metrics = null; error = ''; confirmation = null;
    selected = boundary; loading = true; status = `Loading ${boundary.name}…`;
    if (restore) design = { ...restore, label: { ...restore.label } };
    else { design.camera = undefined; design.label.text = boundary.name.split(',')[0].slice(0, 256); }
    bboxText = boundary.bbox?.join(',') || '';
    options = { boundary, providers, useCache, allowLarge, forceNetwork, fixtureUrl: boundary.fixture ? new URL(`${import.meta.env.BASE_URL}fixtures/${boundary.fixture}.json`, location.origin).href : undefined };
    mounted = true;
  }
  function sample(size: 'small' | 'medium' | 'large') { choose({ key: `fixture-${size}`, fixture: size, name: `${size[0].toUpperCase()}${size.slice(1)} synthetic grid`, kind: 'synthetic' }); }
  async function search() {
    if (!query.trim()) return;
    if (loading) cancel();
    searchAbort?.abort(); searchAbort = new AbortController();
    const signal = searchAbort.signal, run = ++searchRun, text = query.trim().slice(0, 256);
    searching = true; results = []; error = ''; status = `Searching for ${text}…`;
    try {
      const cached = searchCache.get(text.toLowerCase());
      let places = cached;
      if (!places) {
        const endpoint = new URL(providers.search, location.origin);
        endpoint.searchParams.set('q', text); endpoint.searchParams.set('format', 'json'); endpoint.searchParams.set('limit', '8');
        const response = await request(endpoint.href, { signal }, 25_000);
        const data: unknown = await response.json();
        if (!Array.isArray(data)) throw new Error('Search returned an invalid response. Check the configured provider.');
        places = data.flatMap(row => { try { return [boundaryFromNominatim(row)]; } catch { return []; } });
        searchCache.set(text.toLowerCase(), places);
      }
      if (run !== searchRun || signal.aborted) return;
      results = places;
      status = places.length ? `Choose from ${places.length} matching places.` : 'No usable city boundaries found. Try a city and country name.';
    } catch (e) { if (run === searchRun && !signal.aborted) { error = e instanceof Error ? e.message : 'Search unavailable.'; status = 'Search could not be completed.'; } }
    finally { if (run === searchRun) searching = false; }
  }
  function editQuery() { searchAbort?.abort(); searchRun++; searching = false; }
  function loaded(scene: SceneController, geometry: Geometry, first: number, total: number, id: number) {
    if (id !== generation) return;
    controller = scene; ready = true; loading = false; source = geometry.source; confirmation = null;
    metrics = { first, total, segments: geometry.segmentCount };
    status = `${selected!.name} ready.`;
    remember(selected!); recent = recents(); history();
  }
  function failed(message: string, id: number) { if (id !== generation) return; mounted = false; loading = false; ready = false; controller = null; error = message; status = 'Map could not be loaded.'; }
  function large(bytes: number, id: number) { if (id !== generation) return; mounted = false; loading = false; confirmation = bytes; status = 'Confirm this download to continue.'; }
  function camera(camera: Camera, id: number) { if (id === generation) { design.camera = camera; history(); } }
  function applyPreset(preset: typeof presets[number]) { design.roadColor = preset.roads; design.backgroundColor = preset.background; design.label.color = preset.labels; }
  function boxLoad() {
    try {
      if (bboxText.split(',').some(value => !value.trim())) throw new Error('Enter south, west, north and east coordinates.');
      const box = bbox(bboxText.split(',').map(Number));
      choose({ key: `bbox-${box.join(',')}`, name: selected?.name || 'Custom area', kind: 'bounding box', bbox: box });
    } catch (e) { error = e instanceof Error ? e.message : 'Invalid bounding box'; }
  }
  function openExport() {
    if (!controller) return;
    exportWidth = Math.max(256, controller.canvas.width); exportHeight = Math.max(256, controller.canvas.height);
    exportError = ''; exportDialog.showModal();
  }
  async function exportFile(format: 'png' | 'svg') {
    if (!controller || exporting || !source?.complete) return;
    const snapshot = controller.snapshot();
    exporting = true; exportError = ''; exportAbort = new AbortController();
    try {
      await new Promise(requestAnimationFrame);
      const { exportMap, download } = await import('./lib/exports.ts');
      const blob = await exportMap(snapshot, { width: exportWidth, height: exportHeight, transparent }, format, exportAbort.signal);
      exportAbort.signal.throwIfAborted();
      download(blob, `${snapshot.design.label.text || selected!.name}.${format}`);
      status = `${format.toUpperCase()} exported.`;
    } catch (e) { if (!exportAbort?.signal.aborted) exportError = e instanceof Error ? e.message : 'Export failed'; }
    finally { exporting = false; }
  }
  async function share() {
    shareText = url();
    try { await navigator.clipboard.writeText(shareText); status = 'Design link copied.'; }
    catch { status = 'Select the link below to copy it.'; }
  }
  function save() {
    if (!selected) return;
    if (saveDesign(boundaryForShare(), copy())) { saved = designs(); status = 'Design saved in this browser.'; }
    else status = 'Local storage is unavailable. Use a share link to keep this design.';
  }
  function restore(record: SavedDesign) {
    try { const parsed = parseUrl(new URL(shareUrl(location.origin, location.pathname, record.boundary, record.design)).search); if (!parsed.boundary || parsed.warning) throw new Error('Invalid saved design'); choose(parsed.boundary, true, false, parsed.design); }
    catch { error = 'This saved design could not be restored. You can remove it and create a new one.'; }
  }
  async function clear() { status = await clearCityCache() ? 'Saved city geometry cleared. Designs are preserved.' : 'Local cache is unavailable in this browser.'; }
  function date(value?: string) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'unavailable'; }

  onMount(() => {
    try {
      providers = { cityDataBase: publicUrl(import.meta.env.VITE_CITY_DATA_BASE_URL || ''), legacyCacheBase: publicUrl(import.meta.env.VITE_AREA_SERVER || ''), overpass: publicUrl(import.meta.env.VITE_OVERPASS_URL || '', 'https://overpass-api.de/api/interpreter'), search: publicUrl(import.meta.env.VITE_SEARCH_URL || '', new URL('/api/search', location.origin).href) };
      if (link.boundary) {
        if (link.auto && !link.warning) choose(link.boundary, false, false, link.design);
        else { status = 'This link selects a city. Load its roads to continue.'; bboxText = link.boundary.bbox?.join(',') || ''; }
      }
    } catch (e) { error = e instanceof Error ? e.message : 'Invalid provider configuration'; }
    return () => { searchAbort?.abort(); exportAbort?.abort(); clearTimeout(historyTimer); };
  });
</script>

<svelte:window onkeydown={event => { if (event.key === 'Escape' && loading) cancel(); }} />
<main class="layout">
  <aside>
    <header><p class="eyebrow">CITYMAP</p><h1>Make a map.</h1><p>Your city, drawn in roads.</p></header>
    <form onsubmit={event => { event.preventDefault(); void search(); }}>
      <label for="search">Find a city</label><div class="search-row"><input id="search" type="search" bind:value={query} oninput={editQuery} placeholder="Tokyo, Japan" autocomplete="off" maxlength="256"><button type="submit" disabled={searching || !query.trim()}>Search</button></div>
      <div class="results">{#each results as city (city.key)}<button type="button" onclick={() => choose(city)}>{city.name}<small>{city.kind}{city.osmType ? ` · ${city.osmType}` : ''}</small></button>{/each}</div>
    </form>
    <details class="samples"><summary>Try a sample map</summary><div class="buttons"><button onclick={() => sample('small')}>Small sample</button>{#if import.meta.env.VITE_TEST_FIXTURES === '1'}<button onclick={() => sample('medium')}>Medium sample</button><button onclick={() => sample('large')}>Large sample</button>{/if}</div><p class="hint">Synthetic geometry for testing; no provider requests.</p></details>
    <p role="status" aria-live="polite">{status}</p>
    {#if loading}<p class="hint">{progress?.message}{#if progress?.totalChunks} {progress.completedChunks || 0}/{progress.totalChunks} chunks{/if}</p><button onclick={cancel}>Cancel load</button>{/if}
    {#if error}<div role="alert" class="error">{error}{#if selected}<button onclick={() => choose(selected!, true, false, copy())}>Retry map</button>{/if}</div>{/if}
    {#if confirmation !== null}<div class="notice">{confirmation ? `This map needs about ${(confirmation / 1048576).toFixed(1)} MiB of cached data.` : 'Live downloads can be large. Load this map when you are ready.'}<button onclick={() => choose(selected!, true, false, copy())}>Load roads</button></div>{:else if selected && !mounted && !loading}<button onclick={() => choose(selected!, true, false, copy())}>Load roads</button>{/if}
    {#if selected}
      <fieldset disabled={!ready}><legend>Map controls</legend><div class="buttons"><button onclick={() => controller?.zoom(1.25)} aria-label="Zoom in">+</button><button onclick={() => controller?.zoom(0.8)} aria-label="Zoom out">−</button><button onclick={() => controller?.fit()}>Fit map</button><button onclick={openExport}>Export</button></div></fieldset>
      <details open><summary>Customize</summary>
        <fieldset><legend>Presets</legend><div class="buttons">{#each presets as preset (preset.name)}<button onclick={() => applyPreset(preset)}>{preset.name}</button>{/each}</div></fieldset>
        <fieldset><legend>Colors</legend><label>Road color <input type="color" bind:value={design.roadColor}></label><label for="road-opacity">Road opacity</label><input id="road-opacity" type="range" min="0" max="1" step="0.05" bind:value={design.roadOpacity}><label>Background color <input type="color" bind:value={design.backgroundColor}></label><label for="background-opacity">Background opacity</label><input id="background-opacity" type="range" min="0" max="1" step="0.05" bind:value={design.backgroundOpacity}></fieldset>
        <fieldset><legend>Label</legend><label for="label">Label text</label><input id="label" bind:value={design.label.text} maxlength="256"><label>Label color <input type="color" bind:value={design.label.color}></label><label for="label-opacity">Label opacity</label><input id="label-opacity" type="range" min="0" max="1" step="0.05" bind:value={design.label.opacity}><label for="size">Label size</label><input id="size" type="range" min="10" max="128" bind:value={design.label.size}><p class="hint">Drag the map label or focus it and use arrow keys.</p></fieldset>
      </details>
      <fieldset disabled={!ready}><legend>Keep this design</legend><div class="buttons"><button onclick={share}>Copy share link</button><button onclick={save}>Save design</button></div>{#if shareText}<label for="share">Share link</label><input id="share" readonly value={shareText} onclick={event => event.currentTarget.select()}>{/if}</fieldset>
      <details><summary>Data and source</summary><label class="checkbox"><input type="checkbox" bind:checked={useCache}> Use cached city data</label><button disabled={loading} onclick={() => choose(selected!, true, true, copy())}>Refresh city data</button><button onclick={clear}>Clear city cache</button>
        {#if source}<p>{source.local ? 'Local cache' : ({ r2: 'R2 cache', legacy: 'Legacy cache', live: 'Live OpenStreetMap data', fixture: 'Synthetic sample' }[source.kind])}<br>Source date: {date(source.snapshotAt)}<br>Downloaded: {date(source.downloadedAt)}</p>{/if}
        <label for="bbox">Bounding box: south, west, north, east</label><input id="bbox" bind:value={bboxText} placeholder="35.6,139.6,35.8,139.8"><button onclick={boxLoad}>Load bounding box</button>
      </details>
      {#if metrics}<details><summary>Load timings</summary><p>{metrics.segments.toLocaleString()} segments · first road frame {metrics.first.toFixed(1)} ms · complete {metrics.total.toFixed(1)} ms</p></details>{/if}
    {/if}
    {#if recent.length}<details><summary>Recent cities</summary><div class="results">{#each recent as city (city.key)}<button onclick={() => choose(city)}>{city.name}</button>{/each}</div></details>{/if}
    {#if saved.length}<details><summary>Saved designs</summary>{#each saved as record (record.id)}<div class="saved"><button onclick={() => restore(record)}>{record.name}</button><button aria-label={`Delete design ${record.name}`} onclick={() => { removeDesign(record.id); saved = designs(); }}>Delete</button></div>{/each}</details>{/if}
    <footer>Map data <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors, ODbL</a>.</footer>
  </aside>
  <section class="map-panel" aria-label="Map preview">
    {#if mounted && options}{#key generation}<MapCanvas runId={generation} {options} {design} onlabel={label => { design.label = label; }} oncamera={camera} onerror={failed} onlarge={large} onprogress={(value, id) => { if (id === generation) progress = value; }} onready={loaded} />{/key}
    {:else}<div class="empty"><h2>A city, in lines.</h2><p>{loading ? 'Preparing your map…' : 'Find a city, choose its roads, and make it yours.'}</p></div>{/if}
  </section>
</main>
<dialog bind:this={exportDialog} class="export-dialog" aria-labelledby="export-title" onclose={() => { exportAbort?.abort(); }}><h2 id="export-title">Export your map</h2><p>The current camera and design are preserved.</p><label for="export-width">Width in pixels</label><input id="export-width" type="number" min="256" max="8192" bind:value={exportWidth}><label for="export-height">Height in pixels</label><input id="export-height" type="number" min="256" max="8192" bind:value={exportHeight}><label class="checkbox"><input type="checkbox" bind:checked={transparent}> Transparent background</label><p class="hint">Up to 16 megapixels. Attribution stays visible.</p><div class="buttons"><button disabled={exporting} onclick={() => exportFile('png')}>Download PNG</button><button disabled={exporting} onclick={() => exportFile('svg')}>Download SVG</button><button onclick={() => { exportAbort?.abort(); exportDialog.close(); }}>{exporting ? 'Cancel export' : 'Close'}</button></div>{#if exporting}<p role="status">Preparing export…</p>{/if}{#if exportError}<p role="alert">{exportError}</p>{/if}</dialog>
