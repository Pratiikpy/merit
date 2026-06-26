# Merit — long-lived Node server (the SSE agent run needs a persistent process,
# not a serverless function). Works on Railway, Fly, Render (Docker), any host.
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# Copy the built app + installed deps from the build stage.
COPY --from=build /app ./
EXPOSE 3000
# next start respects $PORT (the host injects it); the agent self-calls 127.0.0.1:$PORT.
CMD ["npm", "run", "start"]
