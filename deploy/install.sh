#!/usr/bin/env bash
# 一键拉取部署套件并执行部署（新机器上跑这一条就够）
#
# 用法：
#   curl -fsSLo /root/gi-install.sh \
#     https://raw.githubusercontent.com/Stellfract-Frost/genius-invokation/main/deploy/install.sh
#   sudo bash /root/gi-install.sh \
#     --domain 七圣召唤.com \
#     --email you@example.com \
#     --image ghcr.io/stellfract-frost/genius-invokation:latest \
#     --apply-nginx
#
# 本脚本只做三件事：下载 4 个文件到 /opt/gi-deploy → 校验 → 交给 deploy.sh
# 不删除任何已有文件，重复执行安全。

set -euo pipefail

RAW_BASE="https://raw.githubusercontent.com/Stellfract-Frost/genius-invokation/main/deploy"
DIR="/opt/gi-deploy"

ok(){ printf '\033[32m[OK]\033[0m %s\n' "$1"; }
die(){ printf '\033[31m[FAIL]\033[0m %s\n' "$1"; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 sudo 执行"

mkdir -p "$DIR/scripts"

echo "从 $RAW_BASE 拉取部署套件..."
fetch() {
  local rel="$1" out="$2"
  curl -fsSL --retry 3 --connect-timeout 10 "$RAW_BASE/$rel" -o "$out" \
    || die "下载失败：$rel"
  [[ -s "$out" ]] || die "下载到的文件为空：$rel"
}

fetch "compose.prod.yaml"      "$DIR/compose.prod.yaml"
fetch "scripts/preflight.sh"   "$DIR/scripts/preflight.sh"
fetch "scripts/deploy.sh"      "$DIR/scripts/deploy.sh"
fetch "scripts/verify.sh"      "$DIR/scripts/verify.sh"

chmod +x "$DIR/scripts/"*.sh
ok "已下载到 $DIR"

# 防御：确认拿到的是脚本而不是 404 页面
head -1 "$DIR/scripts/deploy.sh" | grep -q '^#!' || die "deploy.sh 内容异常，可能仓库路径变更"

echo
exec bash "$DIR/scripts/deploy.sh" "$@"
