<script lang="ts">
  import { onMount } from 'svelte';
  import { fontStack } from './lib/domain.ts';
  import type { Design, GeoView, Geometry, LoadProgress, MarkPosition } from './lib/domain.ts';
  import type { Size } from './lib/marks.ts';
  import type { SceneController } from './lib/SceneController.ts';
  import { loadCity } from './lib/load-city.ts';
  import { NORTH_ARROW } from './lib/north-arrow.ts';
  import { metresPerSceneUnit, scaleBar, SCALE_BAR } from './lib/scale-bar.ts';
  import { northCentre, scaleBarCentre } from './lib/marks.ts';
  import type { WorkerLoad } from './lib/worker-protocol.ts';
  import type { LiveCoverage, LiveSettings, LiveViewport } from './lib/live/viewport.ts';
  type Mark = 'label' | 'northAt' | 'scaleBarAt';
  let { runId, options, design, area, live: liveSettings, onready, onerror, onlarge, onprogress, onlabel, onmark, onview, oncoverage }: {
    runId: number; options: WorkerLoad & { forceNetwork?: boolean }; design: Design;
    /** CSS pixel size of the composed map: the map area with the settings collapsed; 0 until measured. */
    area: Size;
    /** Live viewport loading settings, used when no stored dataset applies. */
    live?: Omit<LiveSettings, 'cache'> & { useCache: boolean };
    onready: (controller: SceneController, geometry: Geometry, firstFrameMs: number, totalMs: number, runId: number, live?: LiveViewport) => void;
    oncoverage?: (coverage: LiveCoverage, runId: number) => void;
    onerror: (message: string, runId: number) => void; onlarge: (bytes: number, runId: number) => void;
    onprogress: (progress: LoadProgress, runId: number) => void;
    onlabel: (label: Design['label']) => void; onmark: (mark: 'northAt' | 'scaleBarAt', at: MarkPosition) => void;
    onview: (view: GeoView, runId: number) => void;
  } = $props();
  let canvas: HTMLCanvasElement;
  let frame = $state<HTMLDivElement>();
  let controller: SceneController | undefined;
  let live: LiveViewport | undefined;
  let dragging: Mark | null = null;
  let drawable = $state(false);
  let hostWidth = $state(0), hostHeight = $state(0);
  // The composed map: the label and marks are laid out at its size. It fills the canvas, or
  // beside opened settings shows whole and smaller, scaled by `fit`, as the scene draws it.
  const map = $derived(area.width > 0 && area.height > 0 ? { width: area.width, height: area.height } : { width: hostWidth || 1, height: hostHeight || 1 });
  const fit = $derived(hostWidth && hostHeight ? Math.min(hostWidth / map.width, hostHeight / map.height) : 1);
  // Ground distance per CSS pixel of the composed map at the view's centre latitude.
  const scale = $derived(design.scaleBar && design.view ? scaleBar(design.view.width / map.width * metresPerSceneUnit(design.view.lat)) : undefined);
  const compassAt = $derived(northCentre(design, map));
  const scaleAt = $derived(scale ? scaleBarCentre(design, scale, map) : undefined);
  onMount(() => {
    let disposed = false;
    const id = runId;
    const started = performance.now();
    let firstFrameMs = 0;
    const module = import('./lib/SceneController.ts');
    const stop = loadCity(options, {
      progress: progress => { if (!disposed) onprogress(progress, id); },
      viewport: async () => {
        const [{ SceneController }, { LiveViewport }, { liveStart }, { CellCache }] = await Promise.all([module, import('./lib/live/viewport.ts'), import('./lib/live/start.ts'), import('./lib/live/cell-cache.ts')]);
        if (disposed) return;
        const start = liveStart(options.boundary, design.view, design.detail);
        if (!start || !liveSettings) throw new Error('This map has no location to load live roads around. Search for the city again.');
        const geometry: Geometry = { buffers: [], ranks: [], coverage: 'all', bounds: start.bounds, origin: start.origin, segmentCount: 0, source: { kind: 'live', viewport: true, downloadedAt: new Date().toISOString(), complete: false } };
        controller = new SceneController(canvas, geometry, design, { onView: view => { if (!disposed) { onview(view, id); live?.viewChanged(); } }, camera: design.view ? undefined : start.camera, fit: 'bounds', area: map });
        const { useCache, ...settings } = liveSettings;
        live = new LiveViewport(controller, start.origin, design.detail, { ...settings, cache: useCache ? new CellCache() : undefined }, coverage => { if (!disposed) oncoverage?.(coverage, id); });
        drawable = true;
        onready(controller, geometry, 0, performance.now() - started, id, live);
      },
      chunk: async (positions, bounds, origin, rank) => {
        const { SceneController } = await module;
        if (disposed) return;
        if (!controller) {
          const geometry: Geometry = { buffers: [], ranks: [], coverage: options.detail, bounds, origin, segmentCount: 0, source: { kind: 'live', downloadedAt: '', complete: false } };
          controller = new SceneController(canvas, geometry, design, { onView: view => { if (!disposed) onview(view, id); }, area: map });
          drawable = true;
        }
        onprogress({ stage: 'draw', message: 'Drawing road geometry…' }, id);
        const frameAt = await controller.appendGeometry(positions, rank);
        if (!firstFrameMs && frameAt !== undefined) firstFrameMs = frameAt - started;
      },
      done: async geometry => {
        if (disposed || !controller) return;
        controller.geometry.source = geometry.source;
        await new Promise(requestAnimationFrame);
        if (!disposed) onready(controller, geometry, firstFrameMs, performance.now() - started, id);
      },
      error: (message, diagnostic) => {
        // Provider remarks are untrusted: development builds log a sanitized copy; the page never shows it.
        if (diagnostic && import.meta.env.DEV) console.warn('[citymap] road provider remark:', diagnostic);
        if (!disposed) { canvas.removeEventListener('webglcontextlost', lost); live?.dispose(); live = undefined; controller?.dispose(); controller = undefined; drawable = false; onerror(message, id); }
      },
      large: bytes => { if (!disposed) onlarge(bytes, id); },
    });
    const lost = (event: Event) => { event.preventDefault(); if (!disposed) { stop(); live?.dispose(); controller?.dispose(); drawable = false; onerror('WebGL context lost. Reload this map to recover.', id); } };
    canvas.addEventListener('webglcontextlost', lost);
    return () => { disposed = true; stop(); canvas.removeEventListener('webglcontextlost', lost); live?.dispose(); controller?.dispose(); };
  });
  $effect(() => {
    const { width, height } = map;
    if (drawable) controller?.setArea({ width, height });
  });
  $effect(() => {
    if (!drawable) return;
    controller?.setSettings(design);
    // Rotation turns the loaded footprint; detail changes which road ranks load.
    live?.setDetail(design.detail);
    live?.viewChanged();
  });
  // The label, north arrow and scale bar are marks positioned by their normalized centre.
  // Marks are kept inside the map when drawn, so only the label needs an inset here.
  function place(mark: Mark, x: number, y: number) {
    const [min, max] = mark === 'label' ? [0.05, 0.95] : [0, 1];
    const at = { x: Math.max(min, Math.min(max, x)), y: Math.max(min, Math.min(max, y)) };
    if (mark === 'label') onlabel({ ...design.label, ...at }); else onmark(mark, at);
  }
  // A scale bar that has not been moved yet starts from where it is drawn, below the arrow.
  const current = (mark: Mark) => mark === 'label' ? design.label : mark === 'northAt' ? design.northAt : design.scaleBarAt || { x: (scaleAt?.x || 0) / map.width, y: (scaleAt?.y || 0) / map.height };
  const grab = (mark: Mark) => (event: PointerEvent) => { dragging = mark; (event.currentTarget as Element).setPointerCapture(event.pointerId); };
  const release = () => { dragging = null; };
  function move(event: PointerEvent) {
    if (!dragging || !frame) return;
    // The frame's on-screen box, as scaled: positions are fractions of the composed map.
    const rect = frame.getBoundingClientRect();
    place(dragging, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
  }
  const key = (mark: Mark) => (event: KeyboardEvent) => {
    const amount = event.shiftKey ? 0.05 : 0.01;
    const delta = { ArrowLeft: [-amount, 0], ArrowRight: [amount, 0], ArrowUp: [0, -amount], ArrowDown: [0, amount] }[event.key];
    if (!delta) return;
    event.preventDefault();
    const at = current(mark);
    place(mark, at.x + delta[0], at.y + delta[1]);
  };
</script>

<div class="map" bind:clientWidth={hostWidth} bind:clientHeight={hostHeight} style:font-family={fontStack(design.font)}>
  <canvas bind:this={canvas} tabindex="0" aria-label="Road map. Drag to pan; scroll or use map controls to zoom."></canvas>
  {#if drawable}
    <div class="frame" class:inset={fit < 0.995} bind:this={frame} style:left={`${(hostWidth - map.width * fit) / 2}px`} style:top={`${(hostHeight - map.height * fit) / 2}px`} style:width={`${map.width}px`} style:height={`${map.height}px`} style:transform={`scale(${fit})`}>
      <button class="map-label" style:left={`${design.label.x * 100}%`} style:top={`${design.label.y * 100}%`} style:color={design.label.color} style:opacity={design.label.opacity} style:font-size={`${design.label.size}px`} style:font-weight={design.label.bold ? 'bold' : 'normal'} style:font-style={design.label.italic ? 'italic' : 'normal'} aria-label="Move map label with arrow keys or drag"
        onpointerdown={grab('label')} onpointermove={move} onpointerup={release} onpointercancel={release} onkeydown={key('label')}>{design.label.text}</button>
      {#if design.north}
        <button class="map-mark compass" style:left={`${compassAt.x}px`} style:top={`${compassAt.y}px`} style:color={design.label.color} aria-label="North arrow. Drag or use arrow keys to move it."
          onpointerdown={grab('northAt')} onpointermove={move} onpointerup={release} onpointercancel={release} onkeydown={key('northAt')}>
          <svg viewBox={`0 0 ${NORTH_ARROW.width} ${NORTH_ARROW.height}`} width={NORTH_ARROW.width} height={NORTH_ARROW.height} aria-hidden="true" style:transform={`rotate(${design.rotation || 0}deg)`} style:transform-origin={`${NORTH_ARROW.cx}px ${NORTH_ARROW.cy}px`}><g fill="none" stroke="currentColor" stroke-width={NORTH_ARROW.stroke} stroke-linejoin="round" stroke-linecap="round"><path d={NORTH_ARROW.path} />{#each NORTH_ARROW.circles as circle (circle.r)}<circle cx={circle.cx} cy={circle.cy} r={circle.r} />{/each}</g><text x={NORTH_ARROW.letter.x} y={NORTH_ARROW.letter.y} font-size={NORTH_ARROW.letter.size}>N</text></svg>
        </button>
      {/if}
      {#if scale && scaleAt}
        <button class="map-mark scale-bar" style:left={`${scaleAt.x}px`} style:top={`${scaleAt.y}px`} style:color={design.label.color} aria-label={`Scale bar, ${scale.summary} at the map centre. Drag or use arrow keys to move it.`}
          onpointerdown={grab('scaleBarAt')} onpointermove={move} onpointerup={release} onpointercancel={release} onkeydown={key('scaleBarAt')}>
          <svg viewBox={`0 0 ${scale.width} ${scale.height}`} width={scale.width} height={scale.height} aria-hidden="true"><g stroke="currentColor" stroke-width={SCALE_BAR.stroke} stroke-linecap="square">{#each scale.lines as line, i (i)}<line x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} />{/each}</g>{#each scale.texts as text, i (i)}<text x={text.x} y={text.y} font-size={SCALE_BAR.font}>{text.text}</text>{/each}</svg>
        </button>
      {/if}
    </div>
  {/if}
</div>
<style>
  /* Fira Code has no italic design, so italic map text slants its upright face. */
  .map { font-synthesis: style; position: relative; width: 100%; height: 100%; overflow: hidden; background: repeating-conic-gradient(#f5f5f2 0 25%, #e3e6de 0 50%) 50% / 16px 16px; }
  canvas { display: block; width: 100%; height: 100%; touch-action: none; }
  /* The composed map's box over the canvas; around it, beside opened settings, the canvas is dimmed. */
  .frame { position: absolute; transform-origin: 0 0; pointer-events: none; }
  .frame.inset { box-shadow: 0 0 0 200vmax rgb(32 40 32 / 0.3); }
  .map-label { pointer-events: auto; position: absolute; display: flex; align-items: center; justify-content: center; transform: translate(-50%, -50%); border: 1px solid transparent; padding: 0; background: transparent; font-family: inherit; font-weight: normal; touch-action: none; cursor: move; white-space: nowrap; }
  .map-label:focus-visible { border-color: currentColor; }
  .map-mark { pointer-events: auto; position: absolute; transform: translate(-50%, -50%); border: 1px solid transparent; padding: 0; background: transparent; font-family: inherit; line-height: 0; touch-action: none; cursor: move; }
  .map-mark:focus-visible { border-color: currentColor; }
  .map-mark svg { display: block; overflow: visible; fill: currentColor; }
  .map-mark text { text-anchor: middle; dominant-baseline: middle; }
  .compass text { font-weight: bold; }
  @media (max-width: 750px) { .map-label { min-width: 44px; min-height: 44px; } }
</style>
