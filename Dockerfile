# ==============================================================================
# Dockerfile cho POS Store Node.js Backend (Express)
# Thiet ke: Single-stage Build
# Ly do giu nguyen single-stage:
#   1. Ung dung su dung Node.js / Express thuan JavaScript (CommonJS), khong qua buoc
#      bien dich trung gian (khong co TypeScript, Babel hoac Webpack bundle).
#   2. Su dung 'npm ci --omit=dev' de chi cai dat production dependencies can thiet.
#   3. Image base Alpine gon nhe (~180MB) va thuc thi voi nguoi dung khong dac quyen (node).
# ==============================================================================
FROM node:20.18.0-alpine

# Cai dat curl phuc vu container healthcheck (/healthz)
RUN apk add --no-cache curl

WORKDIR /app

# Khai bao moi truong production
ENV NODE_ENV=production

# Sao chep danh sach dependencies va cai dat ban production
COPY package*.json ./
RUN npm ci --omit=dev

# Sao chep ma nguon ung dung
COPY server.js ./
COPY config ./config
COPY middleware ./middleware
COPY routes ./routes
COPY views ./views
COPY public ./public

# Tao thu muc logs dung chung de chia se volume log voi Grafana Alloy
RUN mkdir -p /app/logs && chown -R node:node /app

USER node

EXPOSE 3000 9101

CMD ["node", "server.js"]
