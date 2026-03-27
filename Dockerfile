# Production Dockerfile for Backend
FROM node:20-alpine

# Install build dependencies (needed for some npm packages like bufferutil, utf-8-validate)
RUN apk add --no-cache python3 make g++ 

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (production only)
RUN npm ci --only=production

# Copy source code
COPY . .

# Expose port
EXPOSE 3000

# Command to run the application
CMD ["npm", "start"]
