declare module '@echogarden/rnnoise-wasm' {
  interface RNNoiseModule {
    _rnnoise_create(model: number): number;
    _rnnoise_destroy(state: number): void;
    _rnnoise_process_frame(state: number, out: number, input: number): number;
    _rnnoise_get_frame_size(): number;
    _rnnoise_get_size(): number;
    _malloc(size: number): number;
    _free(ptr: number): void;
    HEAPF32: Float32Array;
  }

  function RNNoise(): Promise<RNNoiseModule>;
  export default RNNoise;
}
