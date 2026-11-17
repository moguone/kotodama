// ダッシュボード。保存した動画の一覧と、選んだ動画のまとめ・タイムラインを表示する。

import { OpenAIError } from "./openai";
import { createSummary, formatDate, formatTime, loadIndex, loadRecord, recordToMarkdown, urlAt } from "./records";
import { recordKey, VIDEO_INDEX_KEY, type FromTimeline, type VideoIndexItem, type VideoRecord, type VideoSummary } from "./shared";

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;

const videos = $<HTMLUListElement>("#videos");
const search = $<HTMLInputElement>("#search");
const stats = $("#stats");
const welcome = $("#welcome");
const detail = $("#detail");
const summarizeButton = $<HTMLButtonElement>("#summarize");
const summaryMessage = $("#summary-message");
const englishButton = $<HTMLButtonElement>("#english");

let index: VideoIndexItem[] = [];
let selectedKey: string | undefined;
let record: VideoRecord | undefined;
let showEnglish = true;
let summarizing = false;

function selectedFromHash(): string | undefined {
  const hash = decodeURIComponent(location.hash.slice(1));
  return hash || undefined;
}

// ---------- 一覧 ----------

function renderList(): void {
  const query = search.value.trim().toLowerCase();
  const items = index.filter((item) => !query || `${item.title} ${item.url}`.toLowerCase().includes(query));
  const total = index.reduce((sum, item) => sum + item.count, 0);
  stats.textContent = `保存した動画 ${index.length}本 ・ ${total.toLocaleString("ja-JP")}行`;

  if (items.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = index.length === 0 ? "まだ保存した動画がありません。" : "該当する動画がありません。";
    videos.replaceChildren(empty);
    return;
  }
  videos.replaceChildren(
    ...items.map((item) => {
      const row = document.createElement("li");
      row.setAttribute("aria-current", String(item.key === selectedKey));
      const name = document.createElement("strong");
      name.textContent = item.title || item.url;
      const meta = document.createElement("span");
      meta.textContent = `${formatDate(item.updatedAt)} ・ ${item.count}行${item.hasSummary ? " ・ まとめあり" : ""}`;
      row.append(name, meta);
      row.addEventListener("click", () => {
        location.hash = encodeURIComponent(item.key);
      });
      return row;
    }),
  );
}

// ---------- 詳細 ----------

function timeLink(target: VideoRecord, entry: { videoTime?: number; at: number }): HTMLElement {
  if (entry.videoTime === undefined) {
    const text = document.createElement("span");
    text.className = "time muted";
    text.textContent = formatTime(entry);
    return text;
  }
  const link = document.createElement("a");
  link.className = "time";
  link.href = urlAt(target, entry.videoTime);
  link.target = "_blank";
  link.rel = "noreferrer";
  link.title = "この位置から動画を開く";
  link.textContent = formatTime(entry);
  return link;
}

function renderSummary(target: VideoRecord, summary: VideoSummary | undefined): void {
  $("#overview").textContent = summary?.overview ?? "";
  $("#summary-meta").textContent = summary ? `${formatDate(summary.createdAt)} 時点` : "";
  $<HTMLUListElement>("#points").replaceChildren(
    ...(summary?.points ?? []).map((point) => {
      const item = document.createElement("li");
      const text = document.createElement("span");
      text.textContent = point.text;
      item.append(timeLink(target, point), text);
      return item;
    }),
  );
  summarizeButton.textContent = summary ? "まとめを作り直す" : "まとめを作る";
  if (!summarizing) {
    summaryMessage.className = "muted";
    summaryMessage.textContent = summary ? "" : "まだまとめがありません。";
  }
}

function renderDetail(): void {
  welcome.hidden = record !== undefined;
  detail.hidden = record === undefined;
  if (!record) return;
  const target = record;

  $("#title").textContent = target.title || target.url;
  const meta = $("#meta");
  const link = document.createElement("a");
  link.href = target.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = target.url;
  meta.replaceChildren(link, ` ・ 最終更新 ${formatDate(target.updatedAt)}`);
  $("#count").textContent = `${target.entries.length}行`;
  renderSummary(target, target.summary);

  $<HTMLOListElement>("#entries").replaceChildren(
    ...target.entries.map((entry) => {
      const item = document.createElement("li");
      const body = document.createElement("div");
      const ja = document.createElement("p");
      ja.textContent = entry.ja;
      body.append(ja);
      if (entry.en !== entry.ja) {
        const en = document.createElement("p");
        en.className = "en";
        en.textContent = entry.en;
        en.hidden = !showEnglish;
        body.append(en);
      }
      item.append(timeLink(target, entry), body);
      return item;
    }),
  );
}

async function select(key: string | undefined): Promise<void> {
  selectedKey = key;
  record = key ? await loadRecord(key) : undefined;
  if (!record) selectedKey = undefined;
  renderList();
  renderDetail();
  document.querySelector("main")!.scrollTop = 0;
}

// ---------- 操作 ----------

function flash(button: HTMLButtonElement, text: string): void {
  const label = button.textContent;
  button.textContent = text;
  setTimeout(() => (button.textContent = label), 1500);
}

$("#open").addEventListener("click", () => {
  if (record) window.open(record.url, "_blank", "noreferrer");
});

$<HTMLButtonElement>("#copy").addEventListener("click", async (event) => {
  if (!record) return;
  const button = event.currentTarget as HTMLButtonElement;
  const body = record.entries.map((entry) => `${formatTime(entry)}\t${entry.ja}`);
  await navigator.clipboard.writeText([record.title, record.url, "", ...body].join("\n"));
  flash(button, "コピーしました");
});

$("#export").addEventListener("click", () => {
  if (!record) return;
  const blob = new Blob([recordToMarkdown(record)], { type: "text/markdown;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${(record.title || "kotodama").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80)}.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

englishButton.addEventListener("click", () => {
  showEnglish = !showEnglish;
  englishButton.setAttribute("aria-pressed", String(showEnglish));
  englishButton.textContent = showEnglish ? "英語の原文" : "英語の原文（非表示）";
  for (const en of document.querySelectorAll<HTMLElement>("#entries .en")) en.hidden = !showEnglish;
});

$("#delete").addEventListener("click", async () => {
  if (!record || !selectedKey) return;
  if (!window.confirm(`「${record.title || record.url}」の訳とまとめを削除します。よろしいですか？`)) return;
  await chrome.runtime.sendMessage({ type: "kotodama:delete-record", key: selectedKey } satisfies FromTimeline).catch(() => undefined);
  history.replaceState(null, "", location.pathname);
});

summarizeButton.addEventListener("click", async () => {
  if (!record || !selectedKey || summarizing) return;
  const key = selectedKey;
  summarizing = true;
  summarizeButton.disabled = true;
  summaryMessage.className = "muted";
  summaryMessage.textContent = `${record.entries.length}行をまとめています…`;
  try {
    const summary = await createSummary(record);
    await chrome.runtime.sendMessage({ type: "kotodama:save-summary", key, summary } satisfies FromTimeline).catch(() => undefined);
    summaryMessage.textContent = "";
  } catch (error) {
    const reason = error instanceof OpenAIError ? `${error.status} ${error.message}` : error instanceof Error ? error.message : String(error);
    summaryMessage.className = "error";
    summaryMessage.textContent = `まとめに失敗しました: ${reason}`;
  } finally {
    summarizing = false;
    summarizeButton.disabled = false;
  }
});

$("#options").addEventListener("click", (event) => {
  event.preventDefault();
  void chrome.runtime.openOptionsPage();
});

search.addEventListener("input", renderList);
window.addEventListener("hashchange", () => void select(selectedFromHash()));

// 翻訳中に開いていても、追記・まとめ・削除がすぐ反映されるようにする。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[VIDEO_INDEX_KEY]) {
    index = (changes[VIDEO_INDEX_KEY].newValue as VideoIndexItem[] | undefined) ?? [];
    renderList();
  }
  const changed = selectedKey ? changes[recordKey(selectedKey)] : undefined;
  if (changed) {
    record = changed.newValue as VideoRecord | undefined;
    if (!record) selectedKey = undefined;
    renderList();
    renderDetail();
  }
});

async function init(): Promise<void> {
  index = await loadIndex();
  await select(selectedFromHash() ?? index[0]?.key);
}

void init();
