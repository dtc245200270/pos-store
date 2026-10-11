const fs = require('fs');
const path = require('path');

const uiViews = {
  'products': `
  <div class="row mb-3">
    <div class="col-md-6"><input type="text" id="search-products" class="form-control" placeholder="Tìm SKU hoặc Tên"></div>
    <div class="col-md-6 text-end"><button class="btn btn-primary" onclick="showAddProductModal()">+ Thêm Sản Phẩm</button></div>
  </div>
  <table class="table table-bordered table-striped" id="products-table">
    <thead><tr><th>SKU</th><th>Tên</th><th>ĐVT</th><th>Giá Bán</th><th>Tồn Kho</th><th>Trạng Thái</th><th>Hành Động</th></tr></thead>
    <tbody></tbody>
  </table>
  <!-- Modal -->
  <div class="modal" id="product-modal" tabindex="-1">
    <div class="modal-dialog">
      <div class="modal-content">
        <div class="modal-header"><h5 class="modal-title">Sản Phẩm</h5><button type="button" class="btn-close" onclick="closeModal('product-modal')"></button></div>
        <div class="modal-body">
          <input type="hidden" id="p-id">
          <input type="text" id="p-sku" class="form-control mb-2" placeholder="SKU">
          <input type="text" id="p-name" class="form-control mb-2" placeholder="Tên sản phẩm">
          <input type="text" id="p-unit" class="form-control mb-2" placeholder="ĐVT (VD: Cái)">
          <input type="number" id="p-price" class="form-control mb-2" placeholder="Giá bán" step="0.01">
        </div>
        <div class="modal-footer"><button class="btn btn-primary" onclick="saveProduct()">Lưu</button></div>
      </div>
    </div>
  </div>
  `,
  'employees': `
  <div class="text-end mb-3"><button class="btn btn-primary" onclick="showAddEmployeeModal()">+ Thêm Nhân Viên</button></div>
  <table class="table table-bordered table-striped" id="employees-table">
    <thead><tr><th>Username</th><th>Họ Tên</th><th>Role</th><th>Trạng Thái</th><th>Hành Động</th></tr></thead>
    <tbody></tbody>
  </table>
  <!-- Modal -->
  <div class="modal" id="employee-modal" tabindex="-1">
    <div class="modal-dialog">
      <div class="modal-content">
        <div class="modal-header"><h5 class="modal-title">Nhân Viên</h5><button type="button" class="btn-close" onclick="closeModal('employee-modal')"></button></div>
        <div class="modal-body">
          <input type="hidden" id="e-id">
          <input type="text" id="e-username" class="form-control mb-2" placeholder="Username">
          <input type="text" id="e-fullname" class="form-control mb-2" placeholder="Họ tên">
          <select id="e-role" class="form-select mb-2"><option value="CASHIER">CASHIER</option><option value="MANAGER">MANAGER</option></select>
        </div>
        <div class="modal-footer"><button class="btn btn-primary" onclick="saveEmployee()">Lưu</button></div>
      </div>
    </div>
  </div>
  `,
  'stock-receipts': `
  <div class="row">
    <div class="col-md-7">
      <h4>Lập Phiếu Nhập</h4>
      <input type="text" id="r-no" class="form-control mb-2" placeholder="Số chứng từ (VD: NH001)">
      <div class="d-flex mb-2">
         <select id="r-product" class="form-select me-2"></select>
         <input type="number" id="r-qty" class="form-control me-2" placeholder="SL" style="width:100px;">
         <input type="number" id="r-cost" class="form-control me-2" placeholder="Giá nhập" style="width:150px;" step="0.01">
         <button class="btn btn-success" onclick="addReceiptItem()">Thêm</button>
      </div>
      <table class="table" id="r-cart"><thead><tr><th>Sản Phẩm</th><th>SL</th><th>Giá</th><th>Hành động</th></tr></thead><tbody></tbody></table>
      <h5>Tổng: <span id="r-total">0</span></h5>
      <button class="btn btn-primary" onclick="saveReceipt()">Hoàn Tất Nhập Hàng</button>
    </div>
    <div class="col-md-5">
      <h4>Lịch Sử Nhập Hàng</h4>
      <ul id="r-history" class="list-group"></ul>
    </div>
  </div>
  `,
  'sales': `
  <div class="row">
    <div class="col-md-7">
      <h4>Bán Hàng</h4>
      <div class="d-flex mb-2">
         <select id="s-product" class="form-select me-2"></select>
         <input type="number" id="s-qty" class="form-control me-2" placeholder="SL" style="width:100px;">
         <button class="btn btn-success" onclick="addSaleItem()">Thêm</button>
      </div>
      <table class="table" id="s-cart"><thead><tr><th>Sản Phẩm</th><th>Đơn Giá</th><th>SL</th><th>Thành Tiền</th><th>Xóa</th></tr></thead><tbody></tbody></table>
      <h5>Tổng: <span id="s-total">0</span></h5>
      <button class="btn btn-primary" onclick="checkout()">Thanh Toán</button>
      <div id="price-change-warning" class="alert alert-warning mt-2" style="display:none;"></div>
    </div>
  </div>
  `,
  'invoices': `
  <table class="table table-bordered table-striped" id="invoices-table">
    <thead><tr><th>ID</th><th>Mã Hóa Đơn</th><th>Tổng Tiền</th><th>Ngày Tạo</th><th>Người Tạo</th><th>Chi Tiết</th></tr></thead>
    <tbody></tbody>
  </table>
  <div class="modal" id="invoice-modal" tabindex="-1"><div class="modal-dialog"><div class="modal-content"><div class="modal-header"><h5 class="modal-title">Chi tiết</h5><button type="button" class="btn-close" onclick="closeModal('invoice-modal')"></button></div><div class="modal-body" id="invoice-details"></div></div></div></div>
  `,
  'inventory': `
  <table class="table table-bordered table-striped" id="inventory-table">
    <thead><tr><th>ID</th><th>SKU</th><th>Tên</th><th>Tồn Kho</th></tr></thead>
    <tbody></tbody>
  </table>
  `
};

for (const [name, content] of Object.entries(uiViews)) {
  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>${name.toUpperCase()} - POS</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
</head>
<body>
  <div class="container mt-5 pt-3">
    <h2 class="mb-4">${name.toUpperCase()}</h2>
    ${content}
  </div>
  <script src="/public/js/auth.js"></script>
  <script src="/public/js/layout.js"></script>
  <script src="/public/js/${name}.js"></script>
</body>
</html>`;
  fs.writeFileSync(path.join(__dirname, '../views', name + '.html'), html);
}
console.log('UI files updated.');
