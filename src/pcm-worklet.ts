// AudioWorklet 内で動くコード。タブ音声をモノラル・24kHz・PCM16 に変換し、
// 一定長（既定100ms）ごとにメインスレッドへ渡す。

declare const sampleRate: number;
declare function registerProcessor(name: string, processorCtor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

type ProcessorOptions = { targetRate: number; chunkMs: number };

class PcmProcessor extends AudioWorkletProcessor {
  private readonly ratio: number;
  private readonly chunk: Int16Array;
  private length = 0;
  private sumSquares = 0;
  // 入力ストリーム上の次の読み取り位置（小数）。-1 は前ブロック末尾のサンプルを指す。
  private position = 0;
  private previous = 0;
  private lastRaw = 0;
  private mono = new Float32Array(128);

  constructor(options: { processorOptions: ProcessorOptions }) {
    super();
    const { targetRate, chunkMs } = options.processorOptions;
    this.ratio = sampleRate / targetRate;
    this.chunk = new Int16Array(Math.round((targetRate * chunkMs) / 1000));
  }

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const frames = channels[0].length;

    // 音声スレッドで GC を起こさないよう、バッファは使い回す。
    if (this.mono.length !== frames) this.mono = new Float32Array(frames);
    const mono = this.mono;
    mono.fill(0);
    for (const channel of channels) {
      for (let i = 0; i < frames; i++) mono[i] += channel[i] / channels.length;
    }
    // 間引きによる折り返しを抑えるため、隣り合う2サンプルの平均で高域を落とす。
    for (let i = 0; i < frames; i++) {
      const raw = mono[i];
      mono[i] = (raw + this.lastRaw) / 2;
      this.lastRaw = raw;
    }

    // 線形補間でリサンプリングする。
    while (this.position <= frames - 1) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const s0 = index < 0 ? this.previous : mono[index];
      const s1 = mono[index + 1] ?? s0;
      this.push(s0 + (s1 - s0) * fraction);
      this.position += this.ratio;
    }
    this.position -= frames;
    this.previous = mono[frames - 1];
    return true;
  }

  private push(sample: number): void {
    const clamped = Math.max(-1, Math.min(1, sample));
    this.chunk[this.length++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    this.sumSquares += clamped * clamped;
    if (this.length < this.chunk.length) return;

    const pcm = this.chunk.slice().buffer;
    const rms = Math.sqrt(this.sumSquares / this.length);
    this.port.postMessage({ pcm, rms }, [pcm]);
    this.length = 0;
    this.sumSquares = 0;
  }
}

registerProcessor("kotodama-pcm", PcmProcessor);

export {};
