import { captionsInPage } from "./captions";
import {
  displayOf,
  loadSettings,
  SESSION_KEYS,
  recordKey,
  VIDEO_INDEX_KEY,
  type FromContent,
  type FromTimeline,
  type ImportJob,
  type ImportResult,
  type PageInfo,
  type ToggleResult,
  type VideoIndexItem,
  type VideoRecord,
  type FromOffscreen,
  type OffscreenInit,
  type TimelineEntry,
  type ToContent,
} from "./shared";

const ACTIVE_TAB_KEY = SESSION_KEYS.activeTabId;
const PENDING_START_KEY = SESSION_KEYS.pendingStart;
const MAX_RECORD_ENTRIES = 5000;
const TIMELINE_WIDTH = 440;

// APIキーを content script から読めないようにする。
void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => undefined);

async function getActiveTabId(): Promise<number | undefined> {
  const stored = await chrome.storage.session.get(ACTIVE_TAB_KEY);
  return stored[ACTIVE_TAB_KEY] as number | undefined;
}

async function setActiveTabId(tabId: number | undefined): Promise<void> {
  if (tabId === undefined) {
    await chrome.storage.session.remove(ACTIVE_TAB_KEY);
  } else {
    await chrome.storage.session.set({ [ACTIVE_TAB_KEY]: tabId });
  }
}

function sendToTab(tabId: number, payload: ToContent): Promise<unknown> {
  return chrome.tabs.sendMessage(tabId, payload).catch(() => undefined);
}

function ping(tabId: number): Promise<boolean> {
  return chrome.tabs
    .sendMessage(tabId, { type: "kotodama:ping" } satisfies ToContent)
    .then(() => true)
    .catch(() => false);
}

async function setBadge(tabId: number, text: "" | "ON" | "!"): Promise<void> {
  await chrome.action.setBadgeText({ tabId, text }).catch(() => undefined);
  await chrome.action
    .setTitle({ tabId, title: text === "ON" ? "Kotodama: 翻訳を停止" : "Kotodama: 翻訳を開始" })
    .catch(() => undefined);
}

async function closeOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (contexts.length > 0) await chrome.offscreen.closeDocument();
}

/** 拡張のインストール前から開いていたタブなどでは content script が無いので注入する。 */
async function ensureContentScript(tabId: number): Promise<void> {
  if (await ping(tabId)) return;
  await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

async function stop({ notify = true } = {}): Promise<void> {
  const tabId = await getActiveTabId();
  await closeOffscreen();
  await setActiveTabId(undefined);
  if (tabId === undefined) return;
  await setBadge(tabId, "");
  if (notify) await sendToTab(tabId, { type: "kotodama:status", state: "stopped" });
}

async function start(tabId: number): Promise<void> {
  const settings = await loadSettings();
  if (!settings.apiKey) {
    await chrome.runtime.openOptionsPage();
    return;
  }

  await ensureContentScript(tabId);
  // 字幕からの取り込みの途中なら、打ち切る。
  await chrome.storage.session.remove(SESSION_KEYS.importJob);
  // 取り込み中のストリームが残っていると getMediaStreamId が失敗するので、先に閉じる。
  await closeOffscreen();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  // offscreen が起動直後に致命的エラーを返しても stop() が対象タブを見つけられるよう、先に記録する。
  await setActiveTabId(tabId);
  await chrome.storage.session.set({ [PENDING_START_KEY]: { streamId, tabId } });
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: "タブの音声を取り込んで文字起こしと翻訳を行うため",
    });
  } catch (error) {
    await setActiveTabId(undefined);
    throw error;
  }
  await setBadge(tabId, "ON");
  await chrome.storage.session.set({ [SESSION_KEYS.timelineTabId]: tabId });
  await openTimelineWindow(tabId);
}

// ---------- タイムラインのウィンドウ ----------

async function getTimelineWindowId(): Promise<number | undefined> {
  const stored = await chrome.storage.session.get(SESSION_KEYS.timelineWindowId);
  const id = stored[SESSION_KEYS.timelineWindowId] as number | undefined;
  if (id === undefined) return undefined;
  const exists = await chrome.windows.get(id).then(() => true).catch(() => false);
  return exists ? id : undefined;
}

/** 訳を時系列で並べる小さなウィンドウを、動画のウィンドウの右端に重ねて開く。 */
async function openTimelineWindow(tabId: number): Promise<void> {
  if ((await getTimelineWindowId()) !== undefined) return;
  const tab = await chrome.tabs.get(tabId);
  const parent = await chrome.windows.get(tab.windowId);
  const height = Math.min(760, Math.max(400, (parent.height ?? 800) - 120));
  const created = await chrome.windows.create({
    url: "timeline.html",
    type: "popup",
    width: TIMELINE_WIDTH,
    height,
    left: Math.max(0, (parent.left ?? 0) + (parent.width ?? 1200) - TIMELINE_WIDTH - 16),
    top: (parent.top ?? 0) + 96,
  });
  if (created?.id !== undefined) await chrome.storage.session.set({ [SESSION_KEYS.timelineWindowId]: created.id });
}

// タイムラインのウィンドウを閉じたら、翻訳も止める。
chrome.windows.onRemoved.addListener(async (windowId) => {
  const stored = await chrome.storage.session.get(SESSION_KEYS.timelineWindowId);
  if (stored[SESSION_KEYS.timelineWindowId] !== windowId) return;
  await chrome.storage.session.remove(SESSION_KEYS.timelineWindowId);
  // 字幕からの取り込みの途中なら、それも止める。
  const job = await chrome.storage.session.get([SESSION_KEYS.importJob, SESSION_KEYS.timelineTabId]);
  await chrome.storage.session.remove(SESSION_KEYS.importJob);
  const followed = job[SESSION_KEYS.timelineTabId] as number | undefined;
  if (followed !== undefined) await sendToTab(followed, { type: "kotodama:follow", on: false });
  await stop();
});

// ---------- 動画ごとの記録 ----------
// 訳・まとめ・聞き取り済みの区間を、動画ごとに chrome.storage.local へ保存する。

let recordChain: Promise<void> = Promise.resolve();

async function readRecord(key: string): Promise<VideoRecord | undefined> {
  const stored = await chrome.storage.local.get(recordKey(key));
  return stored[recordKey(key)] as VideoRecord | undefined;
}

async function writeIndex(update: (items: VideoIndexItem[]) => VideoIndexItem[]): Promise<void> {
  const stored = await chrome.storage.local.get(VIDEO_INDEX_KEY);
  const items = (stored[VIDEO_INDEX_KEY] as VideoIndexItem[] | undefined) ?? [];
  await chrome.storage.local.set({ [VIDEO_INDEX_KEY]: update(items) });
}

/**
 * 記録を読み、変更して書き戻す。読み出しと書き込みの間に別の変更が挟まらないよう、1件ずつ順番に行う。
 * mutate が false を返したら書き込まない。create が無ければ、記録が無いときは何もしない。
 */
function updateRecord(key: string, mutate: (record: VideoRecord) => boolean | void, create?: () => VideoRecord): Promise<void> {
  recordChain = recordChain
    .then(async () => {
      const record = (await readRecord(key)) ?? create?.();
      if (!record || mutate(record) === false) return;
      record.updatedAt = Date.now();
      await chrome.storage.local.set({ [recordKey(key)]: record });
      const item: VideoIndexItem = {
        key,
        url: record.url,
        title: record.title,
        updatedAt: record.updatedAt,
        count: record.entries.length,
        hasSummary: record.summary !== undefined,
      };
      await writeIndex((items) => [item, ...items.filter((existing) => existing.key !== key)]);
    })
    .catch((error) => console.warn("[Kotodama] record update failed", error));
  return recordChain;
}

function deleteRecord(key: string): Promise<void> {
  recordChain = recordChain
    .then(async () => {
      await chrome.storage.local.remove(recordKey(key));
      await writeIndex((items) => items.filter((existing) => existing.key !== key));
    })
    .catch((error) => console.warn("[Kotodama] record delete failed", error));
  return recordChain;
}

function entryOrder(a: TimelineEntry, b: TimelineEntry): number {
  return (a.videoTime ?? Infinity) - (b.videoTime ?? Infinity) || a.at - b.at;
}

function appendEntry(entry: TimelineEntry): void {
  void chrome.storage.session.set({ [SESSION_KEYS.currentVideoKey]: entry.key });
  void updateRecord(
    entry.key,
    (record) => {
      // 同じ訳が二重に届いても、1件だけ残す。
      if (record.entries.some((existing) => existing.seq === entry.seq && existing.at === entry.at)) return false;
      record.entries.push(entry);
      // 巻き戻しや先送りをしても、あとで読み返しやすいよう動画の時刻順に並べる。
      record.entries.sort(entryOrder);
      record.entries = record.entries.slice(-MAX_RECORD_ENTRIES);
      record.title = entry.title || record.title;
      record.url = entry.url;
    },
    () => ({ key: entry.key, url: entry.url, title: entry.title, updatedAt: Date.now(), entries: [] }),
  );
}

/** offscreen は chrome.storage を使えないので、起動時に必要な情報をここから渡す。 */
async function initForOffscreen(): Promise<OffscreenInit | undefined> {
  const stored = await chrome.storage.session.get(PENDING_START_KEY);
  const pending = stored[PENDING_START_KEY] as { streamId: string; tabId: number } | undefined;
  if (!pending) return undefined;
  await chrome.storage.session.remove(PENDING_START_KEY);
  return { settings: await loadSettings(), ...pending };
}

// ---------- 字幕からの取り込み ----------

/** 動画の字幕の全文を取得し、タイムラインのウィンドウに訳させる。 */
async function startImport(tabId: number, replace: boolean): Promise<ImportResult> {
  try {
    await ensureContentScript(tabId);
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: captionsInPage,
      args: ["grab"],
    });
    const result = injection?.result;
    if (!result?.ok || !result.choice || !result.cues?.length) {
      return { ok: false, error: result?.error ?? "字幕を取得できませんでした" };
    }
    const page = (await chrome.tabs.sendMessage(tabId, { type: "kotodama:get-page" } satisfies ToContent)) as PageInfo;

    if ((await getActiveTabId()) !== undefined) await stop();
    if (replace) await deleteRecord(page.key);
    const job: ImportJob = { id: Date.now(), tabId, page, track: result.choice, cues: result.cues };
    await chrome.storage.session.set({
      [SESSION_KEYS.importJob]: job,
      [SESSION_KEYS.currentVideoKey]: page.key,
      [SESSION_KEYS.timelineTabId]: tabId,
    });
    await openTimelineWindow(tabId);
    await sendToTab(tabId, { type: "kotodama:follow", on: true });
    return { ok: true };
  } catch (error) {
    console.error("[Kotodama] import failed", error);
    return { ok: false, error: `字幕を取り込めませんでした: ${error instanceof Error ? error.message : String(error)}` };
  }
}

let busy = false;

/** タブの翻訳を開始・停止する。アイコンのパネルのボタンと、キーボードショートカットから呼ぶ。 */
async function toggle(tab: chrome.tabs.Tab): Promise<ToggleResult> {
  const tabId = tab.id;
  if (tabId === undefined) return { active: false, error: "タブが見つかりません" };
  if (busy) return { active: (await getActiveTabId()) === tabId };
  busy = true;
  try {
    const active = await getActiveTabId();
    if (active === tabId) {
      await stop();
      return { active: false };
    }
    if (active !== undefined) await stop();
    // chrome:// などブラウザの内部ページは拡張から触れない。
    if (!/^https?:/.test(tab.url ?? "")) {
      return { active: false, error: "このページでは使えません。動画のページで開始してください。" };
    }
    await start(tabId);
    return { active: (await getActiveTabId()) === tabId };
  } catch (error) {
    console.error("[Kotodama] start failed", error);
    const message = `開始できませんでした: ${error instanceof Error ? error.message : String(error)}`;
    await setBadge(tabId, "!");
    await sendToTab(tabId, { type: "kotodama:status", state: "error", message });
    return { active: false, error: message };
  } finally {
    busy = false;
  }
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-translation" && tab) void toggle(tab);
});

/** 拡張自身のページ（パネル・ダッシュボード・タイムライン）から来たメッセージか。 */
function fromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && (sender.url ?? "").startsWith(chrome.runtime.getURL(""));
}

chrome.runtime.onMessage.addListener((message: FromOffscreen | FromContent | FromTimeline, sender, sendResponse) => {
  if ("target" in message && message.target === "background") {
    if (message.type === "init") {
      void initForOffscreen().then(sendResponse);
      return true;
    }
    void sendToTab(message.tabId, message.payload);
    if (message.payload.type === "kotodama:status" && message.payload.fatal) {
      void (async () => {
        const tabId = await getActiveTabId();
        await stop({ notify: false });
        if (tabId !== undefined) await setBadge(tabId, "!");
      })();
    }
    return;
  }
  if (!("type" in message)) return;
  if (message.type === "kotodama:entry" && sender.tab) {
    appendEntry(message.entry);
    return;
  }
  if (message.type === "kotodama:page" && sender.tab) {
    void chrome.storage.session.set({ [SESSION_KEYS.currentVideoKey]: message.page.key });
    void readRecord(message.page.key).then((record) => sendResponse(record?.coverage ?? []));
    return true;
  }
  if (message.type === "kotodama:coverage" && sender.tab) {
    const ranges = message.ranges;
    void updateRecord(message.key, (record) => {
      record.coverage = ranges;
    });
    return;
  }
  if (message.type === "kotodama:get-display" && sender.tab) {
    void loadSettings().then((settings) => sendResponse(displayOf(settings)));
    return true;
  }
  // 以下は拡張のページ（タイムライン・パネル・ダッシュボード）からだけ受け付ける。
  if (!fromExtensionPage(sender)) return;
  if (message.type === "kotodama:toggle") {
    void chrome.tabs
      .get(message.tabId)
      .then(toggle)
      .catch((error): ToggleResult => ({ active: false, error: String(error) }))
      .then(sendResponse);
    return true;
  }
  if (message.type === "kotodama:import") {
    void startImport(message.tabId, message.replace).then(sendResponse);
    return true;
  }
  if (message.type === "kotodama:import-entries") {
    const { page, entries } = message;
    void updateRecord(
      page.key,
      (record) => {
        for (const entry of entries) {
          if (!record.entries.some((existing) => existing.seq === entry.seq && existing.at === entry.at)) record.entries.push(entry);
        }
        record.entries.sort(entryOrder);
        record.title = page.title || record.title;
        record.url = page.url;
      },
      () => ({ key: page.key, url: page.url, title: page.title, updatedAt: Date.now(), entries: [] }),
    );
    return;
  }
  if (message.type === "kotodama:import-done") {
    const coverage = message.coverage;
    // 取り込んだ範囲は聞き取り済みとして扱い、あとでリアルタイム翻訳をしても訳し直さない。
    void updateRecord(message.key, (record) => {
      record.coverage = coverage;
    });
    void chrome.storage.session.remove(SESSION_KEYS.importJob);
    return;
  }
  if (message.type === "kotodama:save-summary") {
    const summary = message.summary;
    void updateRecord(message.key, (record) => {
      record.summary = summary;
    });
    return;
  }
  if (message.type === "kotodama:delete-record") {
    void deleteRecord(message.key);
    return;
  }
});

// 表示設定の変更を、翻訳中のタブへすぐ反映する。
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  if (!changes.fontSize && !changes.showEnglish && !changes.showLiveEnglish && !changes.showOverlay) return;
  const tabId = await getActiveTabId();
  if (tabId === undefined) return;
  await sendToTab(tabId, { type: "kotodama:display", display: displayOf(await loadSettings()) });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if ((await getActiveTabId()) === tabId) await stop({ notify: false });
});

// タブ内で別サイトへ移ると content script が消え、字幕を出せないまま取り込みと課金だけが続く。
// 読み込み完了後に content script が応答しなければ止める（YouTube 内の遷移は応答するので続く）。
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete" || (await getActiveTabId()) !== tabId) return;
  if (await ping(tabId)) return;
  await new Promise((resolve) => setTimeout(resolve, 2000));
  if ((await getActiveTabId()) === tabId && !(await ping(tabId))) await stop({ notify: false });
});
