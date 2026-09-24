FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY src ./src
ENV DATA_DIR=/app/data TZ=Europe/Moscow
RUN mkdir -p /app/data
VOLUME /app/data
CMD ["bun", "src/bot.mjs"]
