// OpenAI との接続を拡張と同じ手順で確かめるスクリプト（macOS 用）。
// say で英語音声を作り、client secret → WebSocket → 文字起こし → 翻訳 の順に流す。
//
//   OPENAI_API_KEY=... pnpm smoke
//   TRANSCRIBE_MODEL=gpt-transcribe OPENAI_API_KEY=... pnpm smoke

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClientSecret, openRealtimeSocket, SAMPLE_RATE, translateSentences } from "../src/openai.ts";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("OPENAI_API_KEY を環境変数で渡してください");
  process.exit(1);
}
const transcribeModel = process.env.TRANSCRIBE_MODEL ?? "gpt-live-transcribe";
const translateModel = process.env.TRANSLATE_MODEL ?? "gpt-6.1-terra";
const text =
  "Welcome back to the channel. Today we are going to talk about how large language models actually work under the hood.";

function speechPcm() {
  const dir = mkdtempSync(join(tmpdir(), "kotodama-"));
  const wav = join(dir, "speech.wav");
  try {
    execFileSync("say", ["-o", wav, `--data-format=LEI16@${SAMPLE_RATE}`, text]);
    const file = readFileSync(wav);
    // WAV の data チャンクを探して PCM を取り出す。
    let offset = 12;
    while (offset < file.length) {
      const id = file.toString("ascii", offset, offset + 4);
      const size = file.readUInt32LE(offset + 4);
      if (id === "data") return file.subarray(offset + 8, offset + 8 + size);
      offset += 8 + size;
    }
    throw new Error("WAV に data チャンクがありません");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

const pcm = speechPcm();
console.log(`音声: ${(pcm.length / 2 / SAMPLE_RATE).toFixed(1)}秒 / 文字起こし: ${transcribeModel} / 翻訳: ${translateModel}`);

const secret = await createClientSecret(apiKey, transcribeModel);
console.log(`[${elapsed()}] client secret を発行しました`);

const ws = openRealtimeSocket(secret);
const timeout = setTimeout(() => {
  console.error("30秒以内に文字起こしが完了しませんでした");
  process.exit(1);
}, 30_000);

ws.onopen = async () => {
  console.log(`[${elapsed()}] WebSocket 接続 (protocol: ${ws.protocol})`);
  // 拡張と同じく 100ms ごとに実時間で送る。
  const chunkBytes = (SAMPLE_RATE / 10) * 2;
  for (let i = 0; i < pcm.length; i += chunkBytes) {
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.subarray(i, i + chunkBytes).toString("base64") }));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  console.log(`[${elapsed()}] commit を送信しました`);
};

let deltas = 0;
ws.onmessage = async (message) => {
  const event = JSON.parse(String(message.data));
  if (event.type === "conversation.item.input_audio_transcription.delta") {
    if (deltas++ === 0) console.log(`[${elapsed()}] 最初の delta: ${JSON.stringify(event.delta)}`);
    return;
  }
  console.log(`[${elapsed()}] ${event.type}${event.error ? ` ${JSON.stringify(event.error)}` : ""}`);
  if (event.type === "conversation.item.input_audio_transcription.completed") {
    console.log(`  delta ${deltas}件 / 文字起こし: ${event.transcript}（末尾に未完の文を足して翻訳します）`);
    // 文の途中で切れた入力を、文の単位に直して訳せるかも確かめる。
    const partial = await translateSentences(apiKey, translateModel, `${event.transcript} The first thing is that`, [], false);
    console.log(`[${elapsed()}] 翻訳: ${JSON.stringify(partial, null, 2)}`);
    clearTimeout(timeout);
    ws.close();
  }
};
ws.onclose = (event) => {
  console.log(`[${elapsed()}] 切断 (code ${event.code} ${event.reason})`);
  process.exit(0);
};
