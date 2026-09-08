FROM node:24-bookworm

USER root

# Install system utilities, imaging, OCR, and X11 tools
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    poppler-utils \
    poppler-data \
    tesseract-ocr \
    tesseract-ocr-eng \
    ghostscript \
    imagemagick \
    tini \
    xvfb \
    xdotool \
    xclip \
    xsel \
    wmctrl \
    x11vnc \
    openbox \
    procps \
    curl \
    python3-xdg \
    xdg-utils \
    dbus-x11 \
    x11-utils \
    x11-xserver-utils \
    xautomation \
    xinput \
    scrot \
    xterm \
    menu \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /tmp/.X11-unix \
  && chmod 1777 /tmp/.X11-unix

# Install Google Chrome stable
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub -o /etc/apt/keyrings/google-chrome.asc \
    && chmod a+r /etc/apt/keyrings/google-chrome.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/google-chrome.asc] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

COPY apps/slack-libra-code/entrypoint-browser.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Setup user and directories
RUN mkdir -p /home/node/workspace \
  && chown -R node:node /home/node

ENV HOME=/home/node
ENV DISPLAY=:99
ENV TERM=xterm-256color
ENV TZ=America/New_York

USER node
WORKDIR /home/node/workspace

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["tail", "-f", "/dev/null"]
