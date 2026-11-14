# The relay's Node runtime (gate G4 fallback): the same core as the Worker, with the
# node:http2 APNs transport. Build from the repository root:
#   docker build -f cloud/push-relay/container/Dockerfile -t yaran-push-relay .
# Run with the same settings as wrangler.jsonc's vars and secrets as environment variables,
# plus PORT (default 8080) and RL_*_PER_MIN. Single instance: rate limits are per process.
FROM node:24-alpine
WORKDIR /app
COPY cloud/protocol/package.json cloud/protocol/package-lock.json cloud/protocol/
RUN cd cloud/protocol && npm ci --omit=dev --ignore-scripts
COPY cloud/protocol cloud/protocol
COPY cloud/push-relay/package.json cloud/push-relay/package-lock.json cloud/push-relay/
RUN cd cloud/push-relay && npm ci --omit=dev --ignore-scripts
COPY cloud/push-relay/src cloud/push-relay/src
USER node
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
WORKDIR /app/cloud/push-relay
CMD ["node", "src/runtime/node.ts"]
