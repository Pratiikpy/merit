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
# Run as an unprivileged user. The node image ships a `node` user (uid 1000) for exactly this; without a USER
# the container runs as root, so a process compromise starts with root in the container rather than having to
# escalate to it. This server holds settlement keys, which makes the difference worth the one line.
# Ownership is set on copy so the runtime user can read the app without a recursive chown layer.
COPY --from=build --chown=node:node /app ./
# WORKDIR creates /app as root, and --chown only covers what is copied INTO it — so an unprivileged process
# still cannot create the document store and every ledger write fails with EACCES while the server otherwise
# looks healthy. Own the directory itself and pre-create the store. (Verified by running the image: without
# this, `mkdir /app/.data` is denied; with it, writes succeed.)
RUN mkdir -p /app/.data && chown node:node /app /app/.data
USER node
EXPOSE 3000
# next start respects $PORT (the host injects it); the agent self-calls 127.0.0.1:$PORT.
CMD ["npm", "run", "start"]
