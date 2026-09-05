#!/bin/bash
set -e

# Start Xvfb virtual display if not already running
if ! pgrep -x "Xvfb" >/dev/null; then
  Xvfb :99 -screen 0 1920x1080x24 -ac &
  export DISPLAY=:99
fi

# Optional: start x11vnc if VNC_ENABLED is set to true
if [ "${VNC_ENABLED:-false}" = "true" ]; then
  mkdir -p /home/node/.vnc && x11vnc -storepasswd "${VNC_PASSWORD:-connie}" /home/node/.vnc/passwd 2>/dev/null
  x11vnc -display :99 -rfbport "${VNC_PORT:-5900}" -rfbauth /home/node/.vnc/passwd -forever -shared -bg -o /tmp/x11vnc.log
fi

# Target workspace directory
export LC_CWD="${LC_CWD:-/home/node/workspace}"
export LIBRA_HOME="${LIBRA_HOME:-${LC_CWD}/.libra}"
mkdir -p "${LC_CWD}" "${LIBRA_HOME}"

# Source workspace .env if present
if [ -f "${LC_CWD}/.env" ]; then
  source "${LC_CWD}/.env"
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
