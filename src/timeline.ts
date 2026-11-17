// 訳を時系列で並べるウィンドウ。
// 訳は background が動画ごとに chrome.storage.local へ保存している（VideoRecord）。ここではそれを読んで表示する。
// 既定では「いま翻訳している動画」の記録を表示し、履歴から過去の動画の記録も開ける。

import { runImport } from "./import";
import { OpenAIError } from "./openai";
import { createSummary, formatTime, summaryToText, urlAt } from "./records";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  recordKey,
  SESSION_KEYS,
  VIDEO_INDEX_KEY,
  type FromContent,
  type FromOffscreen,
  type FromTimeline,
  type ImportJob,
  type StatusState,
  type TimelineEntry,
  type ToContent,
  type VideoIndexItem,
  type VideoRecord,
  type VideoSummary,
} from "./shared";

const LIVE_MAX_CHARS = 220;
/** 手でスクロールしてからこの時間は、自動でスクロールしない。 */
const USER_SCROLL_HOLD_MS = 5000;
const STATUS_TEXT: Record<StatusState, string> = {
  connecting: "接続中…",
  listening: "聞き取り中",
  stopped: "停止中",
  error: "エラー",
};

const list = document.querySelector<HTMLOListElement>("#list")!;
const live = document.querySelector<HTMLElement>("#live")!;
const draft = document.querySelector<HTMLElement>("#draft")!;
const now = document.querySelector<HTMLElement>("#now")!;
const status = document.querySelector<HTMLElement>("#status")!;
const statusText = status.querySelector("span")!;
const videoBar = document.querySelector<HTMLElement>("#video")!;
const videoTitle = document.querySelector<HTMLAnchorElement>("#video-title")!;
const backButton = document.querySelector<HTMLButtonElement>("#back")!;
const historyButton = document.querySelector<HTMLButtonElement>("#history")!;

/** いま翻訳している動画のキー。 */
let liveKey: string | undefined;
/** 表示している動画のキー。履歴から開いたときは liveKey と違う。 */
let viewKey: string | undefined;
let record: VideoRecord | undefined;
let showingHistory = false;
/** リアルタイム翻訳が動いているか。動いていないときは「聞き取り中」の欄を出さない。 */
let listening = false;
let rendered: TimelineEntry[] = [];
let playing: HTMLElement | undefined;
let lastUserScrollAt = 0;
let showEnglish = DEFAULT_SETTINGS.showEnglish;
let showLiveEnglish = DEFAULT_SETTINGS.showLiveEnglish;

function entries(): TimelineEntry[] {
  return record?.entries ?? [];
}

function isLiveView(): boolean {
  return viewKey !== undefined && viewKey === liveKey;
}

function sameEntry(a: TimelineEntry | undefined, b: TimelineEntry | undefined): boolean {
  return a !== undefined && b !== undefined && a.seq === b.seq && a.at === b.at;
}

/** 再生中の動画ならその位置へ移動し、過去の動画ならその位置から新しいタブで開く。 */
async function seek(time: number): Promise<void> {
  if (isLiveView()) {
    const stored = await chrome.storage.session.get(SESSION_KEYS.timelineTabId);
    const tabId = stored[SESSION_KEYS.timelineTabId] as number | undefined;
    if (tabId !== undefined) {
      await chrome.tabs.sendMessage(tabId, { type: "kotodama:seek", time } satisfies ToContent).catch(() => undefined);
    }
    return;
  }
  if (!record) return;
  await chrome.tabs.create({ url: urlAt(record, time) });
}

function timeButton(entry: { videoTime?: number; at: number }): HTMLButtonElement {
  const time = document.createElement("button");
  time.type = "button";
  time.className = "time";
  time.textContent = formatTime(entry);
  if (entry.videoTime === undefined) {
    time.disabled = true;
  } else {
    const seekTo = entry.videoTime;
    time.title = "この位置から再生";
    time.addEventListener("click", () => void seek(seekTo));
  }
  return time;
}

function entryElement(entry: TimelineEntry): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "entry";
  const body = document.createElement("div");
  const ja = document.createElement("p");
  ja.className = "ja";
  ja.textContent = entry.ja;
  body.append(ja);
  if (entry.ja !== entry.en) {
    const en = document.createElement("p");
    en.className = "en";
    en.textContent = entry.en;
    en.hidden = !showEnglish;
    body.append(en);
  }
  item.append(timeButton(entry), body);
  return item;
}

function message(text: string): HTMLLIElement {
  const item = document.createElement("li");
  item.id = "empty";
  item.textContent = text;
  return item;
}

function canAutoScroll(): boolean {
  return Date.now() - lastUserScrollAt > USER_SCROLL_HOLD_MS;
}

// ---------- 動画の記録の表示 ----------

function renderRecord(): void {
  if (showingHistory) return;
  const next = entries();
  videoBar.hidden = viewKey === undefined;
  videoTitle.textContent = record?.title || record?.url || "（まだ訳がありません）";
  if (record) videoTitle.href = record.url;
  else videoTitle.removeAttribute("href");
  backButton.hidden = isLiveView() || liveKey === undefined;
  now.hidden = !isLiveView() || !listening;

  // 末尾に足されただけなら、足された行だけ描く。途中に入った（巻き戻しなど）ときは全部描き直す。
  const appendedOnly =
    rendered.length > 0 && next.length >= rendered.length && rendered.every((entry, index) => sameEntry(entry, next[index]));
  if (!appendedOnly) {
    list.replaceChildren(...next.map(entryElement));
    playing = undefined;
  } else {
    list.append(...next.slice(rendered.length).map(entryElement));
  }
  rendered = next;

  if (next.length === 0) {
    list.replaceChildren(message("動画を再生すると、ここに訳が1文ずつ並びます。時刻を押すとその位置から再生します。"));
    return;
  }

  // 一番新しく訳された行を目立たせる（時刻順に並べているので、末尾とは限らない）。
  list.querySelector(".latest")?.classList.remove("latest");
  // 字幕からの取り込み中は、区間ごとに順不同で行が増えるので、追いかけない。
  if (isLiveView() && !playing && importingId === undefined) {
    const newest = next.reduce((latest, entry, index) => (entry.at > next[latest].at ? index : latest), 0);
    const element = list.children[newest];
    element?.classList.add("latest");
    if (canAutoScroll()) element?.scrollIntoView({ block: "nearest" });
  }
}

/** 聞き取り済みの区間を再生しているとき、その位置の行を目立たせて追いかける。 */
function showPlaying(time: number | undefined): void {
  let target: HTMLElement | undefined;
  if (time !== undefined && isLiveView() && !showingHistory) {
    const position = time;
    let index = -1;
    rendered.forEach((entry, at) => {
      if (entry.videoTime !== undefined && entry.videoTime <= position + 0.3) index = at;
    });
    target = (list.children[index] as HTMLElement | undefined) ?? undefined;
  }
  if (target === playing) return;
  playing?.classList.remove("playing");
  playing = target;
  if (!target) return;
  list.querySelector(".latest")?.classList.remove("latest");
  target.classList.add("playing");
  if (canAutoScroll()) target.scrollIntoView({ block: "center", behavior: "smooth" });
}

async function openRecord(key: string | undefined): Promise<void> {
  showingHistory = false;
  historyButton.setAttribute("aria-pressed", "false");
  viewKey = key;
  rendered = [];
  playing = undefined;
  if (key === undefined) {
    record = undefined;
  } else {
    const stored = await chrome.storage.local.get(recordKey(key));
    record = stored[recordKey(key)] as VideoRecord | undefined;
  }
  renderRecord();
  renderSavedSummary();
  if (isLiveView()) list.scrollTop = list.scrollHeight;
}

// ---------- 履歴 ----------

async function showHistory(): Promise<void> {
  showingHistory = true;
  historyButton.setAttribute("aria-pressed", "true");
  videoBar.hidden = true;
  now.hidden = true;
  summaryBox.hidden = true;
  const stored = await chrome.storage.local.get(VIDEO_INDEX_KEY);
  const items = (stored[VIDEO_INDEX_KEY] as VideoIndexItem[] | undefined) ?? [];
  if (items.length === 0) {
    list.replaceChildren(message("保存した動画はまだありません。"));
    return;
  }
  list.replaceChildren(
    ...items.map((item) => {
      const row = document.createElement("li");
      row.className = "video";
      const title = document.createElement("strong");
      title.textContent = item.title || item.url;
      const meta = document.createElement("span");
      const date = new Date(item.updatedAt).toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" });
      meta.textContent = `${date} ・ ${item.count}行${item.hasSummary ? " ・ まとめあり" : ""}${item.key === liveKey ? " ・ 再生中" : ""}`;
      row.append(title, meta);
      row.addEventListener("click", () => void openRecord(item.key));
      return row;
    }),
  );
  list.scrollTop = 0;
}

historyButton.addEventListener("click", () => {
  if (showingHistory) void openRecord(viewKey ?? liveKey);
  else void showHistory();
});
backButton.addEventListener("click", () => void openRecord(liveKey));

document.querySelector("#delete")!.addEventListener("click", async () => {
  if (!viewKey || !record) return;
  if (!window.confirm(`「${record.title || record.url}」の訳とまとめを削除します。よろしいですか？`)) return;
  const key = viewKey;
  await chrome.runtime.sendMessage({ type: "kotodama:delete-record", key } satisfies FromTimeline).catch(() => undefined);
  // 再生中の動画なら、聞き取り済みの区間も忘れさせる（同じところをもう一度訳せるようにする）。
  if (key === liveKey) {
    const stored = await chrome.storage.session.get(SESSION_KEYS.timelineTabId);
    const tabId = stored[SESSION_KEYS.timelineTabId] as number | undefined;
    if (tabId !== undefined) {
      await chrome.tabs.sendMessage(tabId, { type: "kotodama:forget" } satisfies ToContent).catch(() => undefined);
    }
  }
});

// ---------- まとめ ----------

const summarizeButton = document.querySelector<HTMLButtonElement>("#summarize")!;
const summaryBox = document.querySelector<HTMLElement>("#summary")!;
const summaryMeta = document.querySelector<HTMLElement>("#summary-meta")!;
const summaryMessage = document.querySelector<HTMLElement>("#summary-message")!;
const summaryOverview = document.querySelector<HTMLElement>("#summary-overview")!;
const summaryPoints = document.querySelector<HTMLUListElement>("#summary-points")!;
let summaryText = "";
let summarizing = false;

function showSummaryMessage(text: string, isError = false): void {
  summaryMessage.textContent = text;
  summaryMessage.classList.toggle("error", isError);
}

function renderSummary(summary: VideoSummary | undefined): void {
  summaryOverview.textContent = summary?.overview ?? "";
  summaryPoints.replaceChildren();
  summaryMeta.textContent = "";
  summaryText = "";
  if (!summary) return;
  showSummaryMessage("");
  summaryMeta.textContent = `${new Date(summary.createdAt).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" })} 時点`;
  for (const point of summary.points) {
    const item = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = point.text;
    item.append(timeButton(point), text);
    summaryPoints.append(item);
  }
  summaryText = record ? summaryToText(record, summary) : "";
}

/** 記録を開いたとき、保存済みのまとめがあれば中身だけ用意しておく（開くのは「まとめ」を押したとき）。 */
function renderSavedSummary(): void {
  if (summarizing) return;
  summaryBox.hidden = true;
  renderSummary(record?.summary);
}

async function runSummary(): Promise<void> {
  const target = entries();
  const key = viewKey;
  summaryBox.hidden = false;
  if (!key || target.length === 0) {
    renderSummary(undefined);
    showSummaryMessage("まだ訳がありません。動画を再生してから押してください。");
    return;
  }
  summarizing = true;
  summarizeButton.disabled = true;
  renderSummary(undefined);
  showSummaryMessage(`${target.length}行をまとめています…`);
  try {
    if (!record) throw new Error("記録がありません");
    const summary = await createSummary(record);
    await chrome.runtime.sendMessage({ type: "kotodama:save-summary", key, summary } satisfies FromTimeline).catch(() => undefined);
    if (viewKey === key) renderSummary(summary);
  } catch (error) {
    const detail = error instanceof OpenAIError ? `${error.status} ${error.message}` : error instanceof Error ? error.message : String(error);
    showSummaryMessage(`まとめに失敗しました: ${detail}`, true);
  } finally {
    summarizing = false;
    summarizeButton.disabled = false;
  }
}

// 保存済みのまとめがあればそれを開き、無ければ作る。
summarizeButton.addEventListener("click", () => {
  if (showingHistory) return;
  if (summaryBox.hidden && record?.summary) {
    summaryBox.hidden = false;
    renderSummary(record.summary);
    return;
  }
  void runSummary();
});
document.querySelector("#summary-redo")!.addEventListener("click", () => void runSummary());
document.querySelector("#summary-close")!.addEventListener("click", () => {
  summaryBox.hidden = true;
});

function flashCopied(button: HTMLButtonElement): void {
  const label = button.textContent;
  button.textContent = "コピーしました";
  setTimeout(() => (button.textContent = label), 1500);
}

document.querySelector<HTMLButtonElement>("#summary-copy")!.addEventListener("click", async (event) => {
  if (!summaryText) return;
  const button = event.currentTarget as HTMLButtonElement;
  await navigator.clipboard.writeText(summaryText);
  flashCopied(button);
});

document.querySelector<HTMLButtonElement>("#copy")!.addEventListener("click", async (event) => {
  if (!record) return;
  const button = event.currentTarget as HTMLButtonElement;
  const body = entries().map((entry) => `${formatTime(entry)}\t${entry.ja}`);
  await navigator.clipboard.writeText([record.title, record.url, "", ...body].join("\n"));
  flashCopied(button);
});

// ---------- 状態・聞き取り中の表示 ----------

function setStatus(state: StatusState, detail?: string): void {
  listening = state === "connecting" || state === "listening";
  now.hidden = !isLiveView() || !listening || showingHistory;
  status.dataset.state = state;
  statusText.textContent = detail ? `${STATUS_TEXT[state]}: ${detail}` : STATUS_TEXT[state];
  status.title = detail ?? "";
  if (state === "stopped") {
    setLive("");
    draft.textContent = "";
    showPlaying(undefined);
  }
}

// ---------- 字幕からの取り込み ----------

let importingId: number | undefined;
let importCancelled = false;

function setImportStatus(state: StatusState, text: string): void {
  status.dataset.state = state;
  statusText.textContent = text;
  status.title = text;
}

/** 取り込みの仕事があれば実行する。字幕の全文を訳し、できた分から一覧に並べる。 */
async function runPendingImport(): Promise<void> {
  const stored = await chrome.storage.session.get(SESSION_KEYS.importJob);
  const job = stored[SESSION_KEYS.importJob] as ImportJob | undefined;
  if (!job || importingId === job.id) return;
  importingId = job.id;
  importCancelled = false;
  const source = job.track.languageCode.startsWith("ja") ? "日本語字幕" : job.track.kind === "asr" ? "自動生成の英語字幕" : "英語字幕";
  setImportStatus("connecting", `${source}を取り込み中…`);
  try {
    const outcome = await runImport(
      job,
      (done, total) => setImportStatus("connecting", `${source}を翻訳中 ${done}/${total}`),
      () => importCancelled || importingId !== job.id,
    );
    if (outcome.cancelled) return;
    const last = job.cues.at(-1);
    const coverage = last ? [{ start: 0, end: last.end }] : [];
    await chrome.runtime.sendMessage({ type: "kotodama:import-done", key: job.page.key, coverage } satisfies FromTimeline);
    if (outcome.failed > 0) {
      setImportStatus("error", `取り込み完了（${outcome.chunks}区間のうち${outcome.failed}区間は訳せず、英語のままです）`);
    } else {
      setImportStatus("stopped", `${source}から取り込みました`);
    }
  } catch (error) {
    setImportStatus("error", `取り込みに失敗しました: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (importingId === job.id) importingId = undefined;
  }
}

function setLive(text: string): void {
  live.hidden = !showLiveEnglish;
  live.textContent = text.length > LIVE_MAX_CHARS ? `…${text.slice(-LIVE_MAX_CHARS)}` : text;
}

function applySettings(english: boolean, liveEnglish: boolean): void {
  showEnglish = english;
  showLiveEnglish = liveEnglish;
  for (const en of list.querySelectorAll<HTMLElement>(".en")) en.hidden = !showEnglish;
  live.hidden = !showLiveEnglish;
}

// offscreen や動画のページが background 宛てに送るメッセージは、このウィンドウにも届く。表示に要るものだけ拾う。
chrome.runtime.onMessage.addListener((incoming: FromOffscreen | FromContent) => {
  if ("type" in incoming && incoming.type === "kotodama:gate") {
    if (status.dataset.state === "listening") {
      statusText.textContent = incoming.skip ? "翻訳済みの区間を再生中（スキップ）" : STATUS_TEXT.listening;
    }
    if (!incoming.skip) {
      showPlaying(undefined);
      renderRecord();
    }
    return;
  }
  if ("type" in incoming && incoming.type === "kotodama:position") {
    showPlaying(incoming.time);
    return;
  }
  if (!("target" in incoming) || incoming.target !== "background" || incoming.type !== "relay") return;
  const payload = incoming.payload;
  if (payload.type === "kotodama:status") setStatus(payload.state, payload.message);
  if (payload.type === "kotodama:live") setLive(payload.text);
  if (payload.type === "kotodama:draft") draft.textContent = payload.text;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session") {
    const current = changes[SESSION_KEYS.currentVideoKey];
    if (current) {
      const followed = viewKey === liveKey;
      liveKey = current.newValue as string | undefined;
      // 再生中の動画を見ていたなら、動画が変わったら新しい動画へ切り替える。
      if (followed && !showingHistory) void openRecord(liveKey);
      else renderRecord();
    }
    const job = changes[SESSION_KEYS.importJob];
    if (job?.newValue) void runPendingImport();
    // 取り込みの途中でリアルタイム翻訳が始まったら、取り込みは打ち切る。
    if (job && !job.newValue) importCancelled = true;
    const active = changes[SESSION_KEYS.activeTabId];
    if (active && active.newValue === undefined && status.dataset.state !== "error" && importingId === undefined) setStatus("stopped");
    if (active && active.newValue !== undefined) setStatus("connecting");
  }
  if (area === "local") {
    if (changes.showEnglish || changes.showLiveEnglish) {
      void loadSettings().then((settings) => applySettings(settings.showEnglish, settings.showLiveEnglish));
    }
    if (showingHistory && changes[VIDEO_INDEX_KEY]) void showHistory();
    const changed = viewKey === undefined ? undefined : changes[recordKey(viewKey)];
    if (changed) {
      record = changed.newValue as VideoRecord | undefined;
      renderRecord();
      if (summaryBox.hidden) renderSummary(record?.summary);
    }
  }
});

for (const type of ["wheel", "touchmove", "keydown"] as const) {
  list.addEventListener(type, () => (lastUserScrollAt = Date.now()), { passive: true });
}

async function init(): Promise<void> {
  const settings = await loadSettings();
  applySettings(settings.showEnglish, settings.showLiveEnglish);
  const stored = await chrome.storage.session.get([SESSION_KEYS.currentVideoKey, SESSION_KEYS.activeTabId]);
  setStatus(stored[SESSION_KEYS.activeTabId] === undefined ? "stopped" : "listening");
  liveKey = stored[SESSION_KEYS.currentVideoKey] as string | undefined;
  await openRecord(liveKey);
  void runPendingImport();
}

void init();
