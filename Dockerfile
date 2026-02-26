# Use a Node.js base image
FROM node:20-slim

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy project files
COPY . .

# Build the project (if necessary, though the custom setup serves index_updated.html)
# If your project uses Vite, you might need: RUN npm run build

# Expose the port
EXPOSE 5000

# Start the application
CMD ["npm", "run", "dev"]
