# syntax = docker/dockerfile:1

ARG NODE_VERSION=20
FROM node:${NODE_VERSION}-alpine AS base

LABEL fly_launch_runtime="Node.js"

WORKDIR /app
ENV NODE_ENV="production"

# Build stage
FROM base AS build

# Need to set NODE_ENV to development for devDependencies
ENV NODE_ENV="development"

# Copy package files from server-browser
COPY server-browser/package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm install

# Copy source files
COPY server-browser/tsconfig.json ./
COPY server-browser/src ./src

# Build TypeScript
RUN npx tsc

# Production stage
FROM base AS production

# Copy package files
COPY server-browser/package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy built files from build stage
COPY --from=build /app/dist ./dist

# Expose port
EXPOSE 8787

# Run
CMD ["node", "dist/index.js"]
