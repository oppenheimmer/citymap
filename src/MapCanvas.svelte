<script lang="ts">
  import { onMount } from 'svelte';
  import type { Camera, Design, Geometry, LoadProgress } from './lib/domain.ts';
  import type { SceneController } from './lib/SceneController.ts';
  import { loadCity } from './lib/load-city.ts';
  import type { WorkerLoad } from './lib/worker-protocol.ts';
  let { runId, options, design, onready, onerror, onlarge, onprogress, onlabel, oncamera }: {
    runId: number; options: WorkerLoad & { forceNetwork?: boolean }; design: Design;
    onready: (controller: SceneController, geometry: Geometry, firstFrameMs: number, totalMs: number, runId: number) => void;
    onerror: (message: string, runId: number) => void; onlarge: (bytes: number, runId: number) => void;
    onprogress: (progress: LoadProgress, runId: number) => void;
    onlabel: (label: Design['label']) => void; oncamera: (camera: Camera, runId: number) => void;
  } = $props();
  let canvas: HTMLCanvasElement;
  let host: HTMLDivElement;
  let controller: SceneController | undefined;
  let dragging = false;
  let drawable = $state(false);
  onMount(() => {
    let disposed = false;
    const id = runId;
    const started = performance.now();
    let firstFrameMs = 0;
    const module = import('./lib/SceneController.ts');
    const stop = loadCity(options, {
      progress: progress => { if (!disposed) onprogress(progress, id); },
      chunk: async (positions, bounds) => {
        const { SceneController } = await module;
        if (disposed) return;
        if (!controller) {
          const geometry: Geometry = { buffers: [], bounds, segmentCount: 0, source: { kind: 'live', downloadedAt: '', complete: false } };
          controller = new SceneController(canvas, geometry, design, camera => { if (!disposed) oncamera(camera, id); });
          drawable = true;
        }
        onprogress({ stage: 'draw', message: 'Drawing road geometry…' }, id);
        const frameAt = await controller.appendGeometry(positions);
        if (!firstFrameMs && frameAt !== undefined) firstFrameMs = frameAt - started;
      },
      done: async geometry => {
        if (disposed || !controller) return;
        controller.geometry.source = geometry.source;
        await new Promise(requestAnimationFrame);
        if (!disposed) onready(controller, geometry, firstFrameMs, performance.now() - started, id);
      },
      error: message => { if (!disposed) { canvas.removeEventListener('webglcontextlost', lost); controller?.dispose(); controller = undefined; drawable = false; onerror(message, id); } },
      large: bytes => { if (!disposed) onlarge(bytes, id); },
    });
    const lost = (event: Event) => { event.preventDefault(); if (!disposed) { stop(); controller?.dispose(); drawable = false; onerror('WebGL context lost. Reload this map to recover.', id); } };
    canvas.addEventListener('webglcontextlost', lost);
    return () => { disposed = true; stop(); canvas.removeEventListener('webglcontextlost', lost); controller?.dispose(); };
  });
  $effect(() => { if (drawable) controller?.setSettings(design); });
  function move(event: PointerEvent) {
    if (!dragging) return;
    const rect = host.getBoundingClientRect();
    onlabel({ ...design.label, x: Math.max(0.05, Math.min(0.95, (event.clientX - rect.left) / rect.width)), y: Math.max(0.05, Math.min(0.95, (event.clientY - rect.top) / rect.height)) });
  }
  function key(event: KeyboardEvent) {
    const amount = event.shiftKey ? 0.05 : 0.01;
    const delta = { ArrowLeft: [-amount, 0], ArrowRight: [amount, 0], ArrowUp: [0, -amount], ArrowDown: [0, amount] }[event.key];
    if (!delta) return;
    event.preventDefault();
    onlabel({ ...design.label, x: Math.max(0.05, Math.min(0.95, design.label.x + delta[0])), y: Math.max(0.05, Math.min(0.95, design.label.y + delta[1])) });
  }
</script>

<div class="map" bind:this={host}>
  <canvas bind:this={canvas} tabindex="0" aria-label="Road map. Drag to pan; scroll or use map controls to zoom."></canvas>
  {#if drawable}
    <button class="map-label" style:left={`${design.label.x * 100}%`} style:top={`${design.label.y * 100}%`} style:color={design.label.color} style:opacity={design.label.opacity} style:font-size={`${design.label.size}px`} aria-label="Move map label with arrow keys or drag"
      onpointerdown={event => { dragging = true; event.currentTarget.setPointerCapture(event.pointerId); }} onpointermove={move} onpointerup={() => { dragging = false; }} onpointercancel={() => { dragging = false; }} onkeydown={key}>{design.label.text}</button>
    <a class="attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>
  {/if}
</div>
<style>
  .map { position: relative; width: 100%; height: 100%; overflow: hidden; background: repeating-conic-gradient(#f5f5f2 0 25%, #e3e6de 0 50%) 50% / 16px 16px; }
  canvas { display: block; width: 100%; height: 100%; touch-action: none; }
  .map-label { position: absolute; transform: translate(-50%, -50%); border: 1px solid transparent; padding: 0; background: transparent; font-family: sans-serif; font-weight: normal; touch-action: none; cursor: move; white-space: nowrap; }
  .map-label:focus-visible { border-color: currentColor; }
  .attribution { position: absolute; right: 3%; top: 97%; transform: translateY(-50%); font: 12px sans-serif; color: #303030; white-space: nowrap; text-shadow: 1px 1px #fff, -1px 1px #fff, 1px -1px #fff, -1px -1px #fff; }
</style>
