// OpenAI API との通信。Chrome API に依存させず、Node の動作確認スクリプトからも読み込む。
// Node の型除去で読み込めるよう、import を持たず、消去可能な構文だけで書く。

export const REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
export const SAMPLE_RATE = 24000;

const API_BASE = "https://api.openai.com/v1";
const REQUEST_TIMEOUT_MS = 10_000;
const DRAFT_TIMEOUT_MS = 5_000;
const SUMMARY_TIMEOUT_MS = 90_000;

export class OpenAIError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function errorFrom(response: Response): Promise<OpenAIError> {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return new OpenAIError(response.status, parsed.error?.message ?? body);
  } catch {
    return new OpenAIError(response.status, body);
  }
}

type ReasoningEffort = "none" | "low" | "medium";

/**
 * Chat Completions を呼ぶ。
 * GPT-6 系は推論（reasoning）の既定が「中」で、そのままだと1回ごとの応答が遅い。字幕の翻訳では使わないので明示する。
 * この指定を受け付けない古いモデルでは 400 が返るので、その場合は指定を外してやり直す。
 */
async function chatCompletion(
  apiKey: string,
  body: Record<string, unknown>,
  reasoningEffort: ReasoningEffort,
  timeoutMs: number,
): Promise<Response> {
  const request = (payload: Record<string, unknown>) =>
    fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  const response = await request({ ...body, reasoning_effort: reasoningEffort });
  if (response.status !== 400) return response;
  const error = await errorFrom(response);
  if (!/reasoning/i.test(error.message)) throw error;
  return request(body);
}

/** 文字起こし専用セッションの設定。区切り（commit）はクライアント側で送る。 */
export function transcriptionSession(model: string) {
  // gpt-live-transcribe / gpt-transcribe は languages、それ以外は language を使う。
  const languageHint = model === "gpt-live-transcribe" || model === "gpt-transcribe" ? { languages: ["en"] } : { language: "en" };
  return {
    type: "transcription",
    audio: {
      input: {
        format: { type: "audio/pcm", rate: SAMPLE_RATE },
        transcription: { model, ...languageHint },
        turn_detection: null,
      },
    },
  };
}

/** ブラウザの WebSocket はヘッダーを付けられないので、短命の client secret を発行して使う。 */
export async function createClientSecret(apiKey: string, model: string): Promise<string> {
  const response = await fetch(`${API_BASE}/realtime/client_secrets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: 600 },
      session: transcriptionSession(model),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw await errorFrom(response);
  const data = (await response.json()) as { value?: string };
  if (!data.value) throw new OpenAIError(500, "client secret が返りませんでした");
  return data.value;
}

export function openRealtimeSocket(clientSecret: string): WebSocket {
  return new WebSocket(REALTIME_URL, ["realtime", `openai-insecure-api-key.${clientSecret}`]);
}

export type TranslationPair = { en: string; ja: string };
export type SentenceTranslation = { units: TranslationPair[]; remainder: string };

const SYSTEM_PROMPT = [
  "あなたは英語の動画の字幕翻訳者です。音声認識の結果を受け取り、日本語字幕を作ります。",
  "音声認識は音声を一定時間や短い無音で機械的に区切っているため、文の途中で切れていることがあります。",
  "区切りの位置に誤ったピリオドが入ったり、続きの先頭が大文字になったりします（例: \"tasks that are hard to automate. Require judgment.\" は1つの文）。",
  "",
  "手順:",
  "1. テキストを本来の文の区切りに直す。",
  "2. 意味が完結した文を、前から順に自然な日本語字幕に訳して units に入れる。1つの unit は1文を基本とし、短い文やまとめて読むべき文は2文までまとめてよい（日本語でおおむね60文字以内）。en にはその unit に対応する英文（区切りを直したもの）を入れる。",
  "3. 末尾の文がまだ途中で、続きが来る可能性がある場合は訳さず、その部分の英文を remainder にそのまま入れる。末尾まで完結していれば remainder は空文字にする。",
  "4. 音声認識の誤りと思われる語は文脈から推測して訳す。uh、um、you know などのフィラーは訳さない。",
  "訳文に説明・注釈・引用符は付けない。",
].join("\n");

const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "subtitles",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["units", "remainder"],
      properties: {
        units: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["en", "ja"],
            properties: { en: { type: "string" }, ja: { type: "string" } },
          },
        },
        remainder: { type: "string" },
      },
    },
  },
};

/**
 * 音声認識の結果を文の単位に直して訳す。末尾の未完の文は remainder として返す。
 * force のときは話が途切れたとみなし、残さずすべて訳させる。
 */
export async function translateSentences(
  apiKey: string,
  model: string,
  text: string,
  history: TranslationPair[],
  force: boolean,
  options: { precedingEn?: string; timeoutMs?: number } = {},
): Promise<SentenceTranslation> {
  const context = history.length
    ? `直前の字幕（文脈の参考。訳さない）:\n${history.map((pair) => `EN: ${pair.en}\nJA: ${pair.ja}`).join("\n")}\n\n`
    : options.precedingEn
      ? `直前の英文（文脈の参考。訳さない）:\n${options.precedingEn}\n\n`
      : "";
  const instruction = force ? "話がここで途切れました。末尾が途中でもすべて訳し、remainder は空文字にしてください。\n\n" : "";
  const response = await chatCompletion(
    apiKey,
    {
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `${context}${instruction}音声認識の結果:\n${text}` },
      ],
      response_format: RESPONSE_FORMAT,
    },
    "none",
    // 翻訳は直列に処理するので、1件が返らないと後続がすべて止まる。
    options.timeoutMs ?? REQUEST_TIMEOUT_MS,
  );
  if (!response.ok) throw await errorFrom(response);
  const data = (await response.json()) as { choices?: { message?: { content?: string; refusal?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new OpenAIError(500, data.choices?.[0]?.message?.refusal ?? "訳文が返りませんでした");
  const parsed = JSON.parse(content) as SentenceTranslation;
  return {
    units: parsed.units.filter((unit) => unit.ja.trim()),
    remainder: parsed.remainder.trim(),
  };
}

const DRAFT_PROMPT = [
  "あなたは英語の動画の同時字幕を作る翻訳者です。",
  "話している途中までの音声認識結果を受け取り、そこまでの内容を自然な日本語に訳します。",
  "文が途中で終わっている場合は、無理に言い切らず、そこまでの内容だけを訳してください。続きを推測して補わないでください。",
  "音声認識の誤りと思われる語は文脈から推測して訳し、uh、um などのフィラーは訳しません。",
  "訳文だけを出力し、説明・注釈・引用符は付けないでください。",
].join("\n");

/** 話している途中の英文を、仮の訳にする。確定の訳は translateSentences で作り直す。 */
export async function translateDraft(apiKey: string, model: string, text: string, history: TranslationPair[]): Promise<string> {
  const context = history.length
    ? `直前の字幕（文脈の参考。訳さない）:\n${history.map((pair) => `EN: ${pair.en}\nJA: ${pair.ja}`).join("\n")}\n\n`
    : "";
  const response = await chatCompletion(
    apiKey,
    {
      model,
      messages: [
        { role: "system", content: DRAFT_PROMPT },
        { role: "user", content: `${context}途中までの音声認識結果:\n${text}` },
      ],
    },
    "none",
    DRAFT_TIMEOUT_MS,
  );
  if (!response.ok) throw await errorFrom(response);
  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

export type SummaryLine = { index: number; time: string; en: string };
export type Summary = { overview: string; points: { index: number; text: string }[] };

const SUMMARY_PROMPT = [
  "あなたは英語の動画の内容を日本語でまとめる編集者です。",
  "入力は動画の音声認識結果で、1行が「[番号] 時刻 英文」の形です。音声認識の誤りは文脈から補って読んでください。",
  "",
  "次の2つを日本語で作ってください。",
  "- overview: ここまでの内容の概要。2〜4文。話し手の主張や結論が分かるように書く。",
  "- points: 要点の一覧。話の流れの順に、内容の長さに応じて3〜12個。text は1〜2文で具体的に書き、数字や固有名詞は落とさない。index にはその要点が話され始めた行の番号を入れる。",
  "入力に無い内容を補わないでください。まだ途中までの内容なので、結論が出ていなければ無理にまとめないでください。",
].join("\n");

const SUMMARY_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "summary",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["overview", "points"],
      properties: {
        overview: { type: "string" },
        points: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["index", "text"],
            properties: { index: { type: "integer" }, text: { type: "string" } },
          },
        },
      },
    },
  },
};

/** ここまでの内容を日本語でまとめる。 */
export async function summarize(apiKey: string, model: string, title: string, lines: SummaryLine[]): Promise<Summary> {
  const body = lines.map((line) => `[${line.index}] ${line.time} ${line.en}`).join("\n");
  // 内容を読んで要点を選ぶ作業なので、まとめだけは推論を少し使う。
  const response = await chatCompletion(
    apiKey,
    {
      model,
      messages: [
        { role: "system", content: SUMMARY_PROMPT },
        { role: "user", content: `${title ? `動画のタイトル: ${title}\n\n` : ""}${body}` },
      ],
      response_format: SUMMARY_FORMAT,
    },
    "low",
    SUMMARY_TIMEOUT_MS,
  );
  if (!response.ok) throw await errorFrom(response);
  const data = (await response.json()) as { choices?: { message?: { content?: string; refusal?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new OpenAIError(500, data.choices?.[0]?.message?.refusal ?? "まとめが返りませんでした");
  return JSON.parse(content) as Summary;
}
