# syntax = docker/dockerfile:1

ARG NODE_VERSION=20
FROM node:${NODE_VERSION}-alpine AS base

LABEL fly_launch_runtime="Node.js"

WORKDIR /app
ENV NODE_ENV="production"

# Build stage
FROM base AS build

ENV NODE_ENV="development"

# Copy all package files first
COPY common/package*.json ./common/
COPY server/package*.json ./server/

# Install common dependencies and build
WORKDIR /app/common
RUN npm install
COPY common/tsconfig.json ./
COPY common/src ./src
RUN npm run build

# Install server dependencies (link to common)
WORKDIR /app/server
RUN npm install
# Create node_modules link to common
RUN mkdir -p node_modules/@space-game && ln -s /app/common node_modules/@space-game/common

# Copy server source and build
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

# Copy data files
WORKDIR /app
COPY data ./data

# Production stage
FROM base AS production

WORKDIR /app

# Copy common built files and package
COPY --from=build /app/common/dist ./common/dist
COPY --from=build /app/common/package.json ./common/

# Copy server built files
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/

# Copy data
COPY --from=build /app/data ./data

# Install production dependencies
WORKDIR /app/common
RUN npm ci --omit=dev || npm install --omit=dev

WORKDIR /app/server
RUN npm ci --omit=dev || npm install --omit=dev
# Create node_modules link to common
RUN mkdir -p node_modules/@space-game && ln -s /app/common node_modules/@space-game/common

# Expose port
EXPOSE 3000

# Run
CMD ["node", "dist/index.js"]
