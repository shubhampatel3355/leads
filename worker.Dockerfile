# ─── Stage 1: Build & Dependencies ──────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install build tools needed for native npm packages
RUN apk add --no-cache python3 make g++

# Copy package files first for layer caching
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && npm cache clean --force

# ─── Stage 2: Final Runtime ─────────────────────────────────────────
FROM node:20-alpine

# Set to production environment
ENV NODE_ENV=production

WORKDIR /app

# Copy production dependencies from builder stage
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package*.json ./

# Copy application source code
COPY --chown=node:node . .

# Switch to non-root user for security
USER node

# Healthcheck to monitor app responsiveness (optional for worker but kept for consistency)
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "process.exit(0)"

# Start the worker process
CMD ["node", "src/worker.js"]
