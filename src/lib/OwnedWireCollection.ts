import { WireCollection } from 'w-gl';
import type { RoadRank } from './domain.ts';

// The pinned 0.21 renderer exposes interleaved 2D uniform-color buffers.
export class OwnedWireCollection extends WireCollection {
  readonly rank: RoadRank;
  /** Hidden road classes are neither drawn nor uploaded until shown. */
  hidden = false;
  constructor(positions: Float32Array, width = 1, rank: RoadRank = 0) {
    super(0, { width, allowColors: false, is3D: false });
    this.positions = positions;
    this.buffer = positions.buffer as ArrayBuffer;
    this.count = this.capacity = positions.length / 4;
    this.isDirtyBuffer = true;
    this.rank = rank;
  }

  override draw(gl: WebGLRenderingContext, drawContext: unknown) {
    if (!this.hidden) super.draw(gl, drawContext);
  }

  override dispose() {
    // Its published dispose drops this program without calling the allocation disposer.
    const allocation = (this as unknown as { _program?: { dispose(): void } })._program;
    allocation?.dispose();
    super.dispose();
    this.positions = new Float32Array();
    this.buffer = this.positions.buffer as ArrayBuffer;
    this.count = this.capacity = 0;
  }
}
