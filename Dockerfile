# Debian, not Alpine: Playwright's Chromium (contest screenshots) needs glibc.
FROM oven/bun:1-slim
ARG TARGETARCH
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json bun.lock ./
# ffmpeg and the standalone yt-dlp binary download videos for the video topic;
# the bot updates yt-dlp itself once a day.
RUN bun install --production --frozen-lockfile \
 && bun node_modules/playwright/cli.js install --with-deps --only-shell chromium \
 && apt-get update && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && bun -e "await Bun.write('/usr/local/bin/yt-dlp', await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux' + (process.env.TARGETARCH === 'arm64' ? '_aarch64' : '')))" \
 && chmod +x /usr/local/bin/yt-dlp
COPY src ./src
ENV DATA_DIR=/app/data TZ=Europe/Moscow
RUN mkdir -p /app/data
VOLUME /app/data
# Only listens when PUBLIC_URL is set (deadlines calendar feed).
EXPOSE 3000
CMD ["bun", "src/bot.mjs"]
