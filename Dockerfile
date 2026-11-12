FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js migrate.js ./
COPY migrations ./migrations
USER node
EXPOSE 3000
CMD ["sh", "-c", "node migrate.js && node server.js"]
