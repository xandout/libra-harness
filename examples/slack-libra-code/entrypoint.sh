#!/bin/bash
set -e

# Target workspace directory
export LC_CWD="${LC_CWD:-/home/node/workspace}"
export LIBRA_HOME="${LIBRA_HOME:-${LC_CWD}/.libra}"
mkdir -p "${LC_CWD}" "${LIBRA_HOME}"

# Source workspace .env if present
if [ -f "${LC_CWD}/.env" ]; then
  source "${LC_CWD}/.env"
fi

# Ensure Xvfb virtual display is running on :99
if ! pgrep -x "Xvfb" >/dev/null; then
  Xvfb :99 -screen 0 1920x1080x24 -ac &
  export DISPLAY=:99
fi

if ! pgrep -x "openbox" >/dev/null; then
  openbox-session &
fi

# Start x11vnc for VNC observation
if [ "${VNC_ENABLED:-true}" = "true" ]; then
  mkdir -p /root/.vnc && x11vnc -storepasswd "${VNC_PASSWORD:-connie}" /root/.vnc/passwd 2>/dev/null || true
  if ! pgrep -x "x11vnc" >/dev/null; then
    x11vnc -display :99 -rfbport "${VNC_PORT:-5900}" -rfbauth /root/.vnc/passwd -forever -shared -bg -o /tmp/x11vnc.log || true
  fi
fi

# Start headed Chrome on :99 with persistent profile and remote debugging
if [ "${BROWSER_AUTOSTART:-true}" = "true" ]; then
  if command -v start-browser >/dev/null 2>&1; then
    start-browser || true
  fi
fi

# If repo is not yet cloned in /app, clone it
if [ ! -d "/app/.git" ] && [ ! -f "/app/package.json" ]; then
  git clone https://github.com/xandout/libra-harness.git /app
  cd /app
  pnpm install
  pnpm build
  pnpm --filter @xandout/libra-code build
  cd /app/examples/slack-libra-code
elif [ -f "/app/package.json" ] && [ -d "/app/examples/slack-libra-code" ]; then
  cd /app
  if [ -d "/app/.git" ]; then
    git pull || true
  fi
  pnpm install
  pnpm build
  pnpm --filter @xandout/libra-code build
  cd /app/examples/slack-libra-code
fi

# Execute CMD
exec "$@"
