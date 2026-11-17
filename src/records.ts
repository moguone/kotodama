// 拡張のページ（タイムライン・パネル・ダッシュボード）で共通に使う、保存した記録まわりの処理。

import { summarize, type SummaryLine } from "./openai";
import { loadSettings, recordKey, VIDEO_INDEX_KEY, type VideoIndexItem, type VideoRecord, type VideoSummary } from "./shared";

export function formatTime(entry: { videoTime?: number; at: number }): string {
  if (entry.videoTime === undefined) {
    return new Date(entry.at).toLocaleTimeString("ja-JP", { hour12: false });
  }
  const total = Math.max(0, Math.floor(entry.videoTime));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

export function formatDate(time: number): string {
  return new Date(time).toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" });
}

export async function loadIndex(): Promise<VideoIndexItem[]> {
  const stored = await chrome.storage.local.get(VIDEO_INDEX_KEY);
  return (stored[VIDEO_INDEX_KEY] as VideoIndexItem[] | undefined) ?? [];
}

export async function loadRecord(key: string): Promise<VideoRecord | undefined> {
  const stored = await chrome.storage.local.get(recordKey(key));
  return stored[recordKey(key)] as VideoRecord | undefined;
}

/** 動画を、指定した位置から開くURL（YouTube のときだけ位置を付けられる）。 */
export function urlAt(record: Pick<VideoRecord, "url">, time?: number): string {
  const url = new URL(record.url);
  if (time !== undefined && url.hostname.endsWith("youtube.com")) url.searchParams.set("t", `${Math.floor(time)}s`);
  return url.toString();
}

/** 記録のここまでの内容をまとめる（保存はしない）。 */
export async function createSummary(record: VideoRecord): Promise<VideoSummary> {
  const settings = await loadSettings();
  const target = record.entries;
  const lines: SummaryLine[] = target.map((entry, index) => ({ index, time: formatTime(entry), en: entry.en }));
  const result = await summarize(settings.apiKey, settings.summaryModel, record.title, lines);
  return {
    overview: result.overview,
    points: result.points.map((point) => {
      const entry = target[Math.min(target.length - 1, Math.max(0, point.index))];
      return { videoTime: entry.videoTime, at: entry.at, text: point.text };
    }),
    createdAt: Date.now(),
  };
}

export function summaryToText(record: VideoRecord, summary: VideoSummary): string {
  return [record.title, record.url, "", summary.overview, "", ...summary.points.map((point) => `- ${formatTime(point)} ${point.text}`)].join(
    "\n",
  );
}

export function recordToMarkdown(record: VideoRecord): string {
  const lines = [`# ${record.title || record.url}`, "", `- URL: ${record.url}`, `- 最終更新: ${formatDate(record.updatedAt)}`, ""];
  if (record.summary) {
    lines.push("## まとめ", "", record.summary.overview, "");
    for (const point of record.summary.points) lines.push(`- ${formatTime(point)} ${point.text}`);
    lines.push("");
  }
  lines.push("## タイムライン", "");
  for (const entry of record.entries) {
    lines.push(`**${formatTime(entry)}** ${entry.ja}`);
    if (entry.en !== entry.ja) lines.push(`> ${entry.en}`);
    lines.push("");
  }
  return lines.join("\n");
}
