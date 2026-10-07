import { WireCollection } from 'w-gl';

// The pinned 0.21 renderer exposes interleaved 2D uniform-color buffers.
export class OwnedWireCollection extends WireCollection {
  constructor(positions: Float32Array, width = 1) {
    super(0, { width, allowColors: false, is3D: false });
    this.positions = positions;
    this.buffer = positions.buffer as ArrayBuffer;
    this.count = this.capacity = positions.length / 4;
    this.isDirtyBuffer = true;
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
