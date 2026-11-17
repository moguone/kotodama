// 動画のページで動く content script。
// - 字幕が話された時刻を動画の再生位置に直して、タイムラインへ送る。
// - 設定でオンのときだけ、動画の上にも字幕を1つ（1〜2文）ずつ出す。

import {
  DEFAULT_SETTINGS,
  displayOf,
  type CaptionLine,
  type DisplaySettings,
  type FromContent,
  type PageInfo,
  type TimeRange,
  type StatusState,
  type TimelineEntry,
  type ToContent,
} from "./shared";

const CLEAR_AFTER_MS = 8_000;
/** 1つの字幕を最低どれだけ見せるか（日本語1文字あたり）。 */
const DISPLAY_MS_PER_CHAR = 90;
const MIN_DISPLAY_MS = 1200;
const MAX_DISPLAY_MS = 3500;
/** 表示待ちがこれより多くなったら、待たずに次へ進んで追いつく。 */
const MAX_QUEUED_CAPTIONS = 2;
/** プレイヤー幅がこの値のとき、設定の文字サイズそのままで表示する。 */
const BASE_PLAYER_WIDTH = 1000;
const MIN_SCALE = 0.7;
const MAX_SCALE = 1.7;
/** 聞き取り中の英語は末尾だけ見せる。 */
const LIVE_MAX_CHARS = 90;
const PLAYER_SELECTORS = ["#movie_player", "#shorts-player", ".html5-video-player"];
const STATUS_TEXT: Record<StatusState, string> = {
  connecting: "接続中…",
  listening: "聞き取り中",
  stopped: "停止しました",
  error: "エラー",
};

// 同じページでこのスクリプトが2つ動くと、訳が二重にタイムラインへ送られる。
// （読み込み完了前に開始して注入されたあと、通常の読み込みでもう1つ入る場合や、拡張の再読み込み後など）
// 新しいほうが合図を出し、先にいたほうは止まる。
const TAKEOVER_EVENT = "kotodama:takeover";
document.dispatchEvent(new CustomEvent(TAKEOVER_EVENT));
document.addEventListener(TAKEOVER_EVENT, retire, { once: true });

function retire(): void {
  try {
    chrome.runtime.onMessage.removeListener(onMessage);
  } catch {
    // 拡張が再読み込みされたあとは chrome.runtime を使えない。もともと受信できないので問題ない。
  }
  stopSampling();
  window.clearTimeout(advanceTimer);
  window.clearTimeout(clearTimer);
  window.clearTimeout(statusTimer);
  resizeObserver.disconnect();
  overlay.remove();
  status.remove();
}

// 拡張を再読み込みすると、前の content script の字幕が DOM に残るので取り除く。
for (const old of document.querySelectorAll(".kotodama-overlay, .kotodama-status")) old.remove();

const overlay = document.createElement("div");
overlay.className = "kotodama-overlay";
const caption = document.createElement("div");
caption.className = "kotodama-caption";
const captionJa = document.createElement("div");
captionJa.className = "kotodama-ja";
const captionEn = document.createElement("div");
captionEn.className = "kotodama-en";
caption.append(captionJa, captionEn);
const live = document.createElement("div");
live.className = "kotodama-live";
overlay.append(caption, live);

const status = document.createElement("div");
status.className = "kotodama-status";

let current: CaptionLine | undefined;
let shownAt = 0;
const queue: CaptionLine[] = [];
let advanceTimer: number | undefined;
let liveText = "";
let draftText = "";
let display: DisplaySettings = displayOf(DEFAULT_SETTINGS);
let clearTimer: number | undefined;
let statusTimer: number | undefined;
let observedParent: HTMLElement | undefined;

const resizeObserver = new ResizeObserver((entries) => {
  const width = entries[0]?.contentRect.width ?? BASE_PLAYER_WIDTH;
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, width / BASE_PLAYER_WIDTH));
  overlay.style.setProperty("--kotodama-scale", scale.toFixed(3));
});

function applyDisplay(next: DisplaySettings): void {
  display = next;
  overlay.style.setProperty("--kotodama-font", `${display.fontSize}px`);
}
applyDisplay(display);

function isVisible(element: Element): boolean {
  return element instanceof HTMLElement && element.offsetWidth > 0 && element.offsetHeight > 0;
}

/** 見えている動画プレイヤーの中に置くと、全画面・シアターモードでも表示される。 */
function findParent(): { parent: HTMLElement; fixed: boolean } {
  const fullscreen = document.fullscreenElement;
  for (const selector of PLAYER_SELECTORS) {
    const player = [...document.querySelectorAll(selector)].find(isVisible);
    if (player && (!fullscreen || fullscreen.contains(player))) return { parent: player as HTMLElement, fixed: false };
  }
  // video 要素そのものが全画面のときは子要素を足せないので、body に出す（全画面中は見えない）。
  if (fullscreen instanceof HTMLElement && fullscreen.tagName !== "VIDEO") return { parent: fullscreen, fixed: true };
  return { parent: document.body, fixed: true };
}

function mount(): void {
  // 拡張が再読み込みされると、この content script は通信できなくなる。字幕を残さない。
  if (!chrome.runtime?.id) {
    overlay.remove();
    status.remove();
    resizeObserver.disconnect();
    return;
  }
  const { parent, fixed } = findParent();
  overlay.classList.toggle("kotodama-fixed", fixed);
  status.classList.toggle("kotodama-fixed", fixed);
  if (overlay.parentElement !== parent) parent.append(overlay);
  if (status.parentElement !== parent) parent.append(status);
  if (observedParent !== parent) {
    resizeObserver.disconnect();
    resizeObserver.observe(fixed ? document.documentElement : parent);
    observedParent = parent;
  }
}

// ---------- 動画の再生位置 ----------
// 音声は実時間で取り込むので、「話された時刻」の再生位置を覚えておけば、訳が遅れて届いても正しい位置を付けられる。

type Sample = { wall: number; time: number };
const SAMPLE_INTERVAL_MS = 250;
const SAMPLE_KEEP_MS = 120_000;
const samples: Sample[] = [];
let sampleTimer: number | undefined;

function findVideo(): HTMLVideoElement | undefined {
  const videos = [...document.querySelectorAll("video")].filter(isVisible);
  return videos.sort((a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight)[0];
}

// ---------- 聞き取り済みの区間 ----------
// 巻き戻して同じところを再生しても、訳し直さない。再生した区間を動画ごとに覚えておき、
// その中を再生しているあいだは offscreen に音声を送らせない。

type Range = TimeRange;
/** 連続再生とみなす、サンプル間の再生位置の進みの上限（秒）。これより大きければシークとみなす。 */
const MAX_STEP_SECONDS = 2;
/** 聞き取り済みの区間の終わりの少し手前から、聞き取りを再開する（秒）。 */
const RESUME_MARGIN_SECONDS = 0.5;
const MERGE_GAP_SECONDS = 0.3;
const coverage = new Map<string, Range[]>();
let lastSampleTime: number | undefined;
let skipping = false;
/** 字幕から取り込んだ動画で、再生位置をタイムラインへ知らせ続けるか。 */
let following = false;

/** 聞き取り済みの区間を保存する間隔。 */
const SAVE_COVERAGE_INTERVAL_MS = 5000;
let coverageDirty = false;
let coverageSavedAt = 0;

/** いま開いている動画。YouTube は動画IDで見分け、それ以外はページのURLで見分ける。 */
function pageInfo(): PageInfo {
  const videoId = location.hostname.endsWith("youtube.com") ? new URLSearchParams(location.search).get("v") : null;
  if (videoId) return { key: `yt:${videoId}`, url: `https://www.youtube.com/watch?v=${videoId}`, title: pageTitle() };
  const url = `${location.origin}${location.pathname}${location.search}`;
  return { key: url, url, title: pageTitle() };
}

function videoKey(): string {
  return pageInfo().key;
}

/** いまの動画を background へ知らせ、保存済みの聞き取り済み区間を受け取る。 */
async function announcePage(): Promise<void> {
  const page = pageInfo();
  const saved = (await chrome.runtime
    .sendMessage({ type: "kotodama:page", page } satisfies FromContent)
    .catch(() => undefined)) as Range[] | undefined;
  if (saved?.length) coverage.set(page.key, mergeRanges([...(coverage.get(page.key) ?? []), ...saved]));
}

function saveCoverage(now: number): void {
  if (!coverageDirty || now - coverageSavedAt < SAVE_COVERAGE_INTERVAL_MS) return;
  coverageDirty = false;
  coverageSavedAt = now;
  const key = videoKey();
  chrome.runtime
    .sendMessage({ type: "kotodama:coverage", key, ranges: coverage.get(key) ?? [] } satisfies FromContent)
    .catch(() => undefined);
}

function mergeRanges(ranges: Range[]): Range[] {
  const merged: Range[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && range.start <= last.end + MERGE_GAP_SECONDS) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function setSkipping(next: boolean): void {
  if (next === skipping) return;
  skipping = next;
  chrome.runtime.sendMessage({ type: "kotodama:gate", skip: next } satisfies FromContent).catch(() => undefined);
}

function trackCoverage(time: number): void {
  const key = videoKey();
  const ranges = coverage.get(key) ?? [];
  const inside = ranges.some((range) => time >= range.start && time < range.end - RESUME_MARGIN_SECONDS);
  const step = lastSampleTime === undefined ? 0 : time - lastSampleTime;
  if (!inside && lastSampleTime !== undefined && step > 0 && step < MAX_STEP_SECONDS) {
    coverage.set(key, mergeRanges([...ranges, { start: lastSampleTime, end: time }]));
    coverageDirty = true;
  }
  lastSampleTime = time;
  setSkipping(inside);
  // 聞き取り済みの区間を再生しているあいだは、タイムラインが該当行を追えるよう再生位置を知らせる。
  if (inside || following) chrome.runtime.sendMessage({ type: "kotodama:position", time } satisfies FromContent).catch(() => undefined);
}

function sample(): void {
  const video = findVideo();
  if (!video) return;
  const now = Date.now();
  trackCoverage(video.currentTime);
  saveCoverage(now);
  samples.push({ wall: now, time: video.currentTime });
  while (samples.length > 0 && now - samples[0].wall > SAMPLE_KEEP_MS) samples.shift();
}

function startSampling(): void {
  if (sampleTimer !== undefined) return;
  sample();
  sampleTimer = window.setInterval(sample, SAMPLE_INTERVAL_MS);
}

function stopSampling(): void {
  window.clearInterval(sampleTimer);
  sampleTimer = undefined;
  samples.length = 0;
  lastSampleTime = undefined;
  skipping = false;
}

function videoTimeAt(wall: number): number | undefined {
  let found: Sample | undefined = samples[0];
  for (const candidate of samples) {
    if (candidate.wall > wall) break;
    found = candidate;
  }
  return found?.time;
}

function pageTitle(): string {
  return document.title.replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube$/, "");
}

function sendEntry(line: CaptionLine): void {
  startSampling();
  const entry: TimelineEntry = { ...line, videoTime: videoTimeAt(line.at), ...pageInfo() };
  chrome.runtime.sendMessage({ type: "kotodama:entry", entry } satisfies FromContent).catch(() => undefined);
}

// ---------- 動画の上の字幕（設定でオンのときだけ） ----------

function render(): void {
  mount();
  overlay.hidden = !display.showOverlay;
  caption.hidden = !current;
  if (current) {
    captionJa.textContent = current.ja;
    captionEn.textContent = current.en;
    // 訳せずに英語のまま出す字幕は、英語を二重に出さない。
    captionEn.hidden = !display.showEnglish || current.ja === current.en;
  }

  // 仮の訳があればそれを、無ければ聞き取り中の英語を出す。
  const tail = draftText || (display.showLiveEnglish ? liveText : "");
  live.hidden = !tail;
  live.textContent = tail.length > LIVE_MAX_CHARS ? `…${tail.slice(-LIVE_MAX_CHARS)}` : tail;

  overlay.classList.toggle("kotodama-empty", caption.hidden && live.hidden);
}

function displayTime(line: CaptionLine): number {
  return Math.min(MAX_DISPLAY_MS, Math.max(MIN_DISPLAY_MS, line.ja.length * DISPLAY_MS_PER_CHAR));
}

/** 字幕を順番に出す。前の字幕を読み切れる時間は残すが、たまりすぎたら追いつく。 */
function advance(): void {
  window.clearTimeout(advanceTimer);
  if (queue.length === 0) return;
  const wait = current ? displayTime(current) - (Date.now() - shownAt) : 0;
  if (wait > 0 && queue.length <= MAX_QUEUED_CAPTIONS) {
    advanceTimer = window.setTimeout(advance, wait);
    return;
  }
  current = queue.shift();
  shownAt = Date.now();
  render();
  scheduleClear();
  if (queue.length > 0 && current) advanceTimer = window.setTimeout(advance, displayTime(current));
}

function clearAll(): void {
  window.clearTimeout(advanceTimer);
  queue.length = 0;
  current = undefined;
  liveText = "";
  draftText = "";
  render();
}

function scheduleClear(): void {
  window.clearTimeout(clearTimer);
  clearTimer = window.setTimeout(() => {
    current = undefined;
    render();
  }, CLEAR_AFTER_MS);
}

function onStatus(state: StatusState, message?: string): void {
  mount();
  status.textContent = message ? `${STATUS_TEXT[state]}: ${message}` : STATUS_TEXT[state];
  status.dataset.state = state;
  status.classList.add("kotodama-visible");
  window.clearTimeout(statusTimer);
  if (state !== "connecting") {
    const hideAfter = state === "error" ? 12_000 : 2_000;
    statusTimer = window.setTimeout(() => status.classList.remove("kotodama-visible"), hideAfter);
  }
  if (state === "connecting" || state === "listening") startSampling();
  if (state === "connecting") void announcePage();
  if (state === "listening") void requestDisplay();
  if (state === "stopped") {
    following = false;
    stopSampling();
    clearAll();
  }
}

async function requestDisplay(): Promise<void> {
  const next = (await chrome.runtime
    .sendMessage({ type: "kotodama:get-display" } satisfies FromContent)
    .catch(() => undefined)) as DisplaySettings | undefined;
  if (next) {
    applyDisplay(next);
    render();
  }
}

function onMessage(message: ToContent, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void): void {
  switch (message?.type) {
    case "kotodama:ping":
      sendResponse(true);
      break;
    case "kotodama:caption":
      sendEntry(message.line);
      if (display.showOverlay) {
        queue.push(message.line);
        advance();
      }
      break;
    case "kotodama:get-page":
      sendResponse(pageInfo());
      break;
    case "kotodama:follow":
      following = message.on;
      if (message.on) {
        void announcePage();
        startSampling();
      } else {
        stopSampling();
      }
      break;
    case "kotodama:forget":
      coverage.clear();
      lastSampleTime = undefined;
      break;
    case "kotodama:seek": {
      const video = findVideo();
      if (video) video.currentTime = message.time;
      break;
    }
    case "kotodama:live":
      liveText = message.text;
      if (display.showOverlay) render();
      break;
    case "kotodama:draft":
      draftText = message.text;
      if (display.showOverlay) render();
      break;
    case "kotodama:display":
      applyDisplay(message.display);
      render();
      break;
    case "kotodama:status":
      onStatus(message.state, message.message);
      break;
  }
}
chrome.runtime.onMessage.addListener(onMessage);

// YouTube はページ遷移しても再読み込みしないので、遷移後に付け直す。
document.addEventListener("yt-navigate-finish", () => {
  lastSampleTime = undefined;
  clearAll();
  if (sampleTimer !== undefined) void announcePage();
});
document.addEventListener("fullscreenchange", mount);

render();
