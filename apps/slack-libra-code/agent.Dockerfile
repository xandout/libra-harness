# ── Stage 1: Build & Package ─────────────────────────────────────────
FROM node:24-bookworm AS builder

WORKDIR /src

ARG CACHE_BUST=1
ADD https://api.github.com/repos/xandout/libra-harness/git/ref/heads/main /tmp/git-ref.json

RUN echo "build cache-bust: $CACHE_BUST" \
  && rm -f /tmp/git-ref.json \
  && git clone https://github.com/xandout/libra-harness.git /src \
  && corepack enable \
  && pnpm install \
  && pnpm build \
  && pnpm --filter @xandout/libra-code build \
  && node -e ' \
       const fs = require("fs"); \
       const p = JSON.parse(fs.readFileSync("packages/libra-code/package.json")); \
       const h = JSON.parse(fs.readFileSync("package.json")); \
       p.dependencies["@xandout/libra-harness"] = h.version; \
       fs.writeFileSync("packages/libra-code/package.json", JSON.stringify(p, null, 2)); \
     ' \
  && mkdir -p /packages \
  && pnpm pack --pack-destination /packages \
  && cd packages/libra-code && pnpm pack --pack-destination /packages

# Prepare the Slack runner host in /opt/libra-harness and skills in /opt/skills
WORKDIR /src
RUN mkdir -p /opt/libra-harness /opt/skills \
  && cp -r /src/* /src/.[!.]* /opt/libra-harness/ 2>/dev/null || true \
  && if [ -d /src/skills ]; then cp -r /src/skills/* /opt/skills/; fi \
  && if [ -d /src/apps/slack-libra-code/skills ]; then cp -r /src/apps/slack-libra-code/skills/* /opt/skills/; fi

# ── Stage 2: Runtime Image (Slim Agent) ──────────────────────────────
FROM node:24-bookworm-slim

USER root

# Install basic agent utilities
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    jq \
    tini \
    git \
    procps \
    ca-certificates \
    curl \
    fd-find \
    ripgrep \
    poppler-utils \
    poppler-data \
    tesseract-ocr \
    tesseract-ocr-eng \
    ghostscript \
    imagemagick \
    postgresql-client \
    python3 \
    python3-pip \
    python3-venv \
  && rm -rf /var/lib/apt/lists/* \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd

# Enable Corepack for pnpm
RUN corepack enable

# Install Docker CLI (client only) for docker.sock mounts
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# Copy packaged tarballs from builder and install @xandout/libra-code globally
COPY --from=builder /packages /tmp/packages
RUN npm install -g /tmp/packages/*.tgz \
  && rm -rf /tmp/packages

# Copy Slack runner host and skills from builder
COPY --from=builder /opt/libra-harness /opt/libra-harness
COPY --from=builder /opt/skills /opt/skills

# Copy helper tools and entrypoint
COPY apps/slack-libra-code/bin/* /usr/local/bin/
RUN chmod +x /usr/local/bin/* || true

COPY apps/slack-libra-code/entrypoint-agent.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Setup workspace and directories
RUN mkdir -p /home/node/workspace \
  && git config --system --add safe.directory '*' \
  && touch /home/node/.bashrc \
  && chown -R node:node /opt/libra-harness /opt/skills /home/node

# Default environment
ENV HOME=/home/node
ENV TERM=xterm-256color
ENV TZ=America/New_York
ENV LC_CWD=/home/node/workspace
ENV LIBRA_HOME=/home/node/workspace/.libra
ENV LIBRA_SKILLS_DIR=/opt/skills
ENV BASH_ENV=/home/node/.bashrc
ENV CHROME_CDP_URL=http://browser:18800

USER node
WORKDIR /home/node/workspace

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["/opt/libra-harness/apps/slack-libra-code/node_modules/.bin/tsx", "/opt/libra-harness/apps/slack-libra-code/index.ts"]
