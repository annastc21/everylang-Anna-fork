import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { readTranscriptSegments } from "../src/transcriptKeys.ts";
import { TranscriptSegmentLog } from "./transcript-log.ts";
import { LocalTranscriber, toWav } from "./local-transcriber.ts";

const sampleRate = 16_000;
const frame = new Int16Array(1_600).fill(1_000);
const speechDbfs = -20;
const quietDbfs = -60;

function response(text: string, status: number = 200): Response {
  return new Response(JSON.stringify({ text }), { status });
}

function createTranscriber(
  fetchFn: typeof fetch,
  onText: (text: string) => void = () => {},
  onError: (error: unknown) => void = () => {},
  options: { maxChunkMs?: number; minChunkMs?: number } = {}
): LocalTranscriber {
  return new LocalTranscriber({
    baseUrl: "http://localhost:8080/",
    model: "whisper-test",
    onText,
    onError,
    fetchFn,
    sampleRate,
    endSilenceMs: 300,
    maxChunkMs: options.maxChunkMs,
    minChunkMs: options.minChunkMs,
  });
}

function pushSpeechAndSilence(transcriber: LocalTranscriber): void {
  for (let i = 0; i < 3; i++) transcriber.push(frame, speechDbfs);
  for (let i = 0; i < 3; i++) transcriber.push(new Int16Array(frame.length), quietDbfs);
}

describe("LocalTranscriber", () => {
  it("sends a voiced chunk after enough silence and appends a trailing space", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => response("  recognized words  "));
    const onText = vi.fn();
    const transcriber = createTranscriber(fetchFn, onText);

    pushSpeechAndSilence(transcriber);
    await transcriber.flush();

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(onText).toHaveBeenCalledWith("recognized words ");
  });

  it("does not send silence-only frames", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => response("ignored"));
    const transcriber = createTranscriber(fetchFn);

    for (let i = 0; i < 10; i++) transcriber.push(new Int16Array(frame.length), quietDbfs);
    await transcriber.flush();

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("drops chunks with voiced duration shorter than the minimum", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => response("too short"));
    const transcriber = createTranscriber(fetchFn);

    transcriber.push(frame, speechDbfs);
    transcriber.push(frame, speechDbfs);
    for (let i = 0; i < 3; i++) transcriber.push(new Int16Array(frame.length), quietDbfs);
    await transcriber.flush();

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("splits continuous speech at max duration and delivers results in order", async () => {
    const onText = vi.fn();
    let calls = 0;
    const fetchFn = vi.fn<typeof fetch>(async () => {
      calls++;
      if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 20));
      return response(`chunk ${calls}`);
    });
    const transcriber = createTranscriber(fetchFn, onText, undefined, { maxChunkMs: 300 });

    for (let i = 0; i < 9; i++) transcriber.push(frame, speechDbfs);
    await transcriber.flush();

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(onText.mock.calls).toEqual([["chunk 1 "], ["chunk 2 "], ["chunk 3 "]]);
  });

  it("reports non-OK responses and continues with subsequent chunks", async () => {
    const onText = vi.fn();
    const onError = vi.fn();
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response("", 503))
      .mockResolvedValueOnce(response("later chunk"));
    const transcriber = createTranscriber(fetchFn, onText, onError);

    pushSpeechAndSilence(transcriber);
    pushSpeechAndSilence(transcriber);
    await transcriber.flush();

    expect(onError).toHaveBeenCalledOnce();
    expect(onText).toHaveBeenCalledWith("later chunk ");
  });

  it("sends requests to the OpenAI-compatible endpoint and includes the form fields", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => response("ok"));
    const transcriber = createTranscriber(fetchFn);

    pushSpeechAndSilence(transcriber);
    await transcriber.flush();

    expect(fetchFn).toHaveBeenCalledWith(
      "http://localhost:8080/v1/audio/transcriptions",
      expect.objectContaining({ method: "POST" })
    );
    const body = fetchFn.mock.calls[0][1]?.body;
    expect(body).toBeInstanceOf(FormData);
    if (!(body instanceof FormData)) throw new Error("Expected multipart form data");
    expect(body.get("model")).toBe("whisper-test");
    expect(body.get("response_format")).toBe("json");
    expect(body.get("file")).toBeInstanceOf(Blob);
  });
});

describe("toWav", () => {
  it("writes a 44-byte PCM16 mono WAV header with the sample rate and data length", async () => {
    const wav = toWav(new Int16Array([1, -2, 300]), sampleRate);
    const bytes = new Uint8Array(await wav.arrayBuffer());
    const view = new DataView(bytes.buffer);

    expect(wav.type).toBe("audio/wav");
    expect(bytes.byteLength).toBe(44 + 3 * Int16Array.BYTES_PER_ELEMENT);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(sampleRate);
    expect(view.getUint32(40, true)).toBe(6);
  });
});

describe("LocalTranscriber with TranscriptSegmentLog", () => {
  it("writes local text into Yjs and starts a new segment after a sentence-ending chunk", async () => {
    const doc = new Y.Doc();
    const log = new TranscriptSegmentLog(doc);
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response("First sentence."))
      .mockResolvedValueOnce(response("Second sentence."));
    const transcriber = createTranscriber(fetchFn, (text) => log.append("en", text));

    pushSpeechAndSilence(transcriber);
    pushSpeechAndSilence(transcriber);
    await transcriber.flush();

    const segments = doc.getArray<Y.Map<unknown>>("liveTranscriptSegments-en");
    expect(segments.length).toBe(2);
    expect(readTranscriptSegments(doc, "en").map((segment) => segment.text)).toEqual([
      "First sentence.",
      "Second sentence.",
    ]);
  });
});
