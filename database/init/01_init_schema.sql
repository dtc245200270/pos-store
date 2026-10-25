-- ==============================================================================
-- DỰ ÁN POS STORE - KHỞI TẠO CƠ SỞ DỮ LIỆU ĐẦY ĐỦ CHO DOCKER CONTAINER
-- ==============================================================================
-- Tệp: database/init/01_init_schema.sql
-- Mục đích:
--   - Được tự động thực thi bởi MySQL Docker container khi khởi tạo volume dữ liệu lần đầu
--     (gắn qua bind mount: ./database/init:/docker-entrypoint-initdb.d:ro trong compose.yaml).
--   - Tổng hợp đầy đủ cấu trúc dữ liệu hoàn chỉnh của dự án POS Store:
--       1. Toàn bộ 7 bảng cốt lõi (users, products, invoices, invoice_items,
--          stock_receipts, stock_receipt_items, stock_movements).
--       2. Bảng sessions phục vụ lưu trữ phiên làm việc của express-mysql-session.
--       3. Các trường phương thức thanh toán VietQR trong bảng invoices (payment_method,
--          transfer_content, transfer_confirmed_at).
-- ==============================================================================

CREATE DATABASE IF NOT EXISTS pos_store
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE pos_store;

-- 1. Bảng tài khoản người dùng (users)
CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    role VARCHAR(20) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_users_username UNIQUE (username),
    CONSTRAINT chk_users_username CHECK (CHAR_LENGTH(TRIM(username)) > 0),
    CONSTRAINT chk_users_password CHECK (CHAR_LENGTH(password_hash) > 0),
    CONSTRAINT chk_users_full_name CHECK (CHAR_LENGTH(TRIM(full_name)) > 0),
    CONSTRAINT chk_users_role CHECK (role IN ('MANAGER', 'CASHIER')),
    CONSTRAINT chk_users_active CHECK (is_active IN (0, 1))
) ENGINE = InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 2. Bảng sản phẩm (products)
CREATE TABLE IF NOT EXISTS products (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    sku VARCHAR(50) NOT NULL,
    name VARCHAR(200) NOT NULL,
    unit VARCHAR(30) NOT NULL,
    sale_price DECIMAL(15, 2) NOT NULL,
    stock_quantity INT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT uq_products_sku UNIQUE (sku),
    CONSTRAINT chk_products_sku CHECK (CHAR_LENGTH(TRIM(sku)) > 0),
    CONSTRAINT chk_products_name CHECK (CHAR_LENGTH(TRIM(name)) > 0),
    CONSTRAINT chk_products_unit CHECK (CHAR_LENGTH(TRIM(unit)) > 0),
    CONSTRAINT chk_products_price CHECK (sale_price > 0),
    CONSTRAINT chk_products_stock CHECK (stock_quantity >= 0),
    CONSTRAINT chk_products_active CHECK (is_active IN (0, 1)),

    INDEX idx_products_name (name)
) ENGINE = InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 3. Bảng hóa đơn bán hàng (invoices) - Đã tích hợp migration_02
CREATE TABLE IF NOT EXISTS invoices (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    invoice_no VARCHAR(40) NOT NULL,
    created_by BIGINT UNSIGNED NOT NULL,
    request_key VARCHAR(64) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    total_amount DECIMAL(15, 2) NOT NULL,
    payment_method VARCHAR(20) NULL DEFAULT NULL,
    transfer_content VARCHAR(100) NULL DEFAULT NULL,
    transfer_confirmed_at DATETIME NULL DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_invoices_no UNIQUE (invoice_no),
    CONSTRAINT uq_invoices_request UNIQUE (created_by, request_key),
    CONSTRAINT chk_invoices_no CHECK (CHAR_LENGTH(TRIM(invoice_no)) > 0),
    CONSTRAINT chk_invoices_request CHECK (CHAR_LENGTH(TRIM(request_key)) > 0),
    CONSTRAINT chk_invoices_hash CHECK (CHAR_LENGTH(request_hash) = 64),
    CONSTRAINT chk_invoices_total CHECK (total_amount > 0),

    CONSTRAINT fk_invoices_user FOREIGN KEY (created_by)
        REFERENCES users(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,

    INDEX idx_invoices_created_at (created_at),
    INDEX idx_invoices_user_time (created_by, created_at)
) ENGINE = InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 4. Bảng chi tiết hóa đơn (invoice_items)
CREATE TABLE IF NOT EXISTS invoice_items (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    invoice_id BIGINT UNSIGNED NOT NULL,
    product_id BIGINT UNSIGNED NOT NULL,
    product_name_snapshot VARCHAR(200) NOT NULL,
    unit_snapshot VARCHAR(30) NOT NULL,
    quantity INT NOT NULL,
    unit_price DECIMAL(15, 2) NOT NULL,

    CONSTRAINT uq_invoice_items_product UNIQUE (invoice_id, product_id),
    CONSTRAINT chk_invoice_items_name CHECK (CHAR_LENGTH(TRIM(product_name_snapshot)) > 0),
    CONSTRAINT chk_invoice_items_unit CHECK (CHAR_LENGTH(TRIM(unit_snapshot)) > 0),
    CONSTRAINT chk_invoice_items_quantity CHECK (quantity > 0),
    CONSTRAINT chk_invoice_items_price CHECK (unit_price > 0),

    CONSTRAINT fk_invoice_items_invoice FOREIGN KEY (invoice_id)
        REFERENCES invoices(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT fk_invoice_items_product FOREIGN KEY (product_id)
        REFERENCES products(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE = InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 5. Bảng phiếu nhập kho (stock_receipts)
CREATE TABLE IF NOT EXISTS stock_receipts (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    receipt_no VARCHAR(40) NOT NULL,
    created_by BIGINT UNSIGNED NOT NULL,
    request_key VARCHAR(64) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    total_amount DECIMAL(15, 2) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_stock_receipts_no UNIQUE (receipt_no),
    CONSTRAINT uq_stock_receipts_request UNIQUE (created_by, request_key),
    CONSTRAINT chk_stock_receipts_no CHECK (CHAR_LENGTH(TRIM(receipt_no)) > 0),
    CONSTRAINT chk_stock_receipts_request CHECK (CHAR_LENGTH(TRIM(request_key)) > 0),
    CONSTRAINT chk_stock_receipts_hash CHECK (CHAR_LENGTH(request_hash) = 64),
    CONSTRAINT chk_stock_receipts_total CHECK (total_amount >= 0),

    CONSTRAINT fk_stock_receipts_user FOREIGN KEY (created_by)
        REFERENCES users(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,

    INDEX idx_stock_receipts_created_at (created_at),
    INDEX idx_stock_receipts_user_time (created_by, created_at)
) ENGINE = InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 6. Bảng chi tiết phiếu nhập kho (stock_receipt_items)
CREATE TABLE IF NOT EXISTS stock_receipt_items (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    receipt_id BIGINT UNSIGNED NOT NULL,
    product_id BIGINT UNSIGNED NOT NULL,
    product_name_snapshot VARCHAR(200) NOT NULL,
    unit_snapshot VARCHAR(30) NOT NULL,
    quantity INT NOT NULL,
    unit_cost DECIMAL(15, 2) NOT NULL,

    CONSTRAINT uq_stock_receipt_items_product UNIQUE (receipt_id, product_id),
    CONSTRAINT chk_stock_receipt_items_name CHECK (CHAR_LENGTH(TRIM(product_name_snapshot)) > 0),
    CONSTRAINT chk_stock_receipt_items_unit CHECK (CHAR_LENGTH(TRIM(unit_snapshot)) > 0),
    CONSTRAINT chk_stock_receipt_items_quantity CHECK (quantity > 0),
    CONSTRAINT chk_stock_receipt_items_cost CHECK (unit_cost >= 0),

    CONSTRAINT fk_stock_receipt_items_receipt FOREIGN KEY (receipt_id)
        REFERENCES stock_receipts(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT fk_stock_receipt_items_product FOREIGN KEY (product_id)
        REFERENCES products(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE = InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 7. Bảng lịch sử biến động kho (stock_movements)
CREATE TABLE IF NOT EXISTS stock_movements (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    product_id BIGINT UNSIGNED NOT NULL,
    invoice_item_id BIGINT UNSIGNED NULL,
    receipt_item_id BIGINT UNSIGNED NULL,
    quantity_delta INT NOT NULL,
    balance_after INT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_stock_movements_invoice UNIQUE (invoice_item_id),
    CONSTRAINT uq_stock_movements_receipt UNIQUE (receipt_item_id),
    CONSTRAINT chk_stock_movements_balance CHECK (balance_after >= 0),

    CONSTRAINT chk_stock_movements_source CHECK (
        (
            invoice_item_id IS NOT NULL
            AND receipt_item_id IS NULL
            AND quantity_delta < 0
        )
        OR
        (
            invoice_item_id IS NULL
            AND receipt_item_id IS NOT NULL
            AND quantity_delta > 0
        )
    ),

    CONSTRAINT fk_stock_movements_product FOREIGN KEY (product_id)
        REFERENCES products(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT fk_stock_movements_invoice_item FOREIGN KEY (invoice_item_id)
        REFERENCES invoice_items(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT fk_stock_movements_receipt_item FOREIGN KEY (receipt_item_id)
        REFERENCES stock_receipt_items(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,

    INDEX idx_stock_movements_product_time (product_id, created_at)
) ENGINE = InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 8. Bảng quản lý session đăng nhập (sessions) - Tích hợp từ migration_01
CREATE TABLE IF NOT EXISTS sessions (
    session_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
    expires INT(11) UNSIGNED NOT NULL,
    data MEDIUMTEXT COLLATE utf8mb4_bin,
    PRIMARY KEY (session_id)
) ENGINE = InnoDB;

-- 9. Hardening quyền MySQL cho tài khoản ứng dụng pos_app (Principle of Least Privilege)
-- Khi MySQL entrypoint khởi tạo, mặc định pos_app được cấp ALL PRIVILEGES.
-- Lệnh dưới đây thu hồi quyền quản trị/cấu trúc (DROP, ALTER, CREATE, GRANT...) và chỉ giữ lại quyền CRUD cần thiết cho runtime.
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'pos_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON `pos_store`.* TO 'pos_app'@'%';
FLUSH PRIVILEGES;
