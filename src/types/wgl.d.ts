declare module 'w-gl' {
  export interface ViewBox { left: number; right: number; top: number; bottom: number }
  export interface Scene {
    appendChild(child: WireCollection): void;
    setViewBox(box: ViewBox): void;
    setClearColor(r: number, g: number, b: number, a: number): void;
    setPixelRatio(ratio: number): void;
    getPixelRatio(): number;
    getGL(): WebGLRenderingContext;
    getSceneCoordinate(x: number, y: number): [number, number, number];
    getDrawContext(): { width: number; height: number };
    getCameraController(): { zoomCenterByScaleFactor(scale: number, dx: number, dy: number): void; redraw(): void };
    on(name: string, callback: () => void): void;
    off(name: string, callback: () => void): void;
    renderFrame(immediate?: boolean): void;
    dispose(): void;
  }
  export class WireCollection {
    constructor(capacity: number, options: { width: number; allowColors: boolean; is3D: boolean });
    add(line: { from: { x: number; y: number }; to: { x: number; y: number } }): void;
    color: { r: number; g: number; b: number; a: number };
    positions: Float32Array;
    buffer: ArrayBuffer;
    count: number;
    capacity: number;
    width: number;
    isDirtyBuffer: boolean;
    dispose(): void;
  }
  export function createScene(canvas: HTMLCanvasElement, options?: { devicePixelRatio?: number; allowRotation?: boolean; allowPinchRotation?: boolean; size?: { width: number; height: number }; wglContextOptions?: WebGLContextAttributes }): Scene;
}
