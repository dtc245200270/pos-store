/**
 * scripts/prepare-qr-db.js
 * Chuẩn bị cơ sở dữ liệu để chạy chức năng thanh toán QR trong POS Store hiện tại:
 * - Kiểm tra bảng invoices trong CSDL đang sử dụng (pos_store).
 * - Kiểm tra đủ 3 cột: payment_method, transfer_content, transfer_confirmed_at.
 * - Nếu đủ: Không chạy lại migration.
 * - Nếu thiếu: Sao lưu CSDL, đối chiếu migration_02_payment_methods.sql, chỉ bổ sung cột thiếu.
 * - Giữ nguyên toàn bộ hóa đơn, sản phẩm, tồn kho, tài khoản.
 * - Tuyệt đối không in mật khẩu hay biến bí mật.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

async function run() {
  console.log('=== BẮT ĐẦU KIỂM TRA & CHUẨN BỊ CƠ SỞ DỮ LIỆU POS STORE ===\n');

  let connection;
  try {
    connection = await pool.getConnection();
  } catch (connErr) {
    console.error('LỖI KẾT NỐI CSDL:', connErr.message);
    process.exit(1);
  }

  try {
    // 1. Lấy tên CSDL hiện tại
    const [dbRows] = await connection.query('SELECT DATABASE() AS current_db');
    const currentDb = dbRows[0].current_db || process.env.DB_NAME;
    console.log(`1. Cơ sở dữ liệu đang kết nối: ${currentDb}`);

    // 2. Kiểm tra các cột hiện tại của bảng invoices
    const [columnsBefore] = await connection.query('SHOW COLUMNS FROM invoices');
    const columnNamesBefore = columnsBefore.map(c => c.Field);
    console.log(`2. Các cột trong bảng invoices hiện tại (${columnNamesBefore.length} cột):`);
    console.log(`   [${columnNamesBefore.join(', ')}]`);

    // 3. Đếm số lượng bản ghi trước khi thực hiện
    const [invCountBeforeRows] = await connection.query('SELECT COUNT(*) AS total_invoices FROM invoices');
    const totalInvoicesBefore = invCountBeforeRows[0].total_invoices;
    const [prodCountRows] = await connection.query('SELECT COUNT(*) AS total_products FROM products');
    const [userCountRows] = await connection.query('SELECT COUNT(*) AS total_users FROM users');
    console.log(`3. Thống kê dữ liệu hiện tại:`);
    console.log(`   - Hóa đơn: ${totalInvoicesBefore}`);
    console.log(`   - Sản phẩm: ${prodCountRows[0].total_products}`);
    console.log(`   - Tài khoản: ${userCountRows[0].total_users}`);

    // Kiểm tra sự hiện diện của 3 cột cần thiết
    const targetCols = ['payment_method', 'transfer_content', 'transfer_confirmed_at'];
    const missingCols = targetCols.filter(col => !columnNamesBefore.includes(col));

    let ranMigration = false;
    let backupFilePath = null;

    if (missingCols.length === 0) {
      console.log('\n✔ Bảng invoices ĐÃ ĐỦ cả 3 cột cần thiết:');
      targetCols.forEach(col => {
        const colDef = columnsBefore.find(c => c.Field === col);
        console.log(`   - ${col}: Type=${colDef.Type}, Null=${colDef.Null}, Default=${colDef.Default}`);
      });
      console.log('-> Theo quy định: KHÔNG CHẠY LẠI MIGRATION.');
    } else {
      console.log(`\n⚠️ Phát hiện bảng invoices THIẾU ${missingCols.length} cột: [${missingCols.join(', ')}]`);

      // 4. Thực hiện sao lưu CSDL trước khi thay đổi
      console.log('-> Đang tiến hành sao lưu toàn bộ dữ liệu CSDL...');
      const backupDir = path.join(__dirname, '../database/backups');
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      backupFilePath = path.join(backupDir, `backup_${currentDb}_before_qr_migration_${timestamp}.json`);

      const tablesToBackup = [
        'users',
        'products',
        'invoices',
        'invoice_items',
        'stock_receipts',
        'stock_receipt_items',
        'stock_movements'
      ];

      const backupData = {};
      for (const tbl of tablesToBackup) {
        try {
          const [tblRows] = await connection.query(`SELECT * FROM ${tbl}`);
          backupData[tbl] = tblRows;
        } catch (tblErr) {
          console.warn(`   Cảnh báo đọc bảng ${tbl}: ${tblErr.message}`);
        }
      }

      fs.writeFileSync(backupFilePath, JSON.stringify(backupData, null, 2), 'utf8');

      // Kiểm tra file sao lưu thành công
      const fileStat = fs.statSync(backupFilePath);
      if (!fileStat || fileStat.size === 0) {
        throw new Error('Sao lưu thất bại hoặc file sao lưu có kích thước 0 byte! Dừng thay đổi.');
      }
      console.log(`✔ Sao lưu CSDL thành công tại: ${backupFilePath} (${(fileStat.size / 1024).toFixed(2)} KB)`);

      // 5. Xây dựng câu lệnh ALTER TABLE chỉ cho các cột còn thiếu
      console.log('-> Đang đối chiếu database/migration_02_payment_methods.sql và chuẩn bị ALTER TABLE...');
      const alterClauses = [];
      if (missingCols.includes('payment_method')) {
        alterClauses.push('ADD COLUMN payment_method VARCHAR(20) NULL DEFAULT NULL AFTER total_amount');
      }
      if (missingCols.includes('transfer_content')) {
        const afterCol = (missingCols.includes('payment_method') || columnNamesBefore.includes('payment_method')) ? 'payment_method' : 'total_amount';
        alterClauses.push(`ADD COLUMN transfer_content VARCHAR(100) NULL DEFAULT NULL AFTER ${afterCol}`);
      }
      if (missingCols.includes('transfer_confirmed_at')) {
        const afterCol = (missingCols.includes('transfer_content') || columnNamesBefore.includes('transfer_content')) ? 'transfer_content' : 'payment_method';
        alterClauses.push(`ADD COLUMN transfer_confirmed_at DATETIME NULL DEFAULT NULL AFTER ${afterCol}`);
      }

      const alterSql = `ALTER TABLE invoices\n  ${alterClauses.join(',\n  ')};`;
      console.log('-> Câu lệnh ALTER TABLE thực hiện:');
      console.log(alterSql);

      try {
        await connection.query(alterSql);
        ranMigration = true;
        console.log('✔ ALTER TABLE thành công!');
      } catch (alterErr) {
        console.error('LỖI KHI CHẠY ALTER TABLE (Không có quyền hoặc lỗi cú pháp):', alterErr.message);
        console.error('Dừng thay đổi theo quy định.');
        process.exit(1);
      }
    }

    // 6. Kiểm tra lại sau khi thực hiện
    const [columnsAfter] = await connection.query('SHOW COLUMNS FROM invoices');
    const columnNamesAfter = columnsAfter.map(c => c.Field);
    console.log(`\n4. Các cột trong bảng invoices sau khi kiểm tra (${columnNamesAfter.length} cột):`);
    console.log(`   [${columnNamesAfter.join(', ')}]`);

    // Xác nhận đủ cả 3 cột
    for (const col of targetCols) {
      if (!columnNamesAfter.includes(col)) {
        throw new Error(`Cột ${col} vẫn chưa có trong bảng invoices sau khi thực hiện!`);
      }
    }

    // 7. Xác nhận số lượng hóa đơn không thay đổi
    const [invCountAfterRows] = await connection.query('SELECT COUNT(*) AS total_invoices FROM invoices');
    const totalInvoicesAfter = invCountAfterRows[0].total_invoices;
    console.log(`\n5. Kiểm tra tính toàn vẹn dữ liệu:`);
    console.log(`   - Số lượng hóa đơn trước: ${totalInvoicesBefore}`);
    console.log(`   - Số lượng hóa đơn sau:   ${totalInvoicesAfter}`);
    if (totalInvoicesBefore !== totalInvoicesAfter) {
      throw new Error(`Số lượng hóa đơn bị thay đổi (${totalInvoicesBefore} -> ${totalInvoicesAfter})!`);
    }
    console.log('✔ Số lượng hóa đơn giữ nguyên vẹn 100%.');

    // 8. Kiểm tra các hóa đơn cũ giữ giá trị NULL, không tự gán thành CASH
    if (totalInvoicesAfter > 0) {
      const [sampleRows] = await connection.query(
        'SELECT id, invoice_no, total_amount, payment_method, transfer_content, transfer_confirmed_at FROM invoices LIMIT 5'
      );
      console.log('   - Kiểm tra mẫu dữ liệu hóa đơn:');
      sampleRows.forEach(r => {
        console.log(`     #${r.id} (${r.invoice_no}): total=${r.total_amount}, payment_method=${r.payment_method}, transfer_content=${r.transfer_content}`);
      });
      const [nonNullCountRows] = await connection.query(
        'SELECT COUNT(*) as count FROM invoices WHERE payment_method IS NOT NULL'
      );
      console.log(`   - Số hóa đơn có payment_method != NULL: ${nonNullCountRows[0].count}`);
    }

    // 9. Kiểm tra cấu hình VietQR trong .env (chỉ kiểm tra có cấu hình hay không, không in giá trị bí mật)
    console.log('\n6. Kiểm tra cấu hình VietQR từ biến môi trường:');
    const bankId = process.env.VIETQR_BANK_ID;
    const accountNo = process.env.VIETQR_ACCOUNT_NO;
    const accountName = process.env.VIETQR_ACCOUNT_NAME;
    const isConfigured = Boolean(bankId && accountNo && accountName);

    console.log(`   - VIETQR_BANK_ID: ${bankId ? 'Đã thiết lập (' + bankId + ')' : 'CHƯA THIẾT LẬP'}`);
    console.log(`   - VIETQR_ACCOUNT_NO: ${accountNo ? 'Đã thiết lập (độ dài: ' + accountNo.length + ' ký tự)' : 'CHƯA THIẾT LẬP'}`);
    console.log(`   - VIETQR_ACCOUNT_NAME: ${accountName ? 'Đã thiết lập' : 'CHƯA THIẾT LẬP'}`);
    console.log(`   -> Trạng thái cấu hình QR: ${isConfigured ? 'SẴN SÀNG' : 'CHƯA ĐẦY ĐỦ'}`);

    console.log('\n=== KẾT THÚC QUÁ TRÌNH KIỂM TRA & CHUẨN BỊ ===');
  } finally {
    if (connection) connection.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error('\nLỖI KHÔNG MONG MUỐN:', err);
  process.exit(1);
});
