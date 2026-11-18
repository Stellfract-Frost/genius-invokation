#!/usr/bin/env bash
# 一键部署（幂等，可重复执行；不删数据、不动已有网站配置）
# 前提：compose.prod.yaml 与本脚本同目录（或 --dir 指定）
#
# 用法：
#   sudo bash deploy.sh --domain tcg.example.com --email you@example.com \
#        --image ghcr.io/yourname/genius-invokation:latest
#
# 可选：
#   --dir /opt/gi          安装目录（默认 /opt/gi）
#   --no-tls               只起服务，不配 HTTPS
#   --apply-nginx          自动写入 /etc/nginx/conf.d 并 reload（检测到宝塔时自动跳过）
#   --ghcr-user X --ghcr-token Y   镜像仓库是私有时用
#   --skip-swap            不加 swap

set -euo pipefail

DOMAIN=""
EMAIL=""
IMAGE=""
DIR="/opt/gi"
DO_TLS=1
APPLY_NGINX=0
GHCR_USER=""
GHCR_TOKEN=""
SKIP_SWAP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --image) IMAGE="${2:-}"; shift 2 ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --no-tls) DO_TLS=0; shift ;;
    --apply-nginx) APPLY_NGINX=1; shift ;;
    --ghcr-user) GHCR_USER="${2:-}"; shift 2 ;;
    --ghcr-token) GHCR_TOKEN="${2:-}"; shift 2 ;;
    --skip-swap) SKIP_SWAP=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$1"; exit 1 ;;
  esac
done

ok(){   printf '\033[32m[OK]\033[0m %s\n' "$1"; }
step(){ printf '\n\033[1m>>> %s\033[0m\n' "$1"; }
die(){ printf '\033[31m[FAIL]\033[0m %s\n' "$1"; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 sudo 执行"
[[ -n "$IMAGE" ]] || die "缺少 --image（镜像地址）"
if (( DO_TLS )) && [[ -z "$DOMAIN" ]]; then die "缺少 --domain（或用 --no-tls 跳过 HTTPS）"; fi

# 中文域名（IDN）必须转成 punycode：浏览器的 Host 头、nginx server_name、
# 证书 CSR 用的都是 A-label 形式，直接用中文一定会 404 / 证书失败。
to_ascii() {
  local d="$1"
  if [[ "$d" =~ ^[A-Za-z0-9.-]+$ ]]; then printf '%s' "$d"; return 0; fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys; print(sys.argv[1].strip().encode("idna").decode())' "$d" 2>/dev/null && return 0
  fi
  if command -v idn2 >/dev/null 2>&1; then idn2 "$d" 2>/dev/null && return 0; fi
  return 1
}

DOMAIN_ASCII=""
if [[ -n "$DOMAIN" ]]; then
  if ! DOMAIN_ASCII="$(to_ascii "$DOMAIN")"; then
    die "域名含非 ASCII 字符且本机无 python3/idn2，请自行转换后用 --domain xn--... 形式"
  fi
  if [[ "$DOMAIN_ASCII" != "$DOMAIN" ]]; then
    ok "中文域名已转 punycode：$DOMAIN  →  $DOMAIN_ASCII"
  fi
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_SRC="$SCRIPT_DIR/compose.prod.yaml"
[[ -f "$COMPOSE_SRC" ]] || COMPOSE_SRC="$SCRIPT_DIR/../compose.prod.yaml"
[[ -f "$COMPOSE_SRC" ]] || die "找不到 compose.prod.yaml，请与脚本放在同一目录"

DC=(docker compose --project-directory "$DIR" -f "$DIR/compose.prod.yaml" --env-file "$DIR/.env")

# 0. 基础工具
if ! command -v curl >/dev/null 2>&1; then
  apt-get update -y && apt-get install -y curl ca-certificates
fi

# ---------- 1. swap ----------
step "1/7 swap"
if (( SKIP_SWAP )); then
  echo "  已跳过"
elif swapon --show | grep -q .; then
  ok "已有 swap：$(free -m | awk '/^Swap:/{print $2}')MB"
else
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "已添加 2GB swap 并写入 fstab"
fi

# ---------- 2. docker ----------
step "2/7 docker"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "docker $(docker --version | awk '{print $3}' | tr -d ,) + compose 已就绪"
else
  echo "  安装 docker（走阿里云镜像源，境内更快）..."
  if ! curl -fsSL https://get.docker.com | sh -s -- --mirror Aliyun; then
    die "docker 安装失败：请手动安装后重跑，或改用 https://get.docker.com 直连"
  fi
  systemctl enable --now docker
  ok "docker 安装完成"
fi

# ---------- 3. 目录与 compose ----------
step "3/7 目录与 compose"
mkdir -p "$DIR"
install -m 644 "$COMPOSE_SRC" "$DIR/compose.prod.yaml"
ok "$DIR/compose.prod.yaml"

# ---------- 4. .env ----------
step "4/7 .env"
if [[ -f "$DIR/.env" ]]; then
  ok ".env 已存在，保留原密钥（不要覆盖：postgres 密码只在初始化时生效）"
  if grep -q '^SERVER_IMAGE=' "$DIR/.env"; then
    sed -i "s#^SERVER_IMAGE=.*#SERVER_IMAGE=${IMAGE}#" "$DIR/.env"
  else
    printf 'SERVER_IMAGE=%s\n' "$IMAGE" >> "$DIR/.env"
  fi
  ok "已把 SERVER_IMAGE 更新为 ${IMAGE}"
else
  PG_PW=$(openssl rand -hex 16)
  JWT=$(openssl rand -hex 32)
  cat > "$DIR/.env" <<EOF
# 由 deploy.sh 生成于 $(date '+%F %T')，权限 600
SERVER_IMAGE=${IMAGE}
POSTGRES_PASSWORD=${PG_PW}
JWT_SECRET=${JWT}
GH_CLIENT_ID=
GH_CLIENT_SECRET=
GH_CODE_EXCHANGE_URL=
GH_GET_USER_API_URL=
DEBUG_LOG_RECEIVE_URL=
EOF
  chmod 600 "$DIR/.env"
  ok "已生成 .env（随机 16 字节库密码 + 32 字节 JWT 密钥）"
fi
chmod 600 "$DIR/.env"

# ---------- 5. 拉镜像 ----------
step "5/7 拉取镜像"
if ! docker pull "$IMAGE"; then
  if [[ -n "$GHCR_USER" && -n "$GHCR_TOKEN" ]]; then
    echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
    docker pull "$IMAGE" || die "登录后仍拉不到镜像，检查镜像名大小写与 packages 权限"
  else
    die "拉取失败。若是私有包，加 --ghcr-user 与 --ghcr-token（PAT 需 read:packages）"
  fi
fi
ok "镜像已就位：$IMAGE"

# ---------- 6. 启动 ----------
step "6/7 启动容器"
"${DC[@]}" up -d
echo "  等待 /api/healthz 就绪（首次冷启动需编译 TS，最多 180 秒）..."
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/healthz 2>/dev/null || echo 000)
  if [[ "$code" == "200" ]]; then ok "健康检查通过（第 ${i} 次探测）"; break; fi
  sleep 3
  if [[ $i -eq 60 ]]; then
    "${DC[@]}" ps -a
    "${DC[@]}" logs --tail=40 server
    die "180 秒内未就绪，日志见上"
  fi
done
"${DC[@]}" ps -a

# ---------- 7. HTTPS ----------
step "7/7 HTTPS"
if (( ! DO_TLS )); then
  echo "  已按 --no-tls 跳过。当前可访问：http://<公网IP>:3000（需放行 3000）"
else
  CONF="$DIR/nginx-$DOMAIN_ASCII.conf"
  cat > "$CONF" <<'NGINX'
server {
    listen 80;
    server_name __DOMAIN__;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl;
    http2 on;
    server_name __DOMAIN__;
    ssl_certificate     /etc/letsencrypt/live/__DOMAIN__/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/__DOMAIN__/privkey.pem;
    client_max_body_size 4m;
    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NGINX
  sed -i "s#__DOMAIN__#${DOMAIN_ASCII}#g" "$CONF"
  ok "反代配置已生成：$CONF"

  if [[ -d /www/server/panel ]]; then
    echo ""
    echo "  检测到宝塔面板，为避免与面板托管冲突，脚本不改 nginx。请按以下步骤操作："
    echo "   1) 面板 → 网站 → 添加站点，域名填 $DOMAIN_ASCII（纯静态、不要 PHP）"
    echo "      （中文域名必须用 punycode 形式，面板不接受中文）"
    echo "   2) 站点设置 → SSL → Let's Encrypt → 申请（勾选强制 HTTPS）"
    echo "   3) 站点设置 → 反向代理 → 目标 http://127.0.0.1:3000（缓存必须关闭）"
    echo "   4) 或者把 $CONF 的内容粘贴进该站点的配置文件替换默认 location"
    echo "  参考配置：$CONF"
  elif (( APPLY_NGINX )); then
    command -v nginx >/dev/null 2>&1 || { apt-get update -y && apt-get install -y nginx; }
    command -v certbot >/dev/null 2>&1 || { apt-get install -y certbot python3-certbot-nginx; }
    cp "$CONF" "/etc/nginx/conf.d/$DOMAIN_ASCII.conf"
    if certbot --nginx -d "$DOMAIN_ASCII" --agree-tos -m "$EMAIL" --redirect -n; then
      nginx -t && systemctl reload nginx && ok "证书已签发，nginx 已 reload"
    else
      rm -f "/etc/nginx/conf.d/$DOMAIN_ASCII.conf"
      nginx -t >/dev/null 2>&1 && systemctl reload nginx
      die "证书申请失败（DNS 未生效或 80 端口不通）。已回滚 nginx 配置，服务本身仍在 127.0.0.1:3000 正常"
    fi
  else
    echo ""
    echo "  未加 --apply-nginx，没有改系统 nginx。手动执行："
    echo "   sudo apt-get install -y nginx certbot python3-certbot-nginx"
    echo "   sudo cp $CONF /etc/nginx/conf.d/$DOMAIN_ASCII.conf"
    echo "   sudo certbot --nginx -d $DOMAIN_ASCII --agree-tos -m $EMAIL --redirect"
  fi
fi

# ---------- 收尾 ----------
step "完成"
if [[ -f "$SCRIPT_DIR/verify.sh" ]]; then bash "$SCRIPT_DIR/verify.sh" || true; fi
echo ""
echo "  部署目录：$DIR"
echo "  改配置后重启：cd $DIR && docker compose -f compose.prod.yaml up -d"
echo "  看日志：cd $DIR && docker compose -f compose.prod.yaml logs -f server"
