#!/bin/bash
set -e

# Clean up stale Chrome locks
CHROME_PROFILE_DIR="${CHROME_PROFILE_DIR:-/home/node/chrome-profile}"
if [ -d "$CHROME_PROFILE_DIR" ]; then
  rm -f "$CHROME_PROFILE_DIR/SingletonLock" \
        "$CHROME_PROFILE_DIR/SingletonCookie" \
        "$CHROME_PROFILE_DIR/SingletonSocket" 2>/dev/null || true
fi
rm -rf /tmp/.org.chromium.Chromium.* /tmp/.com.google.Chrome.* 2>/dev/null || true

# Ensure Xvfb virtual display is running on :99
if ! pgrep -x "Xvfb" >/dev/null; then
  rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
  Xvfb :99 -screen 0 1920x1080x24 -ac &
  export DISPLAY=:99
fi

# Start DBUS if not running (critical for XDG and many GUI apps)
if [ -z "$DBUS_SESSION_BUS_ADDRESS" ]; then
  eval $(dbus-launch --sh-syntax)
fi

# Generate a convenient Openbox menu for debugging/VNC
mkdir -p "$HOME/.config/openbox"
cat << 'XML_EOF' > "$HOME/.config/openbox/menu.xml"
<?xml version="1.0" encoding="UTF-8"?>
<openbox_menu xmlns="http://openbox.org/3.4/menu">
  <menu id="root-menu" label="Openbox">
    <item label="Terminal (xterm)">
      <action name="Execute">
        <command>xterm</command>
      </action>
    </item>
    <item label="Google Chrome">
      <action name="Execute">
        <command>google-chrome --no-sandbox</command>
      </action>
    </item>
    <separator />
    <item label="Reconfigure">
      <action name="Reconfigure" />
    </item>
  </menu>
</openbox_menu>
XML_EOF

if ! pgrep -x "openbox" >/dev/null; then
  openbox &
fi

# Start x11vnc for VNC observation
if [ "${VNC_ENABLED:-true}" = "true" ]; then
  mkdir -p "$HOME/.vnc" && x11vnc -storepasswd "${VNC_PASSWORD:-connie}" "$HOME/.vnc/passwd" 2>/dev/null || true
  if ! pgrep -x "x11vnc" >/dev/null; then
    x11vnc -display :99 -rfbport "${VNC_PORT:-5900}" -rfbauth "$HOME/.vnc/passwd" -forever -shared -bg -o /tmp/x11vnc.log || true
  fi
fi

# Start headed Chrome on :99 with persistent profile and remote debugging
google-chrome-stable \
  --remote-debugging-port=${CHROME_DEBUG_PORT:-18800} \
  --remote-debugging-address=0.0.0.0 \
  --user-data-dir="$CHROME_PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-sync \
  --disable-background-networking \
  --disable-component-update \
  --disable-features=Translate,MediaRouter \
  --disable-session-crashed-bubble \
  --hide-crash-restore-bubble \
  --password-store=basic \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --no-proxy-server \
  --disable-blink-features=AutomationControlled \
  --safebrowsing-disable-download-protection \
  --window-size=1920,1080 \
  about:blank >/tmp/chrome.log 2>&1 &

exec "$@"
