import type { CaptionCue, CaptionTrack } from "./captions";

export type Settings = {
  apiKey: string;
  transcribeModel: string;
  /** 話している途中の仮の訳に使うモデル。速さと安さを優先する。 */
  draftModel: string;
  /** 確定の訳に使うモデル。 */
  translateModel: string;
  /** まとめに使うモデル。 */
  summaryModel: string;
  showEnglish: boolean;
  showLiveEnglish: boolean;
  showOverlay: boolean;
  fontSize: number;
  maxSegmentSeconds: number;
};

export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  transcribeModel: "gpt-live-transcribe",
  draftModel: "gpt-6-luna",
  translateModel: "gpt-6.1-terra",
  summaryModel: "gpt-6.1-sol",
  showEnglish: true,
  showLiveEnglish: true,
  showOverlay: false,
  fontSize: 22,
  maxSegmentSeconds: 8,
};

/** background と options ページだけで使う（offscreen と content script では chrome.storage を使えない／使わせない）。 */
export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored } as Settings;
}

export type DisplaySettings = Pick<Settings, "fontSize" | "showEnglish" | "showLiveEnglish" | "showOverlay">;

export function displayOf(settings: Settings): DisplaySettings {
  return {
    fontSize: settings.fontSize,
    showEnglish: settings.showEnglish,
    showLiveEnglish: settings.showLiveEnglish,
    showOverlay: settings.showOverlay,
  };
}

/** 字幕1つ分（1〜2文）。seq は表示順。at はその文が話された時刻（Date.now() の値）。 */
export type CaptionLine = {
  seq: number;
  en: string;
  ja: string;
  at: number;
};

/** タイムラインの1行。videoTime は動画の再生位置（秒）。動画が見つからないときは無い。 */
export type TimelineEntry = CaptionLine & {
  videoTime?: number;
  title: string;
  /** 動画を見分けるキー（YouTube なら動画ID）と、そのURL。 */
  key: string;
  url: string;
};

export type TimeRange = { start: number; end: number };

export type VideoSummary = {
  overview: string;
  points: { videoTime?: number; at: number; text: string }[];
  createdAt: number;
};

/** 動画1本ぶんの保存内容。chrome.storage.local に `video:<key>` で保存する。 */
export type VideoRecord = {
  key: string;
  url: string;
  title: string;
  updatedAt: number;
  entries: TimelineEntry[];
  summary?: VideoSummary;
  /** 聞き取り済みの区間（動画の秒）。巻き戻しや再訪で訳し直さないために使う。 */
  coverage?: TimeRange[];
};

/** 履歴の一覧用。chrome.storage.local の VIDEO_INDEX_KEY に配列で保存する。 */
export type VideoIndexItem = Pick<VideoRecord, "key" | "url" | "title" | "updatedAt"> & { count: number; hasSummary: boolean };

export const VIDEO_INDEX_KEY = "videoIndex";

export function recordKey(key: string): string {
  return `video:${key}`;
}

/** chrome.storage.session のキー。 */
export const SESSION_KEYS = {
  activeTabId: "activeTabId",
  pendingStart: "pendingStart",
  /** 字幕からの取り込みの仕事（ImportJob）。タイムラインのウィンドウが見つけて実行する。 */
  importJob: "importJob",
  /** いま翻訳している動画のキー。タイムラインはこの動画の記録を表示する。 */
  currentVideoKey: "currentVideoKey",
  timelineWindowId: "timelineWindowId",
  timelineTabId: "timelineTabId",
} as const;

export type StatusState = "connecting" | "listening" | "stopped" | "error";

/** background → content script */
export type ToContent =
  | { type: "kotodama:ping" }
  | { type: "kotodama:caption"; line: CaptionLine }
  | { type: "kotodama:live"; text: string }
  | { type: "kotodama:draft"; text: string }
  | { type: "kotodama:seek"; time: number }
  | { type: "kotodama:forget" }
  /** いま開いている動画の情報を返させる。返事は PageInfo。 */
  | { type: "kotodama:get-page" }
  /** on のあいだ、再生位置をタイムラインへ知らせ続ける（字幕から取り込んだ動画で、該当行を追いかけるため）。 */
  | { type: "kotodama:follow"; on: boolean }
  | { type: "kotodama:display"; display: DisplaySettings }
  | { type: "kotodama:status"; state: StatusState; message?: string; fatal?: boolean };

/** content script → background */
export type PageInfo = { key: string; url: string; title: string };

export type FromContent =
  | { type: "kotodama:get-display" }
  | { type: "kotodama:entry"; entry: TimelineEntry }
  /** いま開いている動画を知らせる。返事は保存済みの聞き取り済み区間（TimeRange[]）。 */
  | { type: "kotodama:page"; page: PageInfo }
  | { type: "kotodama:coverage"; key: string; ranges: TimeRange[] }
  /** 聞き取り済みの区間を再生しているあいだの再生位置。タイムラインが該当行を目立たせる。 */
  | { type: "kotodama:position"; time: number }
  /** skip が true のあいだは、聞き取り済みの区間を再生している。offscreen とタイムラインが受け取る。 */
  | { type: "kotodama:gate"; skip: boolean };

/** offscreen が起動時に background から受け取る情報 */
export type OffscreenInit = { settings: Settings; streamId: string; tabId: number };

/** offscreen → background */
export type FromOffscreen =
  | { target: "background"; type: "init" }
  | { target: "background"; type: "relay"; tabId: number; payload: ToContent };

/** 拡張のページ（タイムライン・パネル・ダッシュボード）→ background */
export type FromTimeline =
  | { type: "kotodama:save-summary"; key: string; summary: VideoSummary }
  | { type: "kotodama:delete-record"; key: string }
  /** 指定したタブの動画を、字幕から取り込んで訳す。replace なら保存済みの訳を消してから始める。返事は ImportResult。 */
  | { type: "kotodama:import"; tabId: number; replace: boolean }
  | { type: "kotodama:import-entries"; page: PageInfo; entries: TimelineEntry[] }
  | { type: "kotodama:import-done"; key: string; coverage: TimeRange[] }
  /** 指定したタブの翻訳を開始・停止する。返事は ToggleResult。 */
  | { type: "kotodama:toggle"; tabId: number };

export type ToggleResult = { active: boolean; error?: string };

/** 字幕からの取り込み。字幕の全文と、どの動画のものかを持つ。 */
export type ImportJob = { id: number; tabId: number; page: PageInfo; track: CaptionTrack; cues: CaptionCue[] };
export type ImportResult = { ok: boolean; error?: string };
