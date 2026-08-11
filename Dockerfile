# syntax=docker/dockerfile:1
ARG NODE_VERSION=22.14.0

FROM node:${NODE_VERSION}-slim AS base
ENV NODE_ENV=production
WORKDIR /app
# Prisma's query engine links against OpenSSL and the slim image has neither it
# nor the CA bundle Postgres TLS needs.
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# --- build -----------------------------------------------------------------
FROM base AS build
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends python3 build-essential \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# NODE_ENV=production is inherited from base, so dev dependencies have to be
# asked for explicitly — vite, the react-router compiler and the prisma CLI are
# all needed to build.
RUN npm ci --include=dev
COPY . .
# package.json: "build": "prisma generate && react-router build"
RUN npm run build
# Drop dev dependencies, but put the prisma CLI back: the Fly release command
# runs `prisma migrate deploy` from this image, and a CLI whose version has
# drifted from @prisma/client 6.19.3 is a real and confusing failure mode.
RUN npm prune --omit=dev && npm install --no-save prisma@6.19.3

# --- runtime ---------------------------------------------------------------
FROM base
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/build        /app/build
COPY --from=build /app/prisma       /app/prisma
COPY --from=build /app/package.json /app/package.json

ENV PORT=8080
EXPOSE 8080
USER node
CMD ["./node_modules/.bin/react-router-serve", "./build/server/index.js"]
