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
    jq \
    xvfb \
    xdotool \
    xclip \
    xsel \
    wmctrl \
    x11vnc \
    git \
    procps \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/*

# Install Docker CLI (client only — no daemon) from Docker's official repo
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# Install Google Chrome stable for browser automation / Playwright
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub -o /etc/apt/keyrings/google-chrome.asc \
    && chmod a+r /etc/apt/keyrings/google-chrome.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/google-chrome.asc] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Enable Corepack for pnpm
RUN corepack enable

# Default environment
ENV HOME=/root
ENV DISPLAY=:99
ENV TERM=xterm-256color
ENV TZ=America/New_York
ENV LC_CWD=/home/node/workspace
ENV LIBRA_HOME=/home/node/workspace/.libra

# Prepare directory structure
RUN mkdir -p /app /home/node/workspace /home/node/hibriten-shared

COPY bin/* /usr/local/bin/
RUN chmod +x /usr/local/bin/*

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /app

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["pnpm", "start"]
