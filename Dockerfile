# Debian, not Alpine: Playwright's Chromium (contest screenshots) needs glibc.
FROM oven/bun:1-slim
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile \
 && bun node_modules/playwright/cli.js install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/*
COPY src ./src
ENV DATA_DIR=/app/data TZ=Europe/Moscow
RUN mkdir -p /app/data
VOLUME /app/data
# Only listens when PUBLIC_URL is set (deadlines calendar feed).
EXPOSE 3000
CMD ["bun", "src/bot.mjs"]
