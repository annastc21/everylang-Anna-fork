export interface LocalTranscriberOptions {
  baseUrl: string;
  model: string;
  onText: (text: string) => void;
  language?: string;
  voiceThresholdDbfs?: number;
  endSilenceMs?: number;
  maxChunkMs?: number;
  minChunkMs?: number;
  sampleRate?: number;
  fetchFn?: typeof fetch;
  onError?: (error: unknown) => void;
}

export function toWav(samples: Int16Array, sampleRate: number = 16_000): Blob {
  const dataLength = samples.length * Int16Array.BYTES_PER_ELEMENT;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * Int16Array.BYTES_PER_ELEMENT, true);
  view.setUint16(32, Int16Array.BYTES_PER_ELEMENT, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, dataLength, true);

  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * Int16Array.BYTES_PER_ELEMENT, samples[i], true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

export class LocalTranscriber {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly onText: (text: string) => void;
  private readonly language: string | undefined;
  private readonly voiceThresholdDbfs: number;
  private readonly endSilenceMs: number;
  private readonly maxChunkMs: number;
  private readonly minChunkMs: number;
  private readonly sampleRate: number;
  private readonly fetchFn: typeof fetch;
  private readonly onError: ((error: unknown) => void) | undefined;

  private frames: Int16Array[] = [];
  private chunkDurationMs: number = 0;
  private voicedDurationMs: number = 0;
  private quietDurationMs: number = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: LocalTranscriberOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.onText = options.onText;
    this.language = options.language;
    this.voiceThresholdDbfs = options.voiceThresholdDbfs ?? -40;
    this.endSilenceMs = options.endSilenceMs ?? 600;
    this.maxChunkMs = options.maxChunkMs ?? 15_000;
    this.minChunkMs = options.minChunkMs ?? 300;
    this.sampleRate = options.sampleRate ?? 16_000;
    this.fetchFn = options.fetchFn ?? fetch;
    this.onError = options.onError;
  }

  push(frame: Int16Array, dbfs: number): void {
    const frameDurationMs = (frame.length / this.sampleRate) * 1_000;
    const isVoice = dbfs >= this.voiceThresholdDbfs;

    if (this.frames.length === 0 && !isVoice) return;

    this.frames.push(new Int16Array(frame));
    this.chunkDurationMs += frameDurationMs;
    if (isVoice) {
      this.voicedDurationMs += frameDurationMs;
      this.quietDurationMs = 0;
    } else {
      this.quietDurationMs += frameDurationMs;
    }

    if (this.quietDurationMs >= this.endSilenceMs || this.chunkDurationMs >= this.maxChunkMs) {
      this.closeChunk();
    }
  }

  async flush(): Promise<void> {
    if (this.frames.length > 0) this.closeChunk();
    await this.queue;
  }

  private closeChunk(): void {
    const frames = this.frames;
    const voicedDurationMs = this.voicedDurationMs;
    this.frames = [];
    this.chunkDurationMs = 0;
    this.voicedDurationMs = 0;
    this.quietDurationMs = 0;

    if (voicedDurationMs < this.minChunkMs) return;

    const samples = new Int16Array(frames.reduce((length, frame) => length + frame.length, 0));
    let offset = 0;
    for (const frame of frames) {
      samples.set(frame, offset);
      offset += frame.length;
    }

    this.queue = this.queue.then(() => this.transcribe(samples)).catch((error: unknown) => {
      this.reportError(error);
    });
  }

  private async transcribe(samples: Int16Array): Promise<void> {
    const form = new FormData();
    form.append("file", toWav(samples, this.sampleRate), "audio.wav");
    form.append("model", this.model);
    form.append("response_format", "json");
    if (this.language !== undefined) form.append("language", this.language);

    const response = await this.fetchFn(`${this.baseUrl}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
    });
    if (!response.ok) {
      throw new Error(`Local transcription request failed with HTTP ${response.status}`);
    }

    const result: unknown = await response.json();
    if (typeof result !== "object" || result === null || !("text" in result) || typeof result.text !== "string") {
      throw new Error("Local transcription response did not contain a text string");
    }

    const text = result.text.trim();
    if (text) this.onText(`${text} `);
  }

  private reportError(error: unknown): void {
    if (!this.onError) {
      console.warn("[LocalTranscriber] Transcription failed:", error);
      return;
    }
    try {
      this.onError(error);
    } catch (callbackError) {
      console.warn("[LocalTranscriber] Error callback failed:", callbackError);
    }
  }
}
