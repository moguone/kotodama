// アイコンを押すと開くパネル。いまのタブの翻訳の開始・停止と、最近の翻訳への入口。

import { captionsInPage, type CaptionsResult } from "./captions";
import { formatDate, loadIndex, loadRecord } from "./records";
import { loadSettings, SESSION_KEYS, type FromTimeline, type ImportResult, type ToggleResult } from "./shared";

const RECENT_COUNT = 5;

const title = document.querySelector<HTMLElement>("#current-title")!;
const toggleButton = document.querySelector<HTMLButtonElement>("#toggle")!;
const message = document.querySelector<HTMLElement>("#message")!;
const recent = document.querySelector<HTMLUListElement>("#recent")!;
const importButton = document.querySelector<HTMLButtonElement>("#import")!;
const importNote = document.querySelector<HTMLElement>("#import-note")!;

/** この動画に保存済みの訳が何行あるか。あれば、取り込みの前に置き換えの確認をする。 */
let savedCount = 0;
/** 字幕から取り込めない理由。開始ボタンの下に出す。 */
let captionNote = "";

let tab: chrome.tabs.Tab | undefined;

async function openDashboard(key?: string): Promise<void> {
  const base = chrome.runtime.getURL("dashboard.html");
  const url = key ? `${base}#${encodeURIComponent(key)}` : base;
  // すでに開いていれば、そのタブを使う。
  const existing = await chrome.tabs.query({ url: `${base}*` }).catch(() => []);
  const target = existing[0];
  if (target?.id !== undefined) {
    await chrome.tabs.update(target.id, { active: true, url });
    if (target.windowId !== undefined) await chrome.windows.update(target.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
  window.close();
}

function setMessage(text: string, isError = false): void {
  message.textContent = text;
  message.className = isError ? "error" : "muted";
}

async function renderCurrent(): Promise<void> {
  const stored = await chrome.storage.session.get(SESSION_KEYS.activeTabId);
  const activeTabId = stored[SESSION_KEYS.activeTabId] as number | undefined;
  const isActive = tab?.id !== undefined && tab.id === activeTabId;
  const usable = /^https?:/.test(tab?.url ?? "");

  title.textContent = tab?.title ?? "";
  const hasCaptions = !importButton.hidden;
  toggleButton.textContent = isActive ? "翻訳を停止する" : hasCaptions ? "リアルタイムで聞き取る" : "このタブを翻訳する";
  toggleButton.classList.toggle("secondary", hasCaptions && !isActive);
  toggleButton.classList.toggle("stop", isActive);
  toggleButton.disabled = !usable;
  if (!usable) setMessage("このページでは使えません。動画のページで開いてください。");
  else if (isActive) setMessage("このタブを翻訳しています。");
  else if (activeTabId !== undefined) setMessage("別のタブを翻訳中です。開始すると、そちらは停止します。");
  else setMessage(captionNote);
}

function youtubeVideoId(): string | undefined {
  try {
    const url = new URL(tab?.url ?? "");
    return url.hostname.endsWith("youtube.com") && url.pathname === "/watch" ? (url.searchParams.get("v") ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}

/** YouTube の動画なら、字幕があるかを調べて「字幕から翻訳する」を出す。 */
async function renderImport(): Promise<void> {
  const videoId = youtubeVideoId();
  if (tab?.id === undefined || !videoId) return;
  const [injection] = await chrome.scripting
    .executeScript({ target: { tabId: tab.id }, world: "MAIN", func: captionsInPage, args: ["list"] })
    .catch(() => []);
  const result = injection?.result as CaptionsResult | undefined;
  if (!result?.ok || !result.choice) {
    if (result?.isLive) captionNote = "ライブ配信中なので、再生しながら聞き取ります。";
    else if (result) captionNote = "取り込める字幕が無いので、再生しながら聞き取ります。";
    return;
  }
  savedCount = (await loadRecord(`yt:${videoId}`))?.entries.length ?? 0;
  const japanese = result.choice.languageCode.startsWith("ja");
  importButton.hidden = false;
  importButton.textContent = savedCount > 0 ? "字幕から翻訳し直す" : japanese ? "日本語字幕を取り込む" : "字幕から翻訳する";
  importNote.hidden = false;
  importNote.textContent = japanese
    ? "投稿者の日本語字幕があります。再生せずに、そのまま取り込みます。"
    : result.choice.kind === "asr"
      ? "自動生成の英語字幕があります。再生せずに全文を訳します。"
      : "投稿者の英語字幕があります。再生せずに全文を訳します。";
}

importButton.addEventListener("click", async () => {
  if (tab?.id === undefined) return;
  const settings = await loadSettings();
  if (!settings.apiKey) {
    await chrome.runtime.openOptionsPage();
    return;
  }
  if (savedCount > 0 && !window.confirm(`この動画には保存済みの訳が${savedCount}行あります。消して、字幕から訳し直しますか？`)) return;
  importButton.disabled = true;
  toggleButton.disabled = true;
  setMessage("字幕を取得しています…");
  const result = (await chrome.runtime
    .sendMessage({ type: "kotodama:import", tabId: tab.id, replace: savedCount > 0 } satisfies FromTimeline)
    .catch((error): ImportResult => ({ ok: false, error: String(error) }))) as ImportResult | undefined;
  if (!result?.ok) {
    importButton.disabled = false;
    toggleButton.disabled = false;
    setMessage(result?.error ?? "字幕を取り込めませんでした。", true);
    return;
  }
  window.close();
});

async function renderRecent(): Promise<void> {
  const items = (await loadIndex()).slice(0, RECENT_COUNT);
  if (items.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "まだありません。動画のタブで「このタブを翻訳する」を押すと、ここに並びます。";
    recent.replaceChildren(empty);
    return;
  }
  recent.replaceChildren(
    ...items.map((item) => {
      const row = document.createElement("li");
      const name = document.createElement("strong");
      name.textContent = item.title || item.url;
      const meta = document.createElement("span");
      meta.textContent = `${formatDate(item.updatedAt)} ・ ${item.count}行${item.hasSummary ? " ・ まとめあり" : ""}`;
      row.append(name, meta);
      row.addEventListener("click", () => void openDashboard(item.key));
      return row;
    }),
  );
}

toggleButton.addEventListener("click", async () => {
  if (tab?.id === undefined) return;
  const settings = await loadSettings();
  if (!settings.apiKey) {
    await chrome.runtime.openOptionsPage();
    return;
  }
  toggleButton.disabled = true;
  setMessage("切り替えています…");
  const result = (await chrome.runtime
    .sendMessage({ type: "kotodama:toggle", tabId: tab.id } satisfies FromTimeline)
    .catch((error): ToggleResult => ({ active: false, error: String(error) }))) as ToggleResult | undefined;
  if (result?.error) {
    await renderCurrent();
    setMessage(result.error, true);
    return;
  }
  // 開始するとタイムラインのウィンドウが開くので、パネルは閉じる。
  window.close();
});

document.querySelector("#dashboard")!.addEventListener("click", () => void openDashboard());
document.querySelector("#options")!.addEventListener("click", (event) => {
  event.preventDefault();
  void chrome.runtime.openOptionsPage();
});

async function init(): Promise<void> {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await Promise.all([renderCurrent(), renderRecent()]);
  await renderImport();
  await renderCurrent();
}

void init();
