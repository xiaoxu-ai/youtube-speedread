#!/usr/bin/env bash
# 生成所有图标方案的 PNG，并把指定的一套装成插件当前图标。
#
#   ./build.sh          # 重新生成全部，沿用当前方案
#   ./build.sh A3       # 重新生成，并切换到 A3
#   ./build.sh --list   # 看有哪些方案
#
# 方案来源：src/icon-<名字>.svg （大尺寸） + src/icon-<名字>-small.svg （16px 简化版）
# 16px 单独做简化版，否则细节会糊成一团。

set -euo pipefail
cd "$(dirname "$0")"

command -v rsvg-convert >/dev/null || { echo "需要 rsvg-convert：brew install librsvg"; exit 1; }

# 收集所有方案名：有 icon-X.svg 且有 icon-X-small.svg 的才算
VARIANTS=()
for f in src/icon-*.svg; do
  base="$(basename "$f" .svg)"
  base="${base#icon-}"
  case "$base" in
    *-small) continue ;;
  esac
  [ -f "src/icon-${base}-small.svg" ] || continue
  VARIANTS+=("$base")
done

if [ "${1:-}" = "--list" ]; then
  echo "可用方案：${VARIANTS[*]}"
  echo "当前：$(cat .current 2>/dev/null || echo '(未设置)')"
  exit 0
fi

for v in "${VARIANTS[@]}"; do
  rsvg-convert -w 128 -h 128 "src/icon-$v.svg"       -o "variant-$v-128.png"
  rsvg-convert -w  48 -h  48 "src/icon-$v.svg"       -o "variant-$v-48.png"
  rsvg-convert -w  16 -h  16 "src/icon-$v-small.svg" -o "variant-$v-16.png"
done
echo "已生成 ${#VARIANTS[@]} 套 PNG：${VARIANTS[*]}"

if [ -n "${1:-}" ]; then
  found=0
  for v in "${VARIANTS[@]}"; do [ "$v" = "$1" ] && found=1; done
  if [ "$found" -ne 1 ]; then
    echo "没有这个方案：$1"
    echo "可选：${VARIANTS[*]}"
    exit 1
  fi
  echo "$1" > .current
fi

CUR="$(cat .current 2>/dev/null || echo "${VARIANTS[0]}")"
for s in 16 48 128; do
  cp "variant-$CUR-$s.png" "icon$s.png"
done
# 注意必须写 ${CUR}：紧跟中文全角括号时，$CUR 会被 bash 当成变量名的一部分
echo "当前使用方案：${CUR}（换别的：./build.sh A5）"
