require('dotenv').config();
const pool = require('../config/db');

async function cleanupSampleData() {
  console.log('--- BẮT ĐẦU DỌN DẸP DỮ LIỆU MẪU / TEST ---');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Tìm id của sản phẩm mẫu SP001
    const [sampleProducts] = await conn.query("SELECT id FROM products WHERE sku = 'SP001'");
    const sampleProductIds = sampleProducts.map(p => p.id);

    if (sampleProductIds.length > 0) {
      console.log(`Tìm thấy sản phẩm mẫu SP001 (IDs: ${sampleProductIds.join(', ')})`);

      // 1.1 Xóa biến động kho liên quan đến sản phẩm mẫu
      const [delMovements] = await conn.query(
        "DELETE FROM stock_movements WHERE product_id IN (?)",
        [sampleProductIds]
      );
      console.log(`Đã xóa ${delMovements.affectedRows} bản ghi stock_movements.`);

      // 1.2 Xóa chi tiết hóa đơn liên quan đến sản phẩm mẫu
      const [delInvoiceItems] = await conn.query(
        "DELETE FROM invoice_items WHERE product_id IN (?)",
        [sampleProductIds]
      );
      console.log(`Đã xóa ${delInvoiceItems.affectedRows} bản ghi invoice_items.`);

      // 1.3 Xóa hóa đơn mẫu nếu không còn chi tiết nào
      const [delInvoices] = await conn.query(
        "DELETE FROM invoices WHERE id NOT IN (SELECT DISTINCT invoice_id FROM invoice_items)"
      );
      console.log(`Đã xóa ${delInvoices.affectedRows} bản ghi invoices.`);

      // 1.4 Xóa chi tiết phiếu nhập liên quan đến sản phẩm mẫu
      const [delReceiptItems] = await conn.query(
        "DELETE FROM stock_receipt_items WHERE product_id IN (?)",
        [sampleProductIds]
      );
      console.log(`Đã xóa ${delReceiptItems.affectedRows} bản ghi stock_receipt_items.`);

      // 1.5 Xóa phiếu nhập mẫu nếu không còn chi tiết nào
      const [delReceipts] = await conn.query(
        "DELETE FROM stock_receipts WHERE id NOT IN (SELECT DISTINCT receipt_id FROM stock_receipt_items)"
      );
      console.log(`Đã xóa ${delReceipts.affectedRows} bản ghi stock_receipts.`);

      // 1.6 Xóa sản phẩm mẫu SP001
      const [delProducts] = await conn.query(
        "DELETE FROM products WHERE id IN (?)",
        [sampleProductIds]
      );
      console.log(`Đã xóa ${delProducts.affectedRows} bản ghi products (SP001).`);
    } else {
      console.log('Không tìm thấy sản phẩm mẫu SP001.');
    }

    // 2. Xóa tài khoản kiểm thử cashier1 nếu có (giữ lại tài khoản manager)
    const [delCashier] = await conn.query(
      "DELETE FROM users WHERE username = 'cashier1'"
    );
    console.log(`Đã xóa ${delCashier.affectedRows} tài khoản kiểm thử cashier1.`);

    // 3. Đảm bảo tài khoản manager vẫn tồn tại
    const [managers] = await conn.query(
      "SELECT id, username, role FROM users WHERE username = 'manager'"
    );
    if (managers.length > 0) {
      console.log(`Tài khoản manager đã được bảo toàn (ID: ${managers[0].id}, Role: ${managers[0].role}).`);
    } else {
      console.warn('CẢNH BÁO: Không tìm thấy tài khoản manager!');
    }

    await conn.commit();
    console.log('--- DỌN DẸP DỮ LIỆU MẪU HOÀN TẤT THÀNH CÔNG ---');
  } catch (err) {
    await conn.rollback();
    console.error('Lỗi khi dọn dẹp dữ liệu mẫu, đã rollback:', err);
    throw err;
  } finally {
    conn.release();
    await pool.end();
  }
}

cleanupSampleData().catch(err => {
  process.exit(1);
});
