// 字幕から取り込んだ全文を、まとめて文単位に直して訳す。タイムラインのウィンドウで動かす。

import type { CaptionCue } from "./captions";
import { translateSentences } from "./openai";
import { loadSettings, type FromTimeline, type ImportJob, type TimelineEntry } from "./shared";

/** ひとかたまりの目安（文字数）。これを超えたら、文末か間の空いたところで切る。 */
const CHUNK_TARGET_CHARS = 900;
const CHUNK_MAX_CHARS = 1600;
/** 字幕の間がこれ以上空いていたら、話の切れ目とみなす（秒）。 */
const PAUSE_SECONDS = 0.6;
/** 前のかたまりの末尾を、文脈として渡す文字数。 */
const CONTEXT_CHARS = 300;
const CONCURRENCY = 4;
const TIMEOUT_MS = 90_000;
/** 日本語の字幕をそのまま使うとき、1行にまとめる文字数の目安。 */
const JA_LINE_CHARS = 50;

type Chunk = { cues: CaptionCue[]; text: string };

function textOf(cues: CaptionCue[]): string {
  return cues.map((cue) => cue.text).join(" ");
}

export function buildChunks(cues: CaptionCue[]): Chunk[] {
  const chunks: Chunk[] = [];
  let current: CaptionCue[] = [];
  let length = 0;
  cues.forEach((cue, index) => {
    current.push(cue);
    length += cue.text.length + 1;
    const next = cues[index + 1];
    const atBreak = /[.?!]["')\]]?$/.test(cue.text) || !next || next.start - cue.end >= PAUSE_SECONDS;
    if ((length >= CHUNK_TARGET_CHARS && atBreak) || length >= CHUNK_MAX_CHARS || !next) {
      chunks.push({ cues: current, text: textOf(current) });
      current = [];
      length = 0;
    }
  });
  return chunks;
}

/** かたまりの先頭から offset 文字目が話された時刻（秒）を、文字数の割合で見積もる。 */
function timeAt(cues: CaptionCue[], offset: number): number {
  let position = 0;
  for (const cue of cues) {
    const length = cue.text.length;
    if (offset <= position + length) {
      const fraction = length > 0 ? Math.max(0, offset - position) / length : 0;
      return cue.start + (cue.end - cue.start) * fraction;
    }
    position += length + 1;
  }
  return cues.at(-1)?.end ?? 0;
}

async function send(job: ImportJob, entries: TimelineEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await chrome.runtime.sendMessage({ type: "kotodama:import-entries", page: job.page, entries } satisfies FromTimeline);
}

function entry(job: ImportJob, seq: number, videoTime: number, en: string, ja: string): TimelineEntry {
  // at は重複の判定に使うので、取り込みごと・行ごとに違う値にする。
  return { seq, at: job.id + seq, videoTime, en, ja, ...job.page };
}

/** 投稿者の日本語字幕は訳さず、読みやすい長さにまとめてそのまま載せる。 */
async function importJapanese(job: ImportJob): Promise<void> {
  const entries: TimelineEntry[] = [];
  let start = 0;
  let text = "";
  job.cues.forEach((cue, index) => {
    if (!text) start = cue.start;
    text += cue.text;
    const next = job.cues[index + 1];
    if (/[。！？!?]$/.test(cue.text) || text.length >= JA_LINE_CHARS || !next) {
      entries.push(entry(job, entries.length, start, text, text));
      text = "";
    }
  });
  await send(job, entries);
}

export type ImportOutcome = { chunks: number; failed: number; cancelled: boolean };

/**
 * 字幕の全文を訳して、できた分から保存する。かたまりごとに独立して訳すので、並行して進める。
 * onProgress には、終わったかたまりの数と全体の数を渡す。
 */
export async function runImport(
  job: ImportJob,
  onProgress: (done: number, total: number) => void,
  isCancelled: () => boolean,
): Promise<ImportOutcome> {
  if (job.track.languageCode.startsWith("ja")) {
    onProgress(0, 1);
    await importJapanese(job);
    onProgress(1, 1);
    return { chunks: 1, failed: 0, cancelled: false };
  }

  const settings = await loadSettings();
  const chunks = buildChunks(job.cues);
  let next = 0;
  let done = 0;
  let failed = 0;
  onProgress(0, chunks.length);

  async function translateChunk(index: number): Promise<void> {
    const chunk = chunks[index];
    const precedingEn = index > 0 ? chunks[index - 1].text.slice(-CONTEXT_CHARS) : "";
    // 行の番号は、かたまりの順番が保たれるように振る。
    const base = index * 1000;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await translateSentences(settings.apiKey, settings.translateModel, chunk.text, [], true, {
          precedingEn,
          timeoutMs: TIMEOUT_MS,
        });
        const units = result.remainder ? [...result.units, { en: result.remainder, ja: result.remainder }] : result.units;
        let cursor = 0;
        const entries = units.map((unit, offset) => {
          const made = entry(job, base + offset, timeAt(chunk.cues, cursor), unit.en, unit.ja);
          cursor += unit.en.length + 1;
          return made;
        });
        await send(job, entries);
        return;
      } catch (error) {
        console.warn("[Kotodama] import chunk failed", index, attempt, error);
      }
    }
    // 2回失敗したかたまりは、英語のまま載せる。
    failed += 1;
    await send(job, [entry(job, base, chunk.cues[0].start, chunk.text, chunk.text)]);
  }

  async function worker(): Promise<void> {
    while (next < chunks.length && !isCancelled()) {
      const index = next++;
      await translateChunk(index);
      done += 1;
      onProgress(done, chunks.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
  return { chunks: chunks.length, failed, cancelled: isCancelled() };
}
