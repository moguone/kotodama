#!/usr/bin/env bash
# README 用の画面を撮り直す（macOS と Google Chrome が必要）。
# ビルドした拡張の画面を、chrome API の代役（stub.js）と架空の講演データで表示して撮る。
#
#   pnpm build && scripts/screenshots/capture.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cp -R "$root/dist" "$work/app"
cp "$root/scripts/screenshots/stub.js" "$root/scripts/screenshots/popup-frame.html" "$work/app/"
for page in dashboard timeline popup; do
  # 各ページのスクリプトより先に、代役を読み込ませる。
  sed -i '' "s|<script src=\"$page.js\"></script>|<script src=\"stub.js\"></script><script src=\"$page.js\"></script>|" "$work/app/$page.html"
done

shot() { # 出力名 ページ 幅,高さ [追加の引数...]
  local name="$1" page="$2" size="$3"
  shift 3
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$work/profile" \
    --force-device-scale-factor=2 --window-size="$size" --virtual-time-budget=4000 \
    --allow-file-access-from-files "$@" \
    --screenshot="$root/docs/images/$name.png" "file://$work/app/$page.html" >/dev/null 2>&1
  echo "docs/images/$name.png"
}

mkdir -p "$root/docs/images"
shot dashboard dashboard 1280,860
# ヘッドレスの Chrome は幅 500px 未満にできないので、タイムラインは少し広めに撮る。
shot timeline timeline 520,760
shot popup popup-frame 500,660 --default-background-color=00000000
