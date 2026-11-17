import { context, build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");

await rm("dist", { recursive: true, force: true });
await mkdir("dist");
await cp("static", "dist", { recursive: true });

const common = {
  bundle: true,
  outdir: "dist",
  target: "chrome116",
  logLevel: "info",
  sourcemap: watch ? "inline" : false,
};

const configs = [
  // service worker は manifest で type: module を指定している。
  { ...common, entryPoints: { background: "src/background.ts" }, format: "esm" },
  {
    ...common,
    entryPoints: {
      offscreen: "src/offscreen.ts",
      content: "src/content.ts",
      options: "src/options.ts",
      timeline: "src/timeline.ts",
      popup: "src/popup.ts",
      dashboard: "src/dashboard.ts",
      "pcm-worklet": "src/pcm-worklet.ts",
    },
    format: "iife",
  },
];

if (watch) {
  for (const config of configs) await (await context(config)).watch();
  console.log("watching src/ (static/ の変更は再起動で反映)");
} else {
  await Promise.all(configs.map((config) => build(config)));
}
