// offscreen document。タブ音声の取り込み、Realtime API への送信、翻訳を担当する。
// service worker はアイドル時に止まるので、長く続く処理はすべてここに置く。
// offscreen では chrome.runtime 以外の拡張APIを使えないため、設定は background から受け取る。

import { createClientSecret, OpenAIError, openRealtimeSocket, SAMPLE_RATE, translateDraft, translateSentences, type TranslationPair } from "./openai";
import type { CaptionLine, FromContent, FromOffscreen, OffscreenInit, Settings, ToContent } from "./shared";

const CHUNK_MS = 100;
/** 声とみなす音量の下限と上限。実際のしきい値は直近の背景音から決める。 */
const MIN_SPEECH_RMS = 0.003;
const MAX_SPEECH_RMS = 0.05;
/** 背景音の何倍を声とみなすか。 */
const SPEECH_OVER_FLOOR = 3;
/** 背景音の推定に使う期間（チャンク数）。 */
const FLOOR_WINDOW_CHUNKS = 30;
/** 発話のあと、この時間だけ静かになったら区切る。 */
const SILENCE_TO_COMMIT_MS = 500;
/** 短すぎる区切りは作らない。 */
const MIN_SEGMENT_MS = 1000;
/** 発話の頭が切れないよう、声を検出する直前の音声も送る。 */
const PRE_ROLL_CHUNKS = 3;
/** 一時停止などで音声が届かなくなったら、この時間で区切る。 */
const STALL_TO_COMMIT_MS = 600;
const HISTORY_SIZE = 3;
/** 文の途中で止まった英文は、続きが来ないままこの時間たったら訳す。 */
const HOLD_REMAINDER_MS = 2500;
/** 話し続けていても、英文をこれ以上は待たせない。 */
const MAX_HOLD_MS = 10_000;
/** 未翻訳の英文がこの長さを超えたら、文の途中でも訳す。 */
const MAX_PENDING_CHARS = 400;
/** 仮の訳を作り直す間隔。 */
const DRAFT_INTERVAL_MS = 1200;
/** これより短い英文は、仮の訳を作らない。 */
const DRAFT_MIN_CHARS = 12;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

let settings: Settings;
let tabId = -1;
let socket: WebSocket | undefined;
let socketReady = false;
let reconnectAttempt = 0;

function post(payload: ToContent): void {
  const message: FromOffscreen = { target: "background", type: "relay", tabId, payload };
  chrome.runtime.sendMessage(message).catch(() => undefined);
}

function postError(message: string, fatal = false): void {
  console.error("[Kotodama]", message);
  post({ type: "kotodama:status", state: "error", message, fatal });
}

function isAuthError(error: unknown): boolean {
  return error instanceof OpenAIError && (error.status === 401 || error.status === 403);
}

// ---------- 字幕の管理 ----------
// 音声の区切り（commit）は機械的なので、文の途中で切れる。文字起こし結果は「未翻訳の英文」にためて、
// 翻訳時に文の単位へ直し、完結した文だけを字幕にする。

type Segment = { seq: number; text: string; done: boolean };
/** 未翻訳の英文のひとかたまりと、それが話された時刻の範囲。 */
type Piece = { text: string; start: number; end: number };

let nextSegmentSeq = 0;
let nextToConsume = 0;
const segmentsByItem = new Map<string, Segment>();
const segmentsBySeq = new Map<number, Segment>();
/** 文字起こしが完了し、まだ字幕になっていない英文。 */
let pendingPieces: Piece[] = [];
/** 音声の区切りごとの時刻。文字起こしの区切り（Segment.seq）とは順番で対応させる。 */
const audioTimes = new Map<number, { start: number; end: number }>();
let audioSeq = 0;
let audioBase = 0;
let translating = false;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let heldSince = 0;
let captionSeq = 0;
const history: TranslationPair[] = [];

function joinText(...parts: string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join(" ");
}

function segmentFor(itemId: string): Segment {
  let segment = segmentsByItem.get(itemId);
  if (!segment) {
    segment = { seq: nextSegmentSeq++, text: "", done: false };
    segmentsByItem.set(itemId, segment);
    segmentsBySeq.set(segment.seq, segment);
  }
  return segment;
}

/** 完了は順不同で届くので、区切りの順番どおりに未翻訳の英文へつなげる。 */
function consumeCompleted(): void {
  for (;;) {
    const segment = segmentsBySeq.get(nextToConsume);
    if (!segment?.done) return;
    segmentsBySeq.delete(nextToConsume);
    nextToConsume += 1;
    const times = audioTimes.get(segment.seq + audioBase) ?? { start: Date.now(), end: Date.now() };
    audioTimes.delete(segment.seq + audioBase);
    if (segment.text) pendingPieces.push({ text: segment.text, ...times });
  }
}

function textOf(pieces: Piece[]): string {
  return joinText(...pieces.map((piece) => piece.text));
}

/** 英文の先頭から offset 文字目が話された時刻を、文字数の割合で見積もる。 */
function timeAt(pieces: Piece[], offset: number): number {
  let position = 0;
  for (const piece of pieces) {
    const length = piece.text.length;
    if (offset <= position + length) {
      const fraction = length > 0 ? Math.max(0, offset - position) / length : 0;
      return piece.start + (piece.end - piece.start) * fraction;
    }
    position += length + 1;
  }
  return pieces.at(-1)?.end ?? Date.now();
}

function hasSegmentInProgress(): boolean {
  return segmentsBySeq.size > 0;
}

/** 字幕になる前の英文（未翻訳の英文＋文字起こし中の英文）。 */
function postLive(): void {
  const inProgress = [...segmentsBySeq.values()].sort((a, b) => a.seq - b.seq).map((segment) => segment.text);
  liveText = joinText(textOf(pendingPieces), ...inProgress);
  post({ type: "kotodama:live", text: liveText });
  scheduleDraft();
}

// ---------- 仮の訳 ----------
// 文が完結するのを待たず、話している途中の英文をその都度訳して見せる。確定の訳とは別に作る。

let liveText = "";
let draftSource = "";
let draftBusy = false;
let draftStartedAt = 0;
let draftTimer: ReturnType<typeof setTimeout> | undefined;
/** 確定の訳が出るたびに増やす。古い英文から作った仮の訳を捨てるために使う。 */
let draftVersion = 0;

function clearDraft(): void {
  draftVersion += 1;
  draftSource = "";
  post({ type: "kotodama:draft", text: "" });
}

function scheduleDraft(): void {
  if (draftBusy || draftTimer !== undefined || liveText === draftSource) return;
  const wait = Math.max(0, DRAFT_INTERVAL_MS - (Date.now() - draftStartedAt));
  draftTimer = setTimeout(() => void runDraft(), wait);
}

async function runDraft(): Promise<void> {
  draftTimer = undefined;
  const text = liveText;
  if (text === draftSource) return;
  if (text.length < DRAFT_MIN_CHARS) {
    if (!text) clearDraft();
    return;
  }
  draftBusy = true;
  draftStartedAt = Date.now();
  const version = draftVersion;
  try {
    const ja = await translateDraft(settings.apiKey, settings.draftModel, text, history);
    if (version === draftVersion && ja) post({ type: "kotodama:draft", text: ja });
  } catch (error) {
    // 仮の訳は失敗しても確定の訳で補えるので、知らせない。
    console.warn("[Kotodama] draft failed", describe(error));
  } finally {
    // 失敗した英文で繰り返さないよう、成否にかかわらず「訳した」ことにする。
    if (version === draftVersion) draftSource = text;
    draftBusy = false;
    scheduleDraft();
  }
}

function onTranscriptDelta(itemId: string, delta: string): void {
  const segment = segmentFor(itemId);
  if (segment.done) return;
  segment.text += delta;
  postLive();
}

function finishSegment(itemId: string, text: string): void {
  const segment = segmentFor(itemId);
  segmentsByItem.delete(itemId);
  segment.text = text.trim();
  segment.done = true;
  consumeCompleted();
  postLive();
}

function onTranscriptCompleted(itemId: string, transcript: string): void {
  finishSegment(itemId, transcript);
  void pumpTranslations();
}

function dropSegment(itemId: string): void {
  finishSegment(itemId, "");
}

function showCaption(unit: TranslationPair, at: number): void {
  post({ type: "kotodama:caption", line: { seq: captionSeq++, en: unit.en, ja: unit.ja, at } });
  if (unit.ja === unit.en) return;
  history.push(unit);
  if (history.length > HISTORY_SIZE) history.shift();
}

/** 文脈を正しく渡すため、翻訳は1回ずつ順番に行う。 */
async function pumpTranslations(force = false): Promise<void> {
  if (translating || pendingPieces.length === 0) return;
  clearTimeout(flushTimer);
  if (force) heldSince = 0;
  translating = true;
  const pieces = pendingPieces;
  pendingPieces = [];
  const text = textOf(pieces);
  let remainder: Piece | undefined;
  try {
    const result = await translateSentences(
      settings.apiKey,
      settings.translateModel,
      text,
      history,
      force || text.length > MAX_PENDING_CHARS,
    );
    if (result.units.length > 0) clearDraft();
    let cursor = 0;
    for (const unit of result.units) {
      showCaption(unit, timeAt(pieces, cursor));
      cursor += unit.en.length + 1;
    }
    if (result.remainder) {
      const start = timeAt(pieces, Math.max(0, text.length - result.remainder.length));
      remainder = { text: result.remainder, start, end: pieces.at(-1)?.end ?? start };
    }
  } catch (error) {
    // 訳せなかった英文は、英語のまま字幕にする。
    clearDraft();
    showCaption({ en: text, ja: text }, pieces[0].start);
    postError(`翻訳に失敗しました: ${describe(error)}`, isAuthError(error));
  } finally {
    translating = false;
  }

  const arrivedMeanwhile = pendingPieces.length > 0;
  if (remainder) pendingPieces.unshift(remainder);
  postLive();
  if (pendingPieces.length === 0) {
    heldSince = 0;
    return;
  }
  if (arrivedMeanwhile) {
    void pumpTranslations();
    return;
  }
  scheduleFlush();
}

/** 文の途中で止まった英文は、続きを待ってから訳す。話し手が止まったら残りも訳す。 */
function scheduleFlush(): void {
  if (!heldSince) heldSince = Date.now();
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    const stillTalking = speaking || hasSegmentInProgress();
    if (stillTalking && Date.now() - heldSince < MAX_HOLD_MS) {
      scheduleFlush();
      return;
    }
    void pumpTranslations(true);
  }, HOLD_REMAINDER_MS);
}

// ---------- Realtime API ----------

type ServerEvent = {
  type: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string; code?: string };
};

function handleServerEvent(event: ServerEvent): void {
  switch (event.type) {
    case "conversation.item.input_audio_transcription.delta":
      if (event.item_id && event.delta) onTranscriptDelta(event.item_id, event.delta);
      break;
    case "conversation.item.input_audio_transcription.completed":
      if (event.item_id) onTranscriptCompleted(event.item_id, event.transcript ?? "");
      break;
    case "input_audio_buffer.committed":
      if (event.item_id) segmentFor(event.item_id);
      break;
    case "conversation.item.input_audio_transcription.failed":
      if (event.item_id) dropSegment(event.item_id);
      postError(`文字起こしに失敗しました: ${event.error?.message ?? "不明なエラー"}`);
      break;
    case "error":
      postError(`Realtime API: ${event.error?.message ?? "不明なエラー"}`);
      break;
    default:
      console.debug("[Kotodama] event", event.type);
  }
}

async function connect(): Promise<void> {
  post({ type: "kotodama:status", state: "connecting" });
  const secret = await createClientSecret(settings.apiKey, settings.transcribeModel);
  const ws = openRealtimeSocket(secret);
  let opened = false;
  socket = ws;

  ws.onopen = () => {
    opened = true;
    socketReady = true;
    reconnectAttempt = 0;
    resetSegment();
    // 張り直す前の区切りは捨てたので、音声の区切りと文字起こしの区切りの対応を取り直す。
    audioBase = audioSeq - nextSegmentSeq;
    post({ type: "kotodama:status", state: "listening" });
  };
  ws.onmessage = (message) => {
    try {
      handleServerEvent(JSON.parse(String(message.data)) as ServerEvent);
    } catch (error) {
      console.error("[Kotodama] bad event", error);
    }
  };
  ws.onclose = (event) => {
    socketReady = false;
    if (socket !== ws) return;
    // 完了待ちだった区切りは、もう結果が来ないので捨てる。
    for (const itemId of [...segmentsByItem.keys()]) dropSegment(itemId);
    console.warn("[Kotodama] socket closed", event.code, event.reason, { opened });
    scheduleReconnect(`接続が切れました（code ${event.code} ${event.reason}）`);
  };
}

/** セッションの上限時間や回線の瞬断で切れるので、間隔を広げながら張り直す。認証エラーは諦める。 */
function scheduleReconnect(reason: string): void {
  const delay = RECONNECT_DELAYS_MS[reconnectAttempt];
  if (delay === undefined) {
    postError(`Realtime API に接続できません: ${reason}`, true);
    return;
  }
  reconnectAttempt += 1;
  setTimeout(() => {
    connect().catch(onConnectError);
  }, delay);
}

function onConnectError(error: unknown): void {
  if (isAuthError(error)) {
    postError(`Realtime API に接続できませんでした: ${describe(error)}`, true);
    return;
  }
  scheduleReconnect(describe(error));
}

function send(event: object): void {
  if (socket && socketReady) socket.send(JSON.stringify(event));
}

// ---------- 区切り（クライアント側 VAD） ----------

let segmentMs = 0;
let silenceMs = 0;
let speaking = false;
let preRoll: ArrayBuffer[] = [];
let lastChunkAt = 0;
let segmentStartAt = 0;
/** 聞き取り済みの区間を再生しているあいだは true。音声を送らない。 */
let gated = false;

chrome.runtime.onMessage.addListener((message: FromContent, sender) => {
  if (message?.type !== "kotodama:gate" || sender.tab?.id !== tabId) return;
  gated = message.skip;
  // 巻き戻した時点までの音声は、ここで区切って訳に回す。
  if (gated && speaking) commit();
});
const recentRms: number[] = [];

function resetSegment(): void {
  segmentMs = 0;
  silenceMs = 0;
  speaking = false;
  preRoll = [];
}

function commit(): void {
  audioTimes.set(audioSeq++, { start: segmentStartAt, end: Date.now() });
  send({ type: "input_audio_buffer.commit" });
  resetSegment();
}

function speechThreshold(): number {
  const floor = recentRms.length > 0 ? Math.min(...recentRms) : 0;
  return Math.min(MAX_SPEECH_RMS, Math.max(MIN_SPEECH_RMS, floor * SPEECH_OVER_FLOOR));
}

function appendAudio(pcm: ArrayBuffer): void {
  send({ type: "input_audio_buffer.append", audio: toBase64(pcm) });
  segmentMs += CHUNK_MS;
}

function onAudioChunk(pcm: ArrayBuffer, rms: number): void {
  lastChunkAt = performance.now();
  recentRms.push(rms);
  if (recentRms.length > FLOOR_WINDOW_CHUNKS) recentRms.shift();
  if (!socketReady || gated) return;
  const loud = rms >= speechThreshold();

  if (!speaking) {
    // 声が無いあいだは送らない（一時停止中や無音で課金しないため）。
    if (!loud) {
      preRoll.push(pcm);
      if (preRoll.length > PRE_ROLL_CHUNKS) preRoll.shift();
      return;
    }
    speaking = true;
    segmentStartAt = Date.now() - preRoll.length * CHUNK_MS;
    for (const chunk of preRoll) appendAudio(chunk);
    preRoll = [];
  }

  appendAudio(pcm);
  silenceMs = loud ? 0 : silenceMs + CHUNK_MS;

  const endedBySilence = silenceMs >= SILENCE_TO_COMMIT_MS && segmentMs >= MIN_SEGMENT_MS;
  const endedByLength = segmentMs >= settings.maxSegmentSeconds * 1000;
  if (endedBySilence || endedByLength) {
    commit();
    // 長さで区切った場合は話し続けているので、次の区切りもそのまま始める。
    if (endedByLength && loud) {
      speaking = true;
      segmentStartAt = Date.now();
    }
  }
}

// 一時停止で AudioWorklet に音声が届かなくなった場合に備えて、時間でも区切る。
setInterval(() => {
  if (speaking && segmentMs >= CHUNK_MS && performance.now() - lastChunkAt >= STALL_TO_COMMIT_MS) commit();
}, 200);

// ---------- 音声の取り込み ----------

async function startCapture(streamId: string): Promise<void> {
  const media = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
    } as MediaTrackConstraints,
    video: false,
  });
  const context = new AudioContext();
  const source = context.createMediaStreamSource(media);
  // 取り込むとタブの音が消えるので、取り込んだ音をそのまま再生し直す。
  source.connect(context.destination);

  await context.audioWorklet.addModule(chrome.runtime.getURL("pcm-worklet.js"));
  const node = new AudioWorkletNode(context, "kotodama-pcm", {
    processorOptions: { targetRate: SAMPLE_RATE, chunkMs: CHUNK_MS },
  });
  node.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
    onAudioChunk(event.data.pcm, event.data.rms);
  };
  source.connect(node);
  // 出力をつながないと処理されないことがあるため、無音の出力を destination へつなぐ。
  node.connect(context.destination);
  // ユーザー操作のない文書なので、resume が解決しない場合に備えて待たない。
  context.resume().catch((error) => console.warn("[Kotodama] resume failed", error));
  console.info("[Kotodama] audio context", context.state, context.sampleRate);
}

// ---------- ユーティリティ ----------

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function describe(error: unknown): string {
  if (error instanceof OpenAIError) return `${error.status} ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const init = (await chrome.runtime.sendMessage({ target: "background", type: "init" } satisfies FromOffscreen)) as
    | OffscreenInit
    | undefined;
  if (!init) throw new Error("開始情報を受け取れませんでした");
  settings = init.settings;
  tabId = init.tabId;

  if (!settings.apiKey) {
    postError("APIキーが設定されていません。拡張機能のオプションで設定してください。", true);
    return;
  }
  try {
    await startCapture(init.streamId);
  } catch (error) {
    postError(`タブの音声を取り込めませんでした: ${describe(error)}`, true);
    return;
  }
  await connect().catch(onConnectError);
}

main().catch((error) => postError(`起動に失敗しました: ${describe(error)}`, true));
