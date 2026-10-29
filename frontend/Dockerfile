# Dev-only image: this serves the Vite dev server, which is what the workshop
# runs. There is no production stage here on purpose — serving the built MPA
# needs a static server configured for the trailing-slash routing described in
# the README, and nothing in this repo makes that choice yet.
#
# Vite is bound to 0.0.0.0 rather than localhost because a dev server listening
# on the container's loopback is unreachable from the published port.
# --strictPort for the same reason `make run-frontend` uses it: the origin has
# to stay :5173 to match the Collector's cors.allowed_origins.
FROM node:24-alpine AS dev
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json vite.config.ts index.html ./
COPY checkout ./checkout
COPY payment ./payment
COPY tracking ./tracking
COPY src ./src

EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173", "--strictPort"]
