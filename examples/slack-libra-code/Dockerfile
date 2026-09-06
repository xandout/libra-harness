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
    tini \
    xvfb \
    xdotool \
    xclip \
    xsel \
    wmctrl \
    x11vnc \
    openbox \
    git \
    procps \
    ca-certificates \
    curl \
    postgresql-client \
    python3-xdg \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /tmp/.X11-unix \
  && chmod 1777 /tmp/.X11-unix

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
ENV HOME=/home/node
ENV DISPLAY=:99
ENV TERM=xterm-256color
ENV TZ=America/New_York
ENV LC_CWD=/home/node/workspace
ENV LIBRA_HOME=/home/node/workspace/.libra
ENV BASH_ENV=/home/node/.bashrc

# Invalidate build cache whenever new commits are pushed to main,
# or when passing --build-arg CACHE_BUST=$(date +%s)
ARG CACHE_BUST=1
ADD https://api.github.com/repos/xandout/libra-harness/git/ref/heads/main /tmp/git-ref.json

# Clone and build the app at image build time
RUN echo "build cache-bust: $CACHE_BUST" \
  && mkdir -p /app /home/node/workspace \
  && rm -f /tmp/git-ref.json \
  && git clone https://github.com/xandout/libra-harness.git /app \
  && cd /app \
  && corepack enable \
  && pnpm install \
  && pnpm build \
  && pnpm --filter @xandout/libra-code build \
  && git config --system --add safe.directory '*' \
  && touch /home/node/.bashrc \
  && chown -R node:node /app /home/node

COPY bin/* /usr/local/bin/
RUN chmod +x /usr/local/bin/*

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER node
WORKDIR /home/node/workspace

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["pnpm", "--prefix", "/app/examples/slack-libra-code", "start"]
