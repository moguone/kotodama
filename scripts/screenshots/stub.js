// README 用の画面を撮るための、chrome API の代役。中身は架空の講演データ。
(() => {
  const page = location.pathname.split("/").pop();
  const T = (m, s) => m * 60 + s;
  const key = "yt:sample-talk";
  const title = "Shipping Small: How We Cut Review Time in Half (sample talk)";
  const url = "https://www.youtube.com/watch?v=sample-talk";
  const rows = [
    [T(0, 4), "Thanks for coming. Today I want to talk about why our pull requests used to take three days to merge.", "お越しいただきありがとうございます。今日は、私たちのプルリクエストがなぜマージまで3日もかかっていたのかをお話しします。"],
    [T(0, 13), "The short answer is that they were too big.", "ひとことで言うと、大きすぎたからです。"],
    [T(0, 17), "A reviewer who opens a diff with two thousand lines does not review it. They skim it and hope for the best.", "2,000行の差分を開いたレビュアーは、レビューをしません。ざっと眺めて、うまくいくことを祈るだけです。"],
    [T(0, 29), "So we set one rule: a change should be reviewable in fifteen minutes.", "そこで、ルールを1つだけ決めました。変更は15分でレビューできる大きさにする、というものです。"],
    [T(0, 37), "That sounds simple, but it changes how you plan the work.", "単純に聞こえますが、これは仕事の計画の立て方そのものを変えます。"],
    [T(0, 44), "You have to decide the order of the steps before you write any code.", "コードを書き始める前に、手順の順番を決めておく必要があるからです。"],
    [T(0, 52), "In the first month, the median time to merge went from seventy hours to thirty-one.", "最初の1か月で、マージまでの時間の中央値は70時間から31時間になりました。"],
    [T(1, 2), "And the number of bugs found after release dropped by about a third.", "リリース後に見つかるバグの数も、およそ3分の1減りました。"],
    [T(1, 9), "The surprising part was that people started asking for review earlier.", "意外だったのは、みんながレビューを早めに頼むようになったことです。"],
    [T(1, 16), "When a change is small, showing unfinished work feels safe.", "変更が小さいと、途中のものを見せることに抵抗がなくなるのです。"],
    [T(1, 23), "Let me show you the three habits that made this stick.", "これを定着させた3つの習慣をご紹介します。"],
  ];
  const base = Date.parse("2026-11-17T10:00:00+09:00");
  const entries = rows.map(([videoTime, en, ja], seq) => ({ seq, at: base + seq * 4000, videoTime, en, ja, key, url, title }));
  const record = {
    key, url, title, updatedAt: base + 600000, entries,
    coverage: [{ start: 0, end: 90 }],
    summary: {
      createdAt: base + 660000,
      overview: "プルリクエストが大きすぎることがレビューの遅れの原因だったとして、「15分でレビューできる大きさにする」というルールを導入した経緯と効果を紹介している。導入後、マージまでの時間とリリース後のバグがともに減った。",
      points: [
        { videoTime: T(0, 4), at: base, text: "以前はプルリクエストのマージに3日かかっており、原因は変更が大きすぎることだった。" },
        { videoTime: T(0, 29), at: base, text: "「変更は15分でレビューできる大きさにする」というルールを1つだけ決めた。" },
        { videoTime: T(0, 52), at: base, text: "最初の1か月で、マージまでの時間の中央値が70時間から31時間になり、リリース後のバグも約3分の1減った。" },
        { videoTime: T(1, 9), at: base, text: "変更が小さくなったことで、途中の段階でレビューを頼む人が増えた。" },
      ],
    },
  };
  const index = [
    { key, url, title, updatedAt: record.updatedAt, count: entries.length, hasSummary: true },
    { key: "yt:sample-2", url: "https://www.youtube.com/watch?v=sample-2", title: "Designing for Slow Networks (sample talk)", updatedAt: base - 86400000, count: 214, hasSummary: true },
    { key: "yt:sample-3", url: "https://www.youtube.com/watch?v=sample-3", title: "What We Learned Running Our First Incident Review (sample talk)", updatedAt: base - 3 * 86400000, count: 163, hasSummary: false },
    { key: "yt:sample-4", url: "https://www.youtube.com/watch?v=sample-4", title: "A Gentle Introduction to Type Systems (sample lecture)", updatedAt: base - 6 * 86400000, count: 402, hasSummary: true },
  ];
  const local = { apiKey: "sample", videoIndex: index, ["video:" + key]: record };
  const session = { currentVideoKey: key, timelineTabId: 1, ...(page === "timeline.html" ? { activeTabId: 1 } : {}) };
  const area = (store) => ({
    async get(keys) {
      if (typeof keys === "string") return { [keys]: store[keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, store[k]]));
      return Object.fromEntries(Object.keys(keys ?? store).map((k) => [k, store[k] ?? keys?.[k]]));
    },
    async set(values) { Object.assign(store, values); },
    async remove() {},
    async setAccessLevel() {},
  });
  const listeners = [];
  window.chrome = {
    runtime: {
      id: "sample",
      getURL: (path) => path,
      sendMessage: async () => undefined,
      openOptionsPage: async () => undefined,
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
    storage: { local: area(local), session: area(session), onChanged: { addListener() {} } },
    tabs: {
      query: async () => [{ id: 1, windowId: 1, url: "https://www.youtube.com/watch?v=another-talk", title: "Why Small Teams Ship Faster (sample talk) - YouTube" }],
      create: async () => undefined,
      update: async () => undefined,
      sendMessage: async () => undefined,
    },
    windows: { update: async () => undefined },
    scripting: {
      executeScript: async () => [{ result: { ok: true, isLive: false, tracks: [], choice: { languageCode: "en", kind: "asr", vssId: "a.en" } } }],
    },
  };
  if (page === "timeline.html") {
    const relay = (payload) => listeners.forEach((fn) => fn({ target: "background", type: "relay", tabId: 1, payload }));
    setTimeout(() => {
      relay({ type: "kotodama:status", state: "listening" });
      relay({ type: "kotodama:live", text: "The first habit is to write the description before the code, so the" });
      relay({ type: "kotodama:draft", text: "1つ目の習慣は、コードより先に説明文を書くことで、" });
    }, 400);
  }
})();
