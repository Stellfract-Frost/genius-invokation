#!/usr/bin/env bash
# 只读体检脚本：不安装、不修改、不重启任何东西。
# 用法：bash preflight.sh tcg.example.com
# 把完整输出贴回来，我据此判断能不能直接部署。

set -uo pipefail

DOMAIN="${1:-}"

# 中文域名要先转 punycode，getent/dig 不认 UTF-8 域名
if [[ -n "$DOMAIN" ]] && [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then
  if command -v python3 >/dev/null 2>&1; then
    ASCII="$(python3 -c 'import sys; print(sys.argv[1].strip().encode("idna").decode())' "$DOMAIN" 2>/dev/null || true)"
    [[ -n "$ASCII" ]] && { echo "  中文域名 $DOMAIN 按 punycode 检查：$ASCII"; DOMAIN="$ASCII"; }
  elif command -v idn2 >/dev/null 2>&1; then
    ASCII="$(idn2 "$DOMAIN" 2>/dev/null || true)"
    [[ -n "$ASCII" ]] && DOMAIN="$ASCII"
  fi
fi
ok(){   printf '  \033[32m[OK]\033[0m   %s\n' "$1"; }
warn(){ printf '  \033[33m[WARN]\033[0m %s\n' "$1"; }
bad(){  printf '  \033[31m[FAIL]\033[0m %s\n' "$1"; }
sec(){  printf '\n== %s ==\n' "$1"; }

VERDICT=()

sec "系统"
if [[ -r /etc/os-release ]]; then
  . /etc/os-release
  echo "  发行版 : ${PRETTY_NAME:-unknown}"
fi
echo "  内核   : $(uname -srm)"
echo "  时区   : $(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo unknown)"
echo "  CPU    : $(nproc) 核  $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ *//')"

sec "内存与 swap"
free -m | sed 's/^/  /'
MEM_MB=$(free -m | awk '/^Mem:/{print $2}')
SWAP_MB=$(free -m | awk '/^Swap:/{print $2}')
if (( MEM_MB < 1900 )); then warn "物理内存 ${MEM_MB}MB，低于 2GB"; fi
if (( SWAP_MB < 512 )); then warn "swap 仅 ${SWAP_MB}MB，建议补到 2GB（deploy.sh 会做）"; else ok "swap ${SWAP_MB}MB 够用"; fi

sec "磁盘"
df -h / | sed 's/^/  /'
AVAIL_GB=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
if (( AVAIL_GB < 10 )); then bad "根分区剩余 ${AVAIL_GB}GB，镜像+数据库至少需要 10GB"; else ok "剩余 ${AVAIL_GB}GB"; fi
echo "  docker 根目录 : $(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo '未安装 docker')"

sec "Docker"
if command -v docker >/dev/null 2>&1; then
  ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"
  if docker compose version >/dev/null 2>&1; then
    ok "compose $(docker compose version --short 2>/dev/null || echo present)"
  else
    bad "缺少 docker compose 插件"
  fi
  if docker info >/dev/null 2>&1; then ok "当前用户可直接操作 docker"; else warn "当前用户无 docker 权限（deploy.sh 需 sudo 执行）"; fi
else
  warn "未安装 docker（deploy.sh 会用阿里云镜像源安装）"
fi

sec "端口占用（80/443/3000/5432）"
if command -v ss >/dev/null 2>&1; then
  for p in 80 443 3000 5432; do
    line=$(ss -lntpH "sport = :$p" 2>/dev/null | tail -n +2 | head -1)
    if [[ -n "$line" ]]; then
      proc=$(echo "$line" | grep -o 'users:((.*))' | sed 's/users:((//; s/))//' | cut -d, -f1)
      warn "端口 $p 已被占用：${proc:-未知进程}"
    else
      ok "端口 $p 空闲"
    fi
  done
else
  warn "无 ss 命令，跳过端口检查"
fi

sec "已存在的服务（判断是否已有反代/面板）"
[[ -d /www/server/panel ]] && warn "检测到宝塔面板：不要用脚本改 nginx，改在面板里操作" || ok "无宝塔面板"
if command -v nginx >/dev/null 2>&1; then
  ok "已安装 nginx $(nginx -v 2>&1 | sed 's#.*/##')"
  systemctl is-active --quiet nginx && ok "nginx 正在运行" || warn "nginx 已安装但未运行"
  ls /etc/nginx/conf.d/*.conf 2>/dev/null | sed 's/^/    现有配置：/' || true
else
  warn "未安装 nginx（deploy.sh 会装）"
fi
command -v pm2 >/dev/null 2>&1 && warn "检测到 pm2：本机已有 node 常驻服务，注意内存预算" || true
command -v caddy >/dev/null 2>&1 && warn "检测到 caddy：80/443 可能已被它占用" || true

sec "网络出口"
code=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' https://ghcr.io/v2/ 2>/dev/null || echo 000)
# GHCR 的 /v2/ 匿名访问固定返回 401，能拿到 401 就说明网络通
if [[ "$code" == "401" || "$code" == "200" ]]; then ok "ghcr.io 可达（HTTP $code，401 属正常）"; else bad "ghcr.io 不可达（HTTP $code），拉镜像会失败"; fi
code=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' https://github.com 2>/dev/null || echo 000)
[[ "$code" == "200" || "$code" == "301" || "$code" == "302" ]] && ok "github.com 可达" || warn "github.com 响应 $code（启用 GitHub 登录时可能受影响）"
code=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' https://api.github.com 2>/dev/null || echo 000)
[[ "$code" == "200" ]] && ok "api.github.com 可达" || warn "api.github.com 响应 $code（影响 GitHub 登录，不影响开服）"

sec "域名"
if [[ -z "$DOMAIN" ]]; then
  warn "未传域名参数，跳过解析检查（用法：bash preflight.sh 你的域名）"
else
  echo "  待检查域名：$DOMAIN"
  IP=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}')
  [[ -z "$IP" ]] && IP=$(dig +short A "$DOMAIN" 2>/dev/null | tail -1)
  if [[ -z "$IP" ]]; then
    bad "$DOMAIN 解析不到 A 记录 —— 先去域名商加解析，否则证书申请一定失败"
  else
    ok "$DOMAIN -> $IP"
    PUBIP=$(curl -sS -m 8 https://api.ipify.org 2>/dev/null || curl -sS -m 8 https://ifconfig.me 2>/dev/null || echo '')
    if [[ -n "$PUBIP" ]]; then
      echo "  本机公网 IP：$PUBIP"
      [[ "$IP" == "$PUBIP" ]] && ok "解析指向本机，正确" || bad "解析指向 $IP 但本机是 $PUBIP —— A 记录填错了，或还没生效"
    fi
  fi
fi

sec "结论"
echo "  这次体检不改变任何状态。"
echo "  若上面全是 OK / 可接受的 WARN，直接跑："
echo "    sudo bash deploy.sh --domain <你的域名> --email <你的邮箱> --image ghcr.io/<you>/genius-invokation:latest"
echo "  若出现 FAIL，先别部署，把输出贴回来。"
