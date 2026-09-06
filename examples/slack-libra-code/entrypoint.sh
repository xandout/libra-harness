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

# Pull latest code and rebuild (fast incremental — skips if already up to date)
cd /app
git pull || true
pnpm install --frozen-lockfile || true
pnpm build || true
pnpm --filter @xandout/libra-code build || true

# Ensure Xvfb virtual display is running on :99
if ! pgrep -x "Xvfb" >/dev/null; then
  rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
  Xvfb :99 -screen 0 1920x1080x24 -ac &
  export DISPLAY=:99
fi

if ! pgrep -x "openbox" >/dev/null; then
  openbox-session &
fi

# Start x11vnc for VNC observation
if [ "${VNC_ENABLED:-true}" = "true" ]; then
  mkdir -p "$HOME/.vnc" && x11vnc -storepasswd "${VNC_PASSWORD:-connie}" "$HOME/.vnc/passwd" 2>/dev/null || true
  if ! pgrep -x "x11vnc" >/dev/null; then
    x11vnc -display :99 -rfbport "${VNC_PORT:-5900}" -rfbauth "$HOME/.vnc/passwd" -forever -shared -bg -o /tmp/x11vnc.log || true
  fi
fi

# Start headed Chrome on :99 with persistent profile and remote debugging
if [ "${BROWSER_AUTOSTART:-false}" = "true" ]; then
  if command -v start-browser >/dev/null 2>&1; then
    start-browser || true
  fi
fi

# Execute CMD
exec "$@"
