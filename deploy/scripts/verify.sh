#!/usr/bin/env bash
# 部署后验收：7 项检查，任一致命项失败则退出码非 0。
# 用法：bash verify.sh [域名]
#   bash verify.sh                 # 只查本机 127.0.0.1:3000
#   bash verify.sh tcg.example.com # 额外查公网 HTTPS 链路

set -uo pipefail

DOMAIN="${1:-}"

# 中文域名转 punycode（curl 未编译 libidn 时无法直接解析 UTF-8 域名）
if [[ -n "$DOMAIN" ]] && [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then
  if command -v python3 >/dev/null 2>&1; then
    ASCII="$(python3 -c 'import sys; print(sys.argv[1].strip().encode("idna").decode())' "$DOMAIN" 2>/dev/null || true)"
    [[ -n "$ASCII" ]] && { echo "  [INFO] 域名按 punycode 检查：$DOMAIN -> $ASCII"; DOMAIN="$ASCII"; }
  fi
fi
BASE="http://127.0.0.1:3000"
FAILED=0

ok(){   printf '  \033[32m[PASS]\033[0m %s\n' "$1"; }
bad(){  printf '  \033[31m[FAIL]\033[0m %s\n' "$1"; FAILED=$((FAILED+1)); }
info(){ printf '  \033[33m[INFO]\033[0m %s\n' "$1"; }

code(){ curl -s -o /dev/null -m 15 -w '%{http_code}' "$1" 2>/dev/null || echo 000; }

printf '\n== 服务端验收 ==\n'

# 1 健康检查
c=$(code "$BASE/api/healthz")
[[ "$c" == "200" ]] && ok "GET /api/healthz == 200" || bad "GET /api/healthz == $c（服务没起来或端口不对）"

# 2 版本接口
body=$(curl -s -m 15 "$BASE/api/version" 2>/dev/null || echo '')
if echo "$body" | grep -q '"currentGameVersion"'; then
  ok "GET /api/version 返回游戏版本：$(echo "$body" | grep -o '"currentGameVersion":"[^"]*"' | cut -d'"' -f4)"
  echo "$body" | grep -q '"hash":"unknown"' && info "revision.hash = unknown 属正常（容器内无 .git）"
else
  bad "GET /api/version 返回异常：$(echo "$body" | head -c 120)"
fi

# 3 前端首页
if curl -s -m 15 "$BASE/" | grep -qi '<html\|<!doctype'; then
  ok "首页返回 HTML（web-client 已被后端托管）"
else
  bad "首页不是 HTML，静态产物可能没打进镜像"
fi

# 4 静态资源
asset=$(curl -s -m 15 "$BASE/" | grep -o '/assets/[^"]*\.js' | head -1)
if [[ -n "$asset" ]]; then
  c=$(code "$BASE$asset")
  [[ "$c" == "200" ]] && ok "静态资源 $asset == 200" || bad "静态资源 $asset == $c"
else
  bad "首页里找不到 /assets/*.js，前端构建产物异常"
fi

# 5 数据库迁移
if command -v docker >/dev/null 2>&1; then
  st=$(docker compose --project-directory /opt/gi -f /opt/gi/compose.prod.yaml ps -a --format '{{.Service}} {{.State}} {{.ExitCode}}' 2>/dev/null \
       | grep '^migrate' || true)
  if [[ -n "$st" ]]; then
    echo "$st" | grep -q 'exited 0' && ok "migrate 执行成功（$st）" || bad "migrate 状态异常：$st"
  else
    info "未取到 migrate 状态（可能部署目录不是 /opt/gi）"
  fi
  errs=$(docker compose --project-directory /opt/gi -f /opt/gi/compose.prod.yaml logs --tail=80 server 2>/dev/null \
         | grep -E 'Error|error:|ECONNREFUSED|password authentication failed' | head -5 || true)
  [[ -z "$errs" ]] && ok "server 日志无异常关键字" || { bad "server 日志有报错："; echo "$errs" | sed 's/^/         /'; }
else
  info "无 docker 命令，跳过容器状态检查"
fi

# 6 资源占用
printf '\n== 资源 ==\n'
MEM_TOTAL=$(free -m | awk '/^Mem:/{print $2}')
MEM_USED=$(free -m | awk '/^Mem:/{print $3}')
SWAP_FREE=$(free -m | awk '/^Swap:/{print $4}')
echo "  内存 ${MEM_USED}/${MEM_TOTAL} MB, swap 剩余 ${SWAP_FREE} MB"
(( MEM_TOTAL - MEM_USED < 150 )) && bad "可用内存不足 150MB，随时可能 OOM" || ok "内存余量正常"
command -v docker >/dev/null 2>&1 && (docker stats --no-stream --format '  {{.Name}}  MEM {{.MemUsage}}  CPU {{.CPUPerc}}' 2>/dev/null || true)

# 7 公网链路
if [[ -n "$DOMAIN" ]]; then
  printf '\n== 公网链路 ==\n'
  c=$(code "https://$DOMAIN/api/healthz")
  [[ "$c" == "200" ]] && ok "https://$DOMAIN/api/healthz == 200" || bad "https://$DOMAIN/api/healthz == $c（DNS/证书/反代）"

  # SSE 必须不被缓冲：看响应头是否透传
  h=$(curl -s -o /dev/null -m 10 -D - "https://$DOMAIN/api/healthz" 2>/dev/null | tr -d '\r')
  echo "$h" | grep -qi '^server:' && info "反代标识：$(echo "$h" | grep -i '^server:' | head -1)"

  # 服务端会自发 X-Accel-Buffering: no，反代不应把它吃掉
  sse=$(curl -s -o /dev/null -m 10 -D - "https://$DOMAIN/api/rooms/1/players/0/notification" 2>/dev/null | tr -d '\r')
  if echo "$sse" | grep -qi 'x-accel-buffering'; then
    ok "SSE 响应头 X-Accel-Buffering 已透传（实时推送不会被缓冲）"
  else
    info "SSE 头未取到（房间不存在时返回 404 属正常，可忽略）"
  fi
fi

printf '\n== 结论 ==\n'
if (( FAILED == 0 )); then
  echo -e "  \033[32m全部通过。\033[0m 用两个浏览器窗口（其中一个无痕）各建/进一个房间，打完一回合验证实时同步。"
  exit 0
else
  echo -e "  \033[31m$FAILED 项失败\033[0m，对照 README 第 13 节排障表。"
  exit 1
fi
