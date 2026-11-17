// YouTube の字幕データの取り込み。
//
// 字幕のURLは、直接取りに行くと空で返る（認証用の値が要る）。そこで、プレイヤーに目的の字幕を選ばせ、
// そのときプレイヤーが読み込むURLをそのまま使って取得する。URLの言語だけを書き換える方法は空で返る。

export type CaptionTrack = { languageCode: string; kind: "asr" | "manual"; vssId: string };
export type CaptionCue = { start: number; end: number; text: string };
export type CaptionsResult = {
  ok: boolean;
  error?: string;
  isLive: boolean;
  tracks: CaptionTrack[];
  /** 取り込みに使う字幕。日本語（投稿者のもの）→ 英語（投稿者のもの）→ 英語（自動生成）の順で選ぶ。 */
  choice?: CaptionTrack;
  cues?: CaptionCue[];
};

/**
 * ページ（MAIN world）の中で実行する。chrome.scripting.executeScript に関数ごと渡すので、
 * この関数の外にある値や関数を参照してはいけない。
 * mode が "list" なら字幕の一覧と選択だけ、"grab" なら字幕の中身も返す。
 */
export async function captionsInPage(mode: "list" | "grab"): Promise<CaptionsResult> {
  type RawTrack = { languageCode: string; kind?: string; vss_id?: string };
  type Player = HTMLElement & {
    loadModule?: (name: string) => void;
    getOption?: (module: string, option: string, params?: unknown) => unknown;
    setOption?: (module: string, option: string, value: unknown) => void;
    getVideoData?: () => { isLive?: boolean } | undefined;
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const fail = (error: string, isLive = false, tracks: CaptionTrack[] = []): CaptionsResult => ({ ok: false, error, isLive, tracks });

  const player = document.querySelector<Player>("#movie_player");
  if (!player?.getOption || !player.setOption) return fail("動画プレイヤーが見つかりません");

  try {
    player.loadModule?.("captions");
  } catch {
    // すでに読み込まれている場合などは無視する。
  }
  let raw: RawTrack[] = [];
  for (let attempt = 0; attempt < 10; attempt++) {
    raw = (player.getOption("captions", "tracklist", { includeAsr: true }) as RawTrack[] | undefined) ?? [];
    if (raw.length > 0) break;
    await sleep(200);
  }
  const isLive = Boolean(player.getVideoData?.()?.isLive);
  const tracks: CaptionTrack[] = raw.map((track) => ({
    languageCode: track.languageCode,
    kind: track.kind === "asr" ? "asr" : "manual",
    vssId: track.vss_id ?? "",
  }));
  const find = (language: string, kind: "asr" | "manual") =>
    tracks.find((track) => track.languageCode.startsWith(language) && track.kind === kind);
  const choice = find("ja", "manual") ?? find("en", "manual") ?? find("en", "asr");

  if (isLive) return fail("ライブ配信中は字幕の全文がありません", true, tracks);
  if (!choice) return fail("取り込める字幕（日本語または英語）がありません", false, tracks);
  if (mode === "list") return { ok: true, isLive, tracks, choice };

  // プレイヤーが字幕を読み込むURLを拾う。
  const matches = (name: string): boolean => {
    if (!name.includes("/api/timedtext")) return false;
    const params = new URL(name).searchParams;
    return params.get("lang") === choice.languageCode && (params.get("kind") === "asr") === (choice.kind === "asr") && !params.get("tlang");
  };
  const seen: string[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) if (matches(entry.name)) seen.push(entry.name);
  });
  observer.observe({ type: "resource", buffered: true });

  const button = document.querySelector<HTMLElement>(".ytp-subtitles-button");
  const wasOn = button?.getAttribute("aria-pressed") === "true";
  const previous = wasOn ? (player.getOption("captions", "track") as RawTrack | undefined) : undefined;
  let body = "";
  try {
    if (!wasOn) button?.click();
    await sleep(400);
    const target = raw.find((track) => (track.vss_id ?? "") === choice.vssId && track.languageCode === choice.languageCode);
    player.setOption("captions", "track", target);
    for (let attempt = 0; attempt < 40 && seen.length === 0; attempt++) await sleep(250);
    const url = seen.at(-1);
    if (!url) return fail("字幕データを取得できませんでした。ページを再読み込みしてから、もう一度試してください", false, tracks);
    body = await (await fetch(url)).text();
  } finally {
    observer.disconnect();
    // 字幕の表示を元に戻す。
    if (!wasOn) button?.click();
    else if (previous?.languageCode) player.setOption("captions", "track", previous);
  }

  type Event = { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[] };
  let events: Event[];
  try {
    events = (JSON.parse(body) as { events?: Event[] }).events ?? [];
  } catch {
    return fail("字幕データを読み取れませんでした（空の応答）", false, tracks);
  }
  const cues: CaptionCue[] = [];
  for (const event of events) {
    const text = (event.segs ?? [])
      .map((segment) => segment.utf8 ?? "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    // 空行や、[Music] のような効果音の表記は捨てる。
    if (!text || /^\[[^\]]*\]$/.test(text)) continue;
    const start = (event.tStartMs ?? 0) / 1000;
    cues.push({ start, end: start + (event.dDurationMs ?? 0) / 1000, text });
  }
  // 自動生成の字幕は表示時間が重なっているので、終わりは次の字幕の始まりに合わせる。
  for (let index = 0; index < cues.length - 1; index++) cues[index].end = Math.max(cues[index].start, cues[index + 1].start);
  if (cues.length === 0) return fail("字幕が空でした", false, tracks);
  return { ok: true, isLive, tracks, choice, cues };
}
