FROM node:18-alpine

# Install dependency dasar Alpine buat compatibility binary cloudflared
RUN apk add --no-cache wget libc6-compat gcompat

WORKDIR /app

# Copy package.json dan install dependency (otomatis ngerun postinstall download cloudflared)
COPY package*.json ./
RUN npm install --production

# Copy seluruh sisa file script
COPY . .

# Expose port (opsional buat dokumentasi container)
EXPOSE 8080

# Jalankan aplikasi via npm start
CMD ["npm", "start"]
