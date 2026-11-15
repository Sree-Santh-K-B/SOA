FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
# Uses the lockfile when one is committed (run `npm install` once locally to create it).
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY openapi.yaml ./
COPY migrations ./migrations
COPY src ./src

USER node
EXPOSE 3000
# Apply pending migrations, then start the API and the webhook worker.
CMD ["sh", "-c", "node src/migrate.js && node src/server.js"]
