import { WireCollection } from 'w-gl';
import type { Camera, RoadRank } from './domain.ts';
import { geometryBounds } from './visibility.ts';

type Program = { dispose(): void; release?(): void };
const program = (collection: WireCollection) => collection as unknown as { _program?: Program | null };

// The pinned 0.21 renderer exposes interleaved 2D uniform-color buffers.
export class OwnedWireCollection extends WireCollection {
  readonly rank: RoadRank;
  /** The live map region this geometry belongs to; a region's collections are removed together. */
  readonly owner?: string;
  /** Hidden road classes are neither drawn nor uploaded until shown. */
  hidden = false;
  readonly bounds: Camera;
  lastSeen = 0;
  private readonly visible?: (collection: OwnedWireCollection) => boolean;
  constructor(positions: Float32Array, width = 1, rank: RoadRank = 0, owner?: string, visible?: (collection: OwnedWireCollection) => boolean) {
    super(0, { width, allowColors: false, is3D: false });
    this.positions = positions;
    this.buffer = positions.buffer as ArrayBuffer;
    this.count = this.capacity = positions.length / 4;
    this.isDirtyBuffer = true;
    this.rank = rank;
    this.owner = owner;
    this.bounds = geometryBounds(positions);
    this.visible = visible;
  }

  override draw(gl: WebGLRenderingContext, drawContext: unknown) {
    if (!this.hidden && (!this.visible || this.visible(this))) super.draw(gl, drawContext);
  }

  get resident() { return !!program(this)._program; }

  override dispose() {
    // Its published dispose drops this program without calling the allocation disposer.
    program(this)._program?.dispose();
    super.dispose();
    this.empty();
  }

  /**
   * Frees this collection's GPU buffers while the scene lives on. dispose() would also delete
   * the shader program every other collection shares; renderer-compat adds release().
   */
  release() {
    this.releaseGPU();
    this.empty();
  }

  /** Drops only GPU residency; cached coordinates can be uploaded again without fetching. */
  releaseGPU() {
    program(this)._program?.release?.();
    program(this)._program = null;
    this.isDirtyBuffer = true;
  }

  private empty() {
    this.positions = new Float32Array();
    this.buffer = this.positions.buffer as ArrayBuffer;
    this.count = this.capacity = 0;
  }
}
