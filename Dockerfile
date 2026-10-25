# ==============================================================================
# POS Store - Tệp Cấu Hình Đóng Gói Ứng Dụng (Dockerfile)
# Thiết kế: Single-stage Build trên nền Node.js Alpine
# 
# Lý do sử dụng cấu trúc Single-stage:
#   1. Ứng dụng viết bằng Node.js / Express thuần JavaScript (CommonJS), không cần bước
#      biên dịch trung gian (không dùng TypeScript, Babel hay Webpack bundle phức tạp).
#   2. Cài đặt tối ưu bằng lệnh `npm ci --omit=dev` giúp chỉ tải các thư viện production.
#   3. Image base Alpine gọn nhẹ (~180MB), bảo mật và vận hành dưới quyền người dùng
#      không đặc quyền (`node`) để giảm thiểu rủi ro an ninh container.
# ==============================================================================
FROM node:20.18.0-alpine

# Cài đặt công cụ curl phục vụ cơ chế kiểm tra tiến trình sống (Healthcheck /healthz) của container
RUN apk add --no-cache curl

# Thiết lập thư mục làm việc chính của ứng dụng bên trong container
WORKDIR /app

# Khai báo biến môi trường chuẩn production
ENV NODE_ENV=production

# Sao chép tệp mô tả thư viện phụ thuộc và cài đặt gói production
COPY package*.json ./
RUN npm ci --omit=dev

# Sao chép toàn bộ mã nguồn ứng dụng do dự án tự viết
COPY server.js ./
COPY config ./config
COPY middleware ./middleware
COPY routes ./routes
COPY views ./views
COPY public ./public

# Tạo thư mục lưu log để chia sẻ dữ liệu qua Volume với bộ thu thập log Grafana Alloy
# Phân quyền sở hữu toàn bộ thư mục cho người dùng 'node'
RUN mkdir -p /app/logs && chown -R node:node /app

# Chuyển sang người dùng không có quyền root (node) để tuân thủ nguyên tắc đặc quyền tối thiểu
USER node

# Khai báo các cổng mạng container cung cấp:
# - Cổng 3000: Cổng dịch vụ web chính (HTTP Express App)
# - Cổng 9101: Cổng xuất số liệu giám sát Prometheus riêng biệt (/metrics)
EXPOSE 3000 9101

# Lệnh khởi chạy tiến trình máy chủ Express
CMD ["node", "server.js"]

