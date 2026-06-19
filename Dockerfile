# Use Node.js 20 Alpine base image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy application source code
COPY server.js ./
COPY public/ ./public/
COPY data/ ./data/

# Create uploads directory
RUN mkdir -p data/backups data/pdfs data/uploads

# Expose the port the app runs on
EXPOSE 3032

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3032

# Start the application
CMD ["node", "server.js"]
