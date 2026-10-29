<script lang="ts">
  import { onMount, tick } from 'svelte';
  import DesignImport from './DesignImport.svelte';
  import SavedDesigns from './SavedDesigns.svelte';
  import { BUNDLED_MAPS } from './lib/bundled-maps.ts';
  import MapCanvas from './MapCanvas.svelte';
  import { bbox, boundaryFromNominatim, covers, hasLocation, publicUrl } from './lib/domain.ts';
  import type { Boundary, Design, GeoView, Geometry, LoadProgress, MarkPosition, PreparationTimings, Providers, RoadDetail, SourceInfo } from './lib/domain.ts';
  import type { SceneController } from './lib/SceneController.ts';
  import type { WorkerLoad } from './lib/worker-protocol.ts';
  import { request } from './lib/request.ts';
  import { parseUrl, shareUrl } from './lib/url-state.ts';
  import { responseJson } from './lib/data/response-body.ts';
  import { clearCityCache, designs, removeDesign, renameDesign, saveDesign, updateDesign } from './lib/city-storage.ts';
  import type { SavedDesign } from './lib/city-storage.ts';
  import { designFile } from './lib/design-file.ts';
  import { download } from './lib/download.ts';
  import { describeLoad, formatBytes } from './lib/load-status.ts';
  import type { Transfer } from './lib/load-status.ts';
  import type { GridMode } from './lib/graticule.ts';
  import type { LiveCoverage, LiveSettings, LiveViewport } from './lib/live/viewport.ts';
  import type { FailureCode } from './lib/live/overpass.ts';
  import { isPublicOverpass } from './lib/live/overpass.ts';
  import { clearCellCache } from './lib/live/cell-cache.ts';
  import { failureLabel } from './lib/live/report.ts';
  import { backupProvider } from './lib/live/providers.ts';
  import { fitCamera } from './lib/view.ts';
  import { edgeRange, linkedSize } from './lib/export-size.ts';

  // Synthetic sample maps exist only in test builds, for deterministic browser tests.
  const SAMPLES = import.meta.env.VITE_TEST_FIXTURES === '1';
  // Live roads load by map view unless explicitly disabled for rollback.
  // Test builds may choose either mode per page, so both stay covered.
  const testing = new URLSearchParams(SAMPLES ? location.search : '');
  const LIVE_VIEWPORT = testing.has('liveMode') ? testing.get('liveMode') === 'viewport' : import.meta.env.VITE_LIVE_VIEWPORT !== '0';
  // Test builds can shrink the live geometry budget to exercise eviction with small fixtures.
  const LIVE_BUDGET = Number(testing.get('liveBudget')) || undefined;
  const link = parseUrl(location.search);
  const linked = link.boundary?.fixture && !SAMPLES ? undefined : link.boundary;
  let query = $state(link.query);
  let results = $state.raw<Boundary[]>([]);
  let saved = $state.raw<SavedDesign[]>(designs());
  let savedId = $state<string | null>(null);
  let selected = $state.raw<Boundary | null>(linked || null);
  let design = $state<Design>(link.design);
  let useCache = $state(link.cache);
  let status = $state('Search for a city to start.');
  let error = $state(link.warning || '');
  let searching = $state(false), loading = $state(false), ready = $state(false), mounted = $state(false);
  let generation = $state(0);
  let source = $state.raw<SourceInfo | null>(null);
  // The most detailed road level the current map's geometry contains.
  let coverage = $state<RoadDetail | null>(null);
  let progress = $state.raw<LoadProgress | null>(null);
  let transfer = $state.raw<Transfer | null>(null);
  let startedAt = $state(0), lastActivityAt = $state(0), clock = $state(0);
  const activity = $derived(describeLoad(progress, transfer, startedAt, lastActivityAt, clock));
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  const turn = (degrees: number) => degrees ? `${Math.abs(degrees)} degrees ${degrees < 0 ? 'counter-clockwise' : 'clockwise'}` : 'not rotated';
  // The slider sets how far the map turns, from 0°; the direction is chosen separately.
  // The design keeps one signed angle: negative turns left (counter-clockwise).
  let turnLeft = $state((link.design.rotation || 0) < 0);
  $effect(() => { const degrees = design.rotation || 0; if (degrees) turnLeft = degrees < 0; });
  function rotate(degrees: number, left = turnLeft) { turnLeft = left; design.rotation = degrees && (left ? -degrees : degrees); }
  let options = $state.raw<(WorkerLoad & { forceNetwork?: boolean }) | null>(null);
  // Live viewport maps: the loader, its settings and the loading state of the visible map.
  let live: LiveViewport | null = null;
  let liveSettings = $state.raw<(Omit<LiveSettings, 'cache'> & { useCache: boolean }) | undefined>(undefined);
  let liveCoverage = $state.raw<LiveCoverage | null>(null);
  // When a provider cooldown ends, on the performance clock, for a countdown that ticks between coverage updates.
  let resumeAt = $state(0), waitClock = $state(0);
  const waitSeconds = $derived(Math.max(0, Math.ceil((resumeAt - waitClock) / 1000)));
  $effect(() => {
    if (resumeAt <= performance.now()) return;
    const timer = setInterval(() => { waitClock = performance.now(); if (waitClock >= resumeAt) clearInterval(timer); }, 250);
    return () => clearInterval(timer);
  });
  let confirmation = $state<number | null>(null);
  let metrics = $state.raw<{ first: number; total: number; segments: number; preparation?: PreparationTimings } | null>(null);
  let exporting = $state(false), exportWidth = $state<number | null>(1280), exportHeight = $state<number | null>(960), transparent = $state(false);
  // Exports keep the map's shape, width over height, so they hold exactly the map on screen.
  // The edge typed last is kept; the other follows it.
  let exportRatio = $state(4 / 3), exportEdge: 'width' | 'height' = 'width';
  const widthRange = $derived(edgeRange(exportRatio)), heightRange = $derived(edgeRange(1 / exportRatio));
  let gridMode = $state<GridMode>('none'), gridOpacity = $state(0.3);
  let exportError = $state('');
  // What the last export wrote, shown in the export dialog.
  let exported = $state('');
  let shareVisible = $state(false), bboxText = $state('');
  const shareText = $derived(shareVisible && ready ? url() : '');
  let controller: SceneController | null = null;
  let exportDialog: HTMLDialogElement;
  let exportAbort: AbortController | undefined;
  let searchAbort: AbortController | undefined;
  let searchRun = 0;
  let historyTimer: ReturnType<typeof setTimeout> | undefined;
  let providers: Providers;
  let overpassConcurrency = 1;
  let overpassFallback: string | undefined;
  let mobile = $state(false), controlsOpen = $state(true);
  // Height of the collapsed settings sheet on phones; the map takes the rest. The settings open
  // over the map, never resizing it, so the map always shows exactly what exports draw.
  const SHEET_COLLAPSED = 96;
  // Desktop sidebar; phones use the collapsible sheet instead.
  let sidebarOpen = $state(true);
  let showOptions = $state<HTMLButtonElement>(), hideOptions = $state<HTMLButtonElement>();
  async function toggleSidebar(open: boolean) {
    sidebarOpen = open; await tick();
    (open ? hideOptions : showOptions)?.focus();
  }
  const dateFormatter = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  // This request cache is not UI state and does not need reactive entries.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const searchCache = new Map<string, Boundary[]>();
  const presets = [
    { name: 'Paper', background: '#f7f2e8', roads: '#1a1a1a', labels: '#161616' },
    { name: 'Night', background: '#152737', roads: '#e1e7d9', labels: '#f8f2de' },
    { name: 'Moss', background: '#edf1e7', roads: '#356047', labels: '#244735' },
    { name: 'Plum', background: '#302a3b', roads: '#e4d8c7', labels: '#fbecd4' },
  ];

  function copy(): Design { return { ...design, label: { ...design.label }, northAt: { ...design.northAt }, scaleBarAt: design.scaleBarAt ? { ...design.scaleBarAt } : undefined, view: controller?.view() || design.view }; }
  function boundaryForShare(): Boundary {
    return { ...selected!, revision: source?.kind === 'r2' ? source.revision : selected?.revision, manifestSha256: source?.kind === 'r2' ? source.manifestSha256 : selected?.manifestSha256 };
  }
  function url() { return selected ? shareUrl(location.origin, location.pathname, boundaryForShare(), copy(), useCache) : ''; }
  function history() {
    clearTimeout(historyTimer);
    if (!ready || !selected) return;
    historyTimer = setTimeout(() => { window.history.replaceState(null, '', url()); }, 250);
  }
  $effect(() => { void [design.roadColor, design.roadOpacity, design.backgroundColor, design.backgroundOpacity, design.label.text, design.label.x, design.label.y, design.label.size, design.label.color, design.label.opacity, design.label.bold, design.label.italic, design.detail, design.font, design.north, design.northAt.x, design.northAt.y, design.scaleBar, design.scaleBarAt?.x, design.scaleBarAt?.y, design.rotation, useCache]; history(); });
  function cancel() {
    generation++; mounted = false; loading = false; ready = false; controller = null; live = null; liveCoverage = null;
    confirmation = null; progress = null; transfer = null; status = 'Load cancelled.';
  }
  // Any new stage or received bytes counts as activity for the stall warning.
  function track(value: LoadProgress, id: number) {
    if (id !== generation) return;
    const now = performance.now();
    if (value.bytes !== undefined) transfer = { bytes: value.bytes, total: value.totalBytes };
    if (value.bytes !== undefined || value.message !== progress?.message) lastActivityAt = now;
    progress = value; clock = now;
  }
  $effect(() => {
    if (!loading) return;
    const timer = setInterval(() => { clock = performance.now(); }, 1000);
    return () => clearInterval(timer);
  });
  function choose(boundary: Boundary, allowLarge = true, forceNetwork = false, restore?: Design) {
    shareVisible = false; savedId = null;
    generation++; mounted = false; ready = false; controller = null; live = null; liveCoverage = null; source = null; coverage = null; metrics = null; error = ''; confirmation = null;
    selected = boundary; loading = true; status = `Loading ${boundary.name}…`;
    progress = null; transfer = null; startedAt = lastActivityAt = clock = performance.now();
    if (restore) design = { ...restore, label: { ...restore.label }, northAt: { ...restore.northAt }, scaleBarAt: restore.scaleBarAt ? { ...restore.scaleBarAt } : undefined };
    else { design.view = undefined; design.rotation = 0; turnLeft = false; design.label.text = boundary.name.split(',')[0].slice(0, 256); }
    bboxText = boundary.bbox?.join(',') || '';
    // The shipped revision stays local even when a separate R2 delivery origin is configured.
    const bundled = BUNDLED_MAPS.some(map => map.key === boundary.key && map.revision === boundary.revision && map.manifestSha256 === boundary.manifestSha256);
    const mapProviders = bundled ? { ...providers, cityDataBase: publicUrl(new URL(`${import.meta.env.BASE_URL}data`, location.origin).href), cityDataBundled: true } : providers;
    const viewport = LIVE_VIEWPORT && !boundary.fixture && hasLocation(boundary, design.view);
    options = { boundary, providers: mapProviders, useCache, allowLarge, forceNetwork, detail: design.detail, fixtureUrl: boundary.fixture ? new URL(`${import.meta.env.BASE_URL}fixtures/${boundary.fixture}.json`, location.origin).href : undefined, ...(viewport ? { viewport } : {}) };
    // Smaller devices keep less road geometry before unseen regions are evicted.
    const small = matchMedia('(max-width: 750px)').matches || ((navigator as { deviceMemory?: number }).deviceMemory ?? 8) <= 4;
    liveSettings = viewport ? { overpass: providers.overpass, fallback: testing.get('liveMirror') === '1' ? new URL('/mirror-roads', providers.overpass).href : overpassFallback, concurrency: overpassConcurrency, budgetBytes: LIVE_BUDGET ?? (small ? 64 : 160) * 1024 * 1024, useCache, forceNetwork, debug: import.meta.env.DEV, pace: testing.get('livePacing') === '1' } : undefined;
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
        const data: unknown = await responseJson(response, 1024 * 1024);
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
  function loaded(scene: SceneController, geometry: Geometry, first: number, total: number, id: number, viewport?: LiveViewport) {
    if (id !== generation) return;
    controller = scene; ready = true; loading = false; source = geometry.source; coverage = geometry.coverage; confirmation = null;
    live = viewport || null;
    // A live viewport map is usable at once; its roads keep loading as the view changes.
    if (live) status = 'Loading roads in view…';
    else { metrics = { first, total, segments: geometry.segmentCount, preparation: geometry.preparation }; status = `${selected!.name} ready.`; }
    history();
  }
  function failed(message: string, id: number) { if (id !== generation) return; controlsOpen = true; mounted = false; loading = false; ready = false; controller = null; live = null; liveCoverage = null; error = message; status = 'Map could not be loaded.'; }
  const LIMITED = ['roads', 'streets', 'footpaths and service roads'];
  // Why live loading paused, from the provider failure that paused it.
  const PAUSED: Partial<Record<FailureCode, string>> = {
    unreachable: 'The road service cannot be reached from this network. Check the connection, then retry loading roads.',
    rate_limited: 'The road service is busy. Retry loading roads when you are ready.',
    provider_busy: 'The road service is too busy right now. Retry loading roads later.',
    timeout_or_resource_limit: 'The road service is overloaded or this area is too dense. Zoom in, or retry loading roads later.',
    response_too_large: 'The road service is overloaded or this area is too dense. Zoom in, or retry loading roads later.',
    provider_unavailable: 'The road service is not responding. Retry loading roads later.',
  };
  function covered(value: LiveCoverage, id: number) {
    if (id !== generation) return;
    liveCoverage = value;
    waitClock = performance.now(); resumeAt = value.cooldown > 0 ? waitClock + value.cooldown : 0;
    // Phase changes only, so the live region announces little while loading.
    if (value.complete && value.stats.staleRegions) status = `${selected!.name} ready with older cached roads.`;
    else if (value.exhausted) status = 'This session has made many road requests. Retry loading roads to continue.';
    else if (value.paused) status = PAUSED[value.pauseReason || 'provider_unavailable'] || PAUSED.provider_unavailable!;
    else if (value.loading && value.waiting === 'another_map') status = 'Another map is using the road service. Loading resumes automatically…';
    else if (value.loading && value.cooldown > 0 && (value.waiting === 'pacing' || value.waiting === 'previous_request')) status = 'Giving the road service time between requests. Loading resumes shortly…';
    else if (value.loading && value.cooldown > 0) status = value.waiting === 'provider_busy' ? 'The road service is busy. Loading resumes by itself shortly…' : 'The road service asked to wait. Loading resumes shortly…';
    else if (value.loading) status = 'Loading roads in view…';
    else if (value.failed) status = 'Some roads in view could not be loaded.';
    else if (value.beyond === 'entirely') status = `This view is more than ${value.radius / 1000} km from where the map started, so no roads load here. Search for a place to map it.`;
    else if (value.limited.length) status = `Zoom in to load ${LIMITED[Math.min(...value.limited)]} here.`;
    else status = `${selected!.name} ready.`;
  }
  function large(bytes: number, id: number) { if (id !== generation) return; controlsOpen = true; mounted = false; loading = false; confirmation = bytes; status = 'Confirm this download to continue.'; }
  function view(view: GeoView, id: number) { if (id === generation) { design.view = view; history(); reshapeExport(); } }
  function setDetail(level: RoadDetail) {
    design.detail = level;
    // Live viewport maps load newly shown road classes by themselves.
    if (source?.viewport) return;
    // Live geometry holds only the classes it was downloaded with; fetch more when needed.
    // Otherwise the map shows or hides the loaded classes without downloading.
    if (selected && mounted && !(ready && coverage && covers(coverage, level))) choose(selected, true, false, copy());
  }
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
    // The map as shown, at the screen's pixel density.
    const { width, height, pixelRatio } = controller.snapshot();
    exportRatio = width / height; sizeExport('width', width * pixelRatio, true);
    exportError = ''; exported = ''; exportDialog.showModal();
  }
  /** Sets one edge of the export and the other from the map's shape; `fit` also moves both within the limits. */
  function sizeExport(edge: 'width' | 'height', value: number | null, fit = false) {
    // An emptied edge comes back from the other.
    if (fit && !Number.isFinite(value)) { edge = edge === 'width' ? 'height' : 'width'; value = edge === 'width' ? exportWidth : exportHeight; }
    const ratio = edge === 'width' ? exportRatio : 1 / exportRatio;
    // While typing, the typed value stays as it is; an empty one leaves the other edge.
    const [own, other] = fit ? linkedSize(value!, ratio) : [value, Number.isFinite(value) ? Math.round(value! / ratio) : edge === 'width' ? exportHeight : exportWidth];
    exportEdge = edge;
    if (edge === 'width') { exportWidth = own; exportHeight = other; } else { exportHeight = own; exportWidth = other; }
  }
  /** A window that changes shape while the dialog is open keeps the export's width. */
  function reshapeExport() {
    if (!controller || !exportDialog?.open) return;
    const { width, height } = controller.snapshot();
    if (width / height !== exportRatio) { exportRatio = width / height; sizeExport('width', exportWidth, true); }
  }
  async function exportFile(format: 'png' | 'svg') {
    if (!controller || exporting || !(source?.complete || source?.viewport && live)) return;
    sizeExport(exportEdge, exportEdge === 'width' ? exportWidth : exportHeight, true);
    const scene = controller, width = exportWidth!, height = exportHeight!;
    // A live map exports exactly the roads drawn in the export's frame now; nothing more loads.
    const drawn = live?.exportRegions(fitCamera(scene.frame(), width / height), scene.rotation);
    const snapshot = scene.snapshot(drawn?.regions), complete = drawn?.complete ?? true;
    exporting = true; exportError = ''; exported = ''; exportAbort = new AbortController();
    try {
      await new Promise(requestAnimationFrame);
      const { exportMap, download, checkDimensions } = await import('./lib/exports.ts');
      const settings = { width, height, transparent, grid: { mode: gridMode, opacity: gridOpacity } };
      checkDimensions(settings);
      const blob = await exportMap(snapshot, settings, format, exportAbort.signal);
      exportAbort.signal.throwIfAborted();
      download(blob, `${snapshot.design.label.text || selected!.name}.${format}`);
      status = exported = complete ? `${format.toUpperCase()} exported.` : 'Exported available map.';
    } catch (e) { if (!exportAbort?.signal.aborted) exportError = e instanceof Error ? e.message : 'Export failed'; }
    finally { exporting = false; }
  }
  async function share() {
    shareVisible = true;
    try { await navigator.clipboard.writeText(shareText); status = 'Design link copied.'; }
    catch { status = 'Select the link below to copy it.'; }
  }
  function save() {
    if (!selected) return;
    if (saveDesign(boundaryForShare(), copy())) { saved = designs(); savedId = saved[0]?.id || null; status = 'Design saved in this browser.'; }
    else status = 'Local storage is unavailable. Use a share link to keep this design.';
  }
  function updateSaved() {
    if (!selected || !savedId) return;
    if (updateDesign(savedId, boundaryForShare(), copy())) { saved = designs(); status = 'Saved design updated in this browser.'; }
    else status = 'This design could not be updated. Use Save design or a share link to keep it.';
  }
  function restore(record: SavedDesign) {
    try { const parsed = parseUrl(new URL(shareUrl(location.origin, location.pathname, record.boundary, record.design)).search); if (!parsed.boundary || parsed.warning || parsed.boundary.fixture && !SAMPLES) throw new Error('Invalid saved design'); choose(parsed.boundary, true, false, parsed.design); savedId = record.id; }
    catch { error = 'This saved design could not be restored. You can remove it and create a new one.'; }
  }
  function exportDesign(record: SavedDesign) {
    try {
      download(new Blob([designFile(record, location.origin, location.pathname)], { type: 'application/json;charset=utf-8' }), `${record.name}.citymap.json`);
      status = 'Design settings exported. Open the link in the file to restore this map.';
    } catch { error = 'This saved design could not be exported. You can remove it and save a new one.'; controlsOpen = true; }
  }
  function exportLoadReport() {
    if (live) download(new Blob([JSON.stringify(live.report(), null, 2)], { type: 'application/json;charset=utf-8' }), 'citymap-load-report.json');
  }
  async function clear() {
    const [cities] = await Promise.all([clearCityCache(), clearCellCache()]);
    status = cities ? 'Saved city geometry cleared. Designs are preserved.' : 'Local cache is unavailable in this browser.';
  }
  function date(value?: string) { return value && Number.isFinite(Date.parse(value)) ? dateFormatter.format(new Date(value)) : 'unavailable'; }

  onMount(() => {
    const media = window.matchMedia('(max-width: 750px)');
    const resize = () => { mobile = media.matches; };
    resize(); media.addEventListener('change', resize);
    try {
      // Without a configured R2 origin, city datasets come from the app's own bundled /data.
      const cityData = publicUrl(import.meta.env.VITE_CITY_DATA_BASE_URL || '');
      providers = { cityDataBase: cityData || publicUrl(new URL(`${import.meta.env.BASE_URL}data`, location.origin).href), cityDataBundled: !cityData, legacyCacheBase: publicUrl(import.meta.env.VITE_AREA_SERVER || ''), overpass: publicUrl(import.meta.env.VITE_OVERPASS_URL || '', 'https://overpass-api.de/api/interpreter'), search: publicUrl(import.meta.env.VITE_SEARCH_URL || '', new URL('/api/search', location.origin).href) };
      // One request at a time suits a shared public road service; a private one may allow more.
      const concurrency = Number(import.meta.env.VITE_OVERPASS_CONCURRENCY || 1);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('VITE_OVERPASS_CONCURRENCY must be a whole number from 1 to 4');
      // Shared public instances get one request at a time; more applies to private providers.
      overpassConcurrency = isPublicOverpass(providers.overpass) ? 1 : concurrency;
      overpassFallback = backupProvider(providers.overpass, import.meta.env.VITE_OVERPASS_FALLBACK_URL);
      if (import.meta.env.DEV && overpassConcurrency < concurrency) console.warn(`[citymap] VITE_OVERPASS_CONCURRENCY=${concurrency} is capped at 1 for the public road service ${new URL(providers.overpass).hostname}.`);
      if (linked) {
        if (link.auto && !link.warning) choose(linked, false, false, link.design);
        else { status = 'This link selects a city. Load its roads to continue.'; bboxText = linked.bbox?.join(',') || ''; }
      }
    } catch (e) { error = e instanceof Error ? e.message : 'Invalid provider configuration'; }
    return () => { media.removeEventListener('change', resize); searchAbort?.abort(); exportAbort?.abort(); clearTimeout(historyTimer); };
  });
</script>

<svelte:window onkeydown={event => { if (event.key === 'Escape' && loading) cancel(); }} />
{#snippet hamburger()}<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>{/snippet}
<main class="layout" style:--sheet-collapsed={`${SHEET_COLLAPSED}px`}>
  <aside id="options" class:collapsed={mobile && !controlsOpen} hidden={!mobile && !sidebarOpen} aria-label="Map settings">
    <div class="sheet-toolbar">
      <span class="sheet-title">{selected?.name.split(',')[0] || 'Citymap'}</span>
      {#if !controlsOpen && loading}<button onclick={cancel}>Cancel load</button>{/if}
      <button aria-expanded={controlsOpen} aria-controls="settings-content" onclick={() => { controlsOpen = !controlsOpen; }}>{controlsOpen ? 'Hide controls' : 'Show controls'}</button>
      {#if loading}{#if activity.max}<progress class="sheet-progress" aria-hidden="true" max={activity.max} value={activity.value}></progress>{:else}<progress class="sheet-progress" aria-hidden="true"></progress>{/if}{:else if liveCoverage?.loading}<progress class="sheet-progress" aria-hidden="true" max={liveCoverage.required} value={liveCoverage.ready}></progress>{/if}
    </div>
    {#if mobile && !controlsOpen}<p class="sheet-status" role="status" aria-live="polite">{status}</p>{/if}
    <div id="settings-content" hidden={mobile && !controlsOpen}>
    <header>{#if !mobile}<button class="menu-toggle hide-options" bind:this={hideOptions} aria-label="Hide options" aria-expanded="true" aria-controls="options" onclick={() => toggleSidebar(false)}>{@render hamburger()}</button>{/if}<p class="eyebrow">CITYMAP</p><h1>Make a map.</h1><p>Your city, drawn in roads.</p></header>
    {#if !selected}<div class="quick-start">{#each BUNDLED_MAPS as map (map.key)}<button onclick={() => { query = map.name; choose(map); }}>Open {map.name}</button>{/each}<p class="hint">Start with a built-in map, without waiting for the road service.</p></div>{/if}
    <form onsubmit={event => { event.preventDefault(); void search(); }}>
      <label for="search">Find a city</label><div class="search-row"><input id="search" type="search" bind:value={query} oninput={editQuery} placeholder="Tokyo, Japan" autocomplete="off" maxlength="256"><button type="submit" disabled={searching || !query.trim()}>Search</button></div>
      <div class="results">{#each results as city (city.key)}<button type="button" onclick={() => choose(city)}>{city.name}<small>{city.kind}{city.osmType ? ` · ${city.osmType}` : ''}</small></button>{/each}</div>
    </form>
    {#if SAMPLES}<details class="samples"><summary>Try a sample map</summary><div class="buttons"><button onclick={() => sample('small')}>Small sample</button><button onclick={() => sample('medium')}>Medium sample</button><button onclick={() => sample('large')}>Large sample</button></div><p class="hint">Test build only: synthetic geometry without provider requests.</p></details>{/if}
    <p role="status" aria-live="polite">{status}</p>
    {#if liveCoverage?.stats.staleRegions}<p class="hint older-roads">Showing older cached roads while the road service is unavailable. Oldest download: {date(liveCoverage.stats.oldestFetch ? new Date(liveCoverage.stats.oldestFetch).toISOString() : undefined)}. Use Refresh city data to try a new download.</p>{/if}
    {#if liveCoverage?.stats.failovers}<p class="hint backup-roads">Using the backup road service: {liveCoverage.stats.activeProvider}.</p>{/if}
    {#if loading}
      <div class="load-status">
        {#if activity.max}<progress aria-label="Map download" max={activity.max} value={activity.value}></progress>{:else}<progress aria-label="Map download"></progress>{/if}
        <p class="hint">{activity.text}</p>
        {#if activity.warning}<p class="hint warning" aria-live="polite">{activity.warning}</p>{/if}
        <button onclick={cancel}>Cancel load</button>
      </div>
    {/if}
    {#if liveCoverage && ready && (!liveCoverage.complete || liveCoverage.beyond !== 'none')}
      <div class="load-status live-status">
        {#if liveCoverage.loading}<progress aria-label="Roads in view" max={liveCoverage.required} value={liveCoverage.ready}></progress>{/if}
        {#if waitSeconds > 0}<p class="hint">{liveCoverage.waiting === 'provider_busy' ? 'The road service is busy' : liveCoverage.waiting === 'pacing' || liveCoverage.waiting === 'previous_request' ? 'Giving the road service time between requests' : 'The road service asked to wait'}: retrying in {waitSeconds} s.</p>{/if}
        <p class="hint">{liveCoverage.ready} of {liveCoverage.required} map regions in view loaded{liveCoverage.failed ? ` · ${liveCoverage.failed} failed` : ''}{liveCoverage.limited.length ? ' · zoom in for more road detail' : ''}</p>
        {#if liveCoverage.beyond !== 'none'}<p class="hint">Roads load only within {liveCoverage.radius / 1000} km of where this map started.</p>{/if}
        {#if !liveCoverage.exportable}<p class="hint">Export is available once the centre of the map has loaded.</p>{/if}
        {#if liveCoverage.failed || liveCoverage.paused || liveCoverage.exhausted}<button onclick={() => live?.retry()}>Retry loading roads</button>{/if}
      </div>
    {/if}
    {#if error}<div role="alert" class="error">{error}{#if selected}<button onclick={() => choose(selected!, true, true, copy())}>Retry map</button>{/if}</div>{/if}
    {#if confirmation !== null}<div class="notice">{confirmation ? `This map needs about ${formatBytes(confirmation)} of cached data.` : 'Live downloads can be large. Load this map when you are ready.'}<button onclick={() => choose(selected!, true, false, copy())}>Load roads</button></div>{:else if selected && !mounted && !loading}<button onclick={() => choose(selected!, true, false, copy())}>Load roads</button>{/if}
    {#if selected}
      <fieldset disabled={!ready}><legend>Map controls</legend><div class="buttons"><button onclick={() => controller?.zoom(1.25)} aria-label="Zoom in">+</button><button onclick={() => controller?.zoom(0.8)} aria-label="Zoom out">−</button><button onclick={() => controller?.fit()}>Fit map</button><button onclick={openExport} disabled={source?.viewport && !liveCoverage?.exportable}>Export</button></div><div class="slider-label"><label for="rotation">Map rotation</label><output for="rotation">{Math.abs(design.rotation || 0)}°</output></div><div class="choices" role="radiogroup" aria-label="Rotation direction"><label class="checkbox"><input type="radio" name="turn" checked={!turnLeft} onchange={() => rotate(Math.abs(design.rotation || 0), false)}> Right</label><label class="checkbox"><input type="radio" name="turn" checked={turnLeft} onchange={() => rotate(Math.abs(design.rotation || 0), true)}> Left</label></div><input id="rotation" type="range" min="0" max="180" step="1" value={Math.abs(design.rotation || 0)} oninput={event => rotate(Number(event.currentTarget.value))} aria-valuetext={turn(design.rotation || 0)}><p class="hint">Right turns the map clockwise, Left counter-clockwise. Turn it to fill the frame, then use Fit map.</p></fieldset>
      <details open><summary>Customize</summary>
        <fieldset><legend>Road detail</legend><label for="detail">Roads shown</label><select id="detail" value={design.detail} onchange={event => setDetail(event.currentTarget.value as RoadDetail)}><option value="major">Major roads</option><option value="streets">Streets</option><option value="all">All ways, including footpaths and service roads</option></select><p class="hint">Footpaths, sidewalks and service ways can make dense cities solid black.</p></fieldset>
        <fieldset><legend>Presets</legend><div class="buttons">{#each presets as preset (preset.name)}<button onclick={() => applyPreset(preset)}>{preset.name}</button>{/each}</div></fieldset>
        <fieldset><legend>Colors</legend><label>Road color <input type="color" bind:value={design.roadColor}></label><div class="slider-label"><label for="road-opacity">Road opacity</label><output for="road-opacity">{percent(design.roadOpacity)}</output></div><input id="road-opacity" type="range" min="0" max="1" step="0.05" bind:value={design.roadOpacity} aria-valuetext={percent(design.roadOpacity)}><label>Background color <input type="color" bind:value={design.backgroundColor}></label><div class="slider-label"><label for="background-opacity">Background opacity</label><output for="background-opacity">{percent(design.backgroundOpacity)}</output></div><input id="background-opacity" type="range" min="0" max="1" step="0.05" bind:value={design.backgroundOpacity} aria-valuetext={percent(design.backgroundOpacity)}></fieldset>
        <fieldset><legend>Label</legend><label for="label">Label text</label><input id="label" bind:value={design.label.text} maxlength="256"><label for="font">Typeface</label><select id="font" bind:value={design.font}><option value="serif">Serif (Computer Modern)</option><option value="mono">Monospace (Fira Code)</option><option value="sans">Sans-serif</option></select><div class="choices"><label class="checkbox"><input type="checkbox" bind:checked={design.label.bold}> Bold</label><label class="checkbox"><input type="checkbox" bind:checked={design.label.italic}> Italic</label></div><p class="hint">The typeface is used for the label, north arrow, scale bar and coordinate grid; bold and italic style the label.</p><label>Label color <input type="color" bind:value={design.label.color}></label><div class="slider-label"><label for="label-opacity">Label opacity</label><output for="label-opacity">{percent(design.label.opacity)}</output></div><input id="label-opacity" type="range" min="0" max="1" step="0.05" bind:value={design.label.opacity} aria-valuetext={percent(design.label.opacity)}><div class="slider-label"><label for="size">Label size</label><output for="size">{design.label.size} px</output></div><input id="size" type="range" min="10" max="128" bind:value={design.label.size} aria-valuetext={`${design.label.size} pixels`}><label class="checkbox"><input type="checkbox" bind:checked={design.north}> Show north arrow</label><label class="checkbox"><input type="checkbox" bind:checked={design.scaleBar}> Show scale bar</label><p class="hint">Drag the label, north arrow or scale bar on the map, or focus one and use arrow keys.</p></fieldset>
      </details>
      <fieldset disabled={!ready}><legend>Keep this design</legend><div class="buttons"><button onclick={share}>Copy share link</button><button onclick={save}>Save design</button>{#if savedId}<button onclick={updateSaved}>Update saved design</button>{/if}</div>{#if shareText}<label for="share">Share link</label><input id="share" readonly value={shareText} onclick={event => event.currentTarget.select()}>{/if}</fieldset>
      <details><summary>Data and source</summary><label class="checkbox"><input type="checkbox" bind:checked={useCache}> Use cached city data</label><button disabled={loading} onclick={() => choose({ ...selected!, revision: undefined, manifestSha256: undefined }, true, true, copy())}>Refresh city data</button><button onclick={clear}>Clear city cache</button>
        {#if source?.viewport}<p>Live OpenStreetMap data, loaded by map view<br>Source date: {date(liveCoverage?.stats.snapshotAt)}<br>Downloaded: {date(liveCoverage?.stats.oldestFetch ? new Date(liveCoverage.stats.oldestFetch).toISOString() : source.downloadedAt)}</p>
        {:else if source}<p>{source.local ? 'Local cache' : source.bundled ? 'Built-in city data' : ({ r2: 'R2 cache', legacy: 'Legacy cache', live: 'Live OpenStreetMap data', fixture: 'Synthetic sample' }[source.kind])}<br>Source date: {date(source.snapshotAt)}<br>Downloaded: {date(source.downloadedAt)}</p>{/if}
        <label for="bbox">Bounding box: south, west, north, east</label><input id="bbox" bind:value={bboxText} placeholder="35.6,139.6,35.8,139.8"><button onclick={boxLoad}>Load bounding box</button>
      </details>
      {#if liveCoverage}{@const stats = liveCoverage.stats}<details><summary>Load timings</summary><p>{stats.regions.toLocaleString()} map regions · {stats.segments.toLocaleString()} segments{stats.firstRoadMs !== undefined ? ` · first road frame ${stats.firstRoadMs.toFixed(1)} ms` : ''}</p><p>{stats.requests.toLocaleString()} road requests · {stats.cached.toLocaleString()} from the browser cache · {formatBytes(stats.bytes)} downloaded{stats.medianFetchMs !== undefined ? ` · median request ${stats.medianFetchMs.toFixed(0)} ms` : ''}{stats.splits ? ` · ${stats.splits} dense regions split` : ''}</p>{#if stats.recentFailures.at(-1)}{@const failure = stats.recentFailures.at(-1)!}<p>Last request failure: {failureLabel(failure.code)}{failure.status ? ` (HTTP ${failure.status})` : ''}.</p>{/if}<button onclick={exportLoadReport}>Download load report</button><p class="hint">Includes timings and errors. Queries and map coordinates are omitted.</p></details>{/if}
      {#if metrics}<details><summary>Load timings</summary><p>{metrics.segments.toLocaleString()} segments · first road frame {metrics.first.toFixed(1)} ms · complete {metrics.total.toFixed(1)} ms</p>{#if metrics.preparation}<p>Download {metrics.preparation.downloadMs.toFixed(1)} ms · decode {metrics.preparation.decodeMs.toFixed(1)} ms · index {metrics.preparation.indexMs.toFixed(1)} ms · projection {metrics.preparation.projectMs.toFixed(1)} ms</p><p class="hint">Download time includes delivery waits; parallel request times can overlap.</p>{/if}</details>{/if}
    {/if}
    <DesignImport {generation} allowFixtures={SAMPLES} onimport={value => choose(value.boundary, true, false, value.design)} />
    <SavedDesigns records={saved} onrestore={restore} onexport={exportDesign} ondelete={record => { const removed = removeDesign(record.id); if (removed) { saved = designs(); if (savedId === record.id) savedId = null; status = 'Saved design deleted.'; } return removed; }} onrename={(record, name) => { const renamed = renameDesign(record.id, name); if (renamed) { saved = designs(); status = 'Saved design renamed.'; } return renamed; }} />
    <footer>Map data <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors, ODbL</a>.</footer>
    </div>
  </aside>
  <section class="map-panel" aria-label="Map preview">
    {#if !mobile && !sidebarOpen}<button class="menu-toggle show-options" bind:this={showOptions} aria-label="Show options" aria-expanded="false" aria-controls="options" onclick={() => toggleSidebar(true)}>{@render hamburger()}</button>{/if}
    {#if mounted && options}{#key generation}<MapCanvas runId={generation} {options} {design} live={liveSettings} oncoverage={covered} onlabel={label => { design.label = label; }} onmark={(mark: 'northAt' | 'scaleBarAt', at: MarkPosition) => { design[mark] = at; }} onview={view} onerror={failed} onlarge={large} onprogress={track} onready={loaded} />{/key}
    {:else}<div class="empty"><h2>A city, in lines.</h2><p>{loading ? 'Preparing your map…' : 'Find a city, choose its roads, and make it yours.'}</p></div>{/if}
  </section>
</main>
<dialog bind:this={exportDialog} class="export-dialog" aria-labelledby="export-title" onclose={() => { exportAbort?.abort(); }}>
  <h2 id="export-title">Export your map</h2><p>The current camera and design are preserved.</p>
  {#if source?.viewport && liveCoverage && (!liveCoverage.complete || liveCoverage.beyond !== 'none')}
    <p class="notice export-coverage">This view may have missing roads. Only roads currently drawn are included in the export. Wait for loading to finish, or zoom in to load more detail.</p>
  {/if}
  <label for="export-width">Width in pixels</label><input id="export-width" type="number" min={widthRange[0]} max={widthRange[1]} bind:value={() => exportWidth, value => sizeExport('width', value)} onchange={() => sizeExport('width', exportWidth, true)}><label for="export-height">Height in pixels</label><input id="export-height" type="number" min={heightRange[0]} max={heightRange[1]} bind:value={() => exportHeight, value => sizeExport('height', value)} onchange={() => sizeExport('height', exportHeight, true)}><label class="checkbox"><input type="checkbox" bind:checked={transparent}> Transparent background</label><fieldset class="grid-options"><legend>Coordinate grid</legend><label class="checkbox"><input type="radio" name="grid" value="none" bind:group={gridMode}> None</label><label class="checkbox"><input type="radio" name="grid" value="ticks" bind:group={gridMode}> Ticks on the border</label><label class="checkbox"><input type="radio" name="grid" value="lines" bind:group={gridMode}> Light grid lines</label>{#if gridMode === 'lines'}<div class="slider-label"><label for="grid-opacity">Grid line opacity</label><output for="grid-opacity">{percent(gridOpacity)}</output></div><input id="grid-opacity" type="range" min="0.05" max="1" step="0.05" bind:value={gridOpacity} aria-valuetext={percent(gridOpacity)}>{/if}</fieldset><p class="hint">Up to 16 megapixels. Map data © OpenStreetMap contributors (ODbL): credit it wherever you share the image.</p><div class="buttons"><button disabled={exporting} onclick={() => exportFile('png')}>Download PNG</button><button disabled={exporting} onclick={() => exportFile('svg')}>Download SVG</button><button onclick={() => { exportAbort?.abort(); exportDialog.close(); }}>{exporting ? 'Cancel export' : 'Close'}</button></div>{#if exporting}<p role="status">Preparing export…</p>{:else if exported}<p role="status">{exported}</p>{/if}{#if exportError}<p role="alert">{exportError}</p>{/if}
</dialog>

<style>
/* The map fills the layout; the settings open over it and never resize it. */
.layout { position: relative; height: 100dvh; overflow: hidden; }
aside { position: absolute; top: 0; bottom: 0; left: 0; width: 320px; z-index: 3; background: var(--ui-surface); border-right: 1px solid var(--ui-border); box-shadow: 2px 0 12px #0002; overflow-y: auto; padding: 28px 22px; }
h1 { font-size: 30px; letter-spacing: -1px; margin: 8px 0; }
header p, .hint, footer { color: #626d60; font-size: 13px; line-height: 1.5; }
.eyebrow { letter-spacing: .15em; font-size: 12px; font-weight: 700; }
label { display: block; font-size: 13px; font-weight: 600; margin: 10px 0 6px; }
input:not([type=color]):not([type=range]) { width: 100%; border: 1px solid #bcc5b7; border-radius: 6px; padding: 10px; background: #fff; }
input[type=color] { width: 44px; height: 30px; margin-left: 8px; padding: 0; vertical-align: middle; }
input[type=range], select { width: 100%; }
.slider-label { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin: 10px 0 6px; }
.slider-label label { margin: 0; }
output { font-size: 13px; font-variant-numeric: tabular-nums; color: #3f4a3c; }
.load-status { margin: 8px 0 12px; }
.load-status progress { display: block; width: 100%; height: 10px; accent-color: #507e5c; }
.load-status .hint { margin: 6px 0; font-variant-numeric: tabular-nums; }
.warning { color: #7a4b00; }
.sheet-progress { position: absolute; left: 0; right: 0; bottom: 0; width: 100%; height: 3px; accent-color: #507e5c; }
select { border: 1px solid #bcc5b7; border-radius: 6px; padding: 9px; background: #fff; font: inherit; }
.results { display: grid; gap: 6px; margin-top: 10px; }
.results button { text-align: left; }
.results small { display: block; color: #657461; margin-top: 5px; }
fieldset { border: 0; border-top: 1px solid var(--ui-border); margin: 20px 0 0; padding: 12px 0 0; min-width: 0; }
legend { padding-right: 10px; font-size: 13px; font-weight: 700; }
.buttons { display: flex; gap: 6px; flex-wrap: wrap; }
.error { color: #8e2525; font-size: 14px; line-height: 1.5; }.error button { display: block; margin-top: 8px; }
.map-panel { position: absolute; inset: 0; }
header { position: relative; }
.menu-toggle { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; padding: 0; }
.hide-options { position: absolute; top: -6px; right: 0; }
.show-options { position: absolute; top: 12px; left: 12px; z-index: 2; box-shadow: 0 1px 4px #0002; }
.empty { display: grid; align-content: center; height: 100%; padding: 40px; text-align: center; color: #54654d; }
.empty h2 { font-size: clamp(28px, 5vw, 60px); font-weight: 400; letter-spacing: -2px; margin: 0; }
footer { margin-top: 28px; }
details { margin-top: 18px; font-size: 12px; line-height: 1.6; }
.sheet-toolbar { display: none; }
.sheet-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 600; }
.sheet-status { margin: 0 0 10px; font-size: 12px; }
@media (max-width: 750px) {
  /* The map ends above the collapsed sheet, which opens up over it. */
  .map-panel { bottom: var(--sheet-collapsed); }
  aside { top: auto; right: 0; width: auto; height: 45dvh; min-height: 80px; border-top: 1px solid var(--ui-border); border-right: 0; box-shadow: 0 -2px 12px #0002; padding: 0 16px 16px; overflow-y: auto; }
  aside.collapsed { height: var(--sheet-collapsed); overflow: hidden; }
  header { margin-bottom: 16px; }
  .sheet-toolbar { display: flex; align-items: center; gap: 8px; position: sticky; top: 0; padding: 12px 0; background: var(--ui-surface); z-index: 1; }
  button { min-height: 44px; }
}
.search-row { display: flex; gap: 6px; }.search-row input { min-width: 0; }
.checkbox { display: flex; align-items: center; gap: 8px; font-weight: 400; }.checkbox input { width: auto !important; }
.notice { border-left: 3px solid #507e5c; padding: 12px; background: #edf1e7; font-size: 14px; }.notice button { display: block; margin-top: 10px; }
.export-dialog { border: 0; background: var(--ui-surface); padding: 24px; border-radius: 10px; max-width: 440px; width: calc(100% - 40px); max-height: 90dvh; overflow: auto; }
.export-dialog::backdrop { background: #20282080; }
.export-dialog h2 { margin-top: 0; }
.grid-options { margin-top: 12px; }
.grid-options .checkbox { margin: 6px 0; }
.choices { display: flex; gap: 18px; margin: 6px 0 4px; }.choices .checkbox { margin: 0; }
</style>
