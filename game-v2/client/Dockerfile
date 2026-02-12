# Static file server for the game client
FROM node:20-alpine AS build

WORKDIR /app

# Copy common package files
COPY common/package*.json ./common/
WORKDIR /app/common
RUN npm install

# Copy common source and build
COPY common/tsconfig.json ./
COPY common/src ./src
RUN npm run build

# Copy client package files
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install

# Link common
RUN mkdir -p node_modules/@space-game && ln -s /app/common node_modules/@space-game/common

# Copy client source and build
COPY client/tsconfig.json ./
COPY client/vite.config.ts ./
COPY client/index.html ./
COPY client/sandbox.html ./
COPY client/src ./src
RUN npm run build

# Production - serve static files with nginx
FROM nginx:alpine

# Copy built files
COPY --from=build /app/client/dist /usr/share/nginx/html

# Custom nginx config for SPA
RUN echo 'server { \
    listen 80; \
    root /usr/share/nginx/html; \
    index index.html; \
    location / { \
        try_files $uri $uri/ /index.html; \
    } \
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ { \
        expires 1y; \
        add_header Cache-Control "public, immutable"; \
    } \
}' > /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
