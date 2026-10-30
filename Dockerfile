FROM node:18-alpine

RUN apk add --no-cache wget libc6-compat gcompat

WORKDIR /app

COPY package*.json ./
RUN npm install --production

# Tambahin baris ini buat penanda pemicu rebuild
ARG REBUILD_DATE=2026-10-30_v2

COPY . .

EXPOSE 8080

CMD ["npm", "start"]
# force rebuild 1793370930
