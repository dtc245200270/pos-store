const fs = require('fs');
const path = require('path');

const jsCode = {
  'products': `
function closeModal(id) { document.getElementById(id).style.display = 'none'; }
function showAddProductModal() { document.getElementById('product-modal').style.display = 'block'; }
async function loadProducts() {
  const res = await window.apiFetch('/api/products');
  const data = await res.json();
  const tbody = document.querySelector('#products-table tbody');
  tbody.innerHTML = '';
  data.forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td></td><td></td><td></td><td></td><td></td><td></td><td></td>';
    tr.cells[0].textContent = p.sku;
    tr.cells[1].textContent = p.name;
    tr.cells[2].textContent = p.unit;
    tr.cells[3].textContent = p.sale_price;
    tr.cells[4].textContent = p.stock_quantity;
    tr.cells[5].textContent = p.is_active ? 'Active' : 'Inactive';
    tr.cells[6].innerHTML = \`<button class="btn btn-sm btn-secondary" onclick="toggleActive(\${p.id}, \${!p.is_active})">Toggle</button>\`;
    tbody.appendChild(tr);
  });
}
async function toggleActive(id, status) {
  await window.apiFetch('/api/products/' + id + '/toggle-active', { method: 'PATCH', body: JSON.stringify({ is_active: status }) });
  loadProducts();
}
async function saveProduct() {
  const payload = {
    sku: document.getElementById('p-sku').value,
    name: document.getElementById('p-name').value,
    unit: document.getElementById('p-unit').value,
    sale_price: Number(document.getElementById('p-price').value)
  };
  await window.apiFetch('/api/products', { method: 'POST', body: JSON.stringify(payload) });
  closeModal('product-modal');
  loadProducts();
}
document.addEventListener('DOMContentLoaded', loadProducts);
  `,
  'employees': `
function closeModal(id) { document.getElementById(id).style.display = 'none'; }
function showAddEmployeeModal() { document.getElementById('employee-modal').style.display = 'block'; }
async function loadEmployees() {
  const res = await window.apiFetch('/api/employees');
  const data = await res.json();
  const tbody = document.querySelector('#employees-table tbody');
  tbody.innerHTML = '';
  data.forEach(e => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td></td><td></td><td></td><td></td><td></td>';
    tr.cells[0].textContent = e.username;
    tr.cells[1].textContent = e.full_name;
    tr.cells[2].textContent = e.role;
    tr.cells[3].textContent = e.is_active ? 'Active' : 'Locked';
    tr.cells[4].innerHTML = \`<button class="btn btn-sm btn-warning" onclick="toggleLock(\${e.id}, \${!e.is_active})">Lock/Unlock</button>\`;
    tbody.appendChild(tr);
  });
}
async function toggleLock(id, status) {
  await window.apiFetch('/api/employees/' + id + '/toggle-lock', { method: 'PATCH', body: JSON.stringify({ is_active: status }) });
  loadEmployees();
}
async function saveEmployee() {
  const payload = {
    username: document.getElementById('e-username').value,
    full_name: document.getElementById('e-fullname').value,
    role: document.getElementById('e-role').value,
    password: 'password123'
  };
  await window.apiFetch('/api/employees', { method: 'POST', body: JSON.stringify(payload) });
  closeModal('employee-modal');
  loadEmployees();
}
document.addEventListener('DOMContentLoaded', loadEmployees);
  `,
  'stock-receipts': `
let cart = [];
async function loadProducts() {
  const res = await window.apiFetch('/api/products?active_only=true');
  const data = await res.json();
  const sel = document.getElementById('r-product');
  data.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name + ' (' + p.sku + ')';
    sel.appendChild(opt);
  });
}
function addReceiptItem() {
  const sel = document.getElementById('r-product');
  const name = sel.options[sel.selectedIndex].text;
  const id = sel.value;
  const qty = Number(document.getElementById('r-qty').value);
  const cost = Number(document.getElementById('r-cost').value);
  if (!id || qty <= 0 || cost < 0) return alert('Invalid input');
  cart.push({ product_id: Number(id), name, quantity: qty, unit_cost: cost });
  renderCart();
}
function renderCart() {
  const tbody = document.querySelector('#r-cart tbody');
  tbody.innerHTML = '';
  let total = 0;
  cart.forEach((c, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td></td><td></td><td></td><td><button class="btn btn-sm btn-danger" onclick="cart.splice('+i+',1); renderCart()">X</button></td>';
    tr.cells[0].textContent = c.name;
    tr.cells[1].textContent = c.quantity;
    tr.cells[2].textContent = c.unit_cost;
    tbody.appendChild(tr);
    total += c.quantity * c.unit_cost;
  });
  document.getElementById('r-total').textContent = total.toFixed(2);
}
async function saveReceipt() {
  if (cart.length === 0) return alert('Empty cart');
  const no = document.getElementById('r-no').value;
  const payload = {
    receipt_no: no, request_key: Date.now().toString(),
    items: cart.map(c => ({ product_id: c.product_id, quantity: c.quantity, unit_cost: c.unit_cost }))
  };
  const res = await window.apiFetch('/api/stock-receipts', { method: 'POST', body: JSON.stringify(payload) });
  if (res.ok) { alert('Thành công'); cart = []; renderCart(); }
  else { const e = await res.json(); alert(e.error); }
}
document.addEventListener('DOMContentLoaded', loadProducts);
  `,
  'sales': `
let cart = [];
let productsMap = {};
async function loadProducts() {
  const res = await window.apiFetch('/api/products?active_only=true');
  const data = await res.json();
  const sel = document.getElementById('s-product');
  data.forEach(p => {
    productsMap[p.id] = p;
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name + ' - Tồn: ' + p.stock_quantity + ' - Giá: ' + p.sale_price;
    sel.appendChild(opt);
  });
}
function addSaleItem() {
  const id = document.getElementById('s-product').value;
  const qty = Number(document.getElementById('s-qty').value);
  if (!id || qty <= 0) return alert('Invalid quantity');
  const p = productsMap[id];
  cart.push({ product_id: p.id, name: p.name, quantity: qty, unit_price: Number(p.sale_price) });
  renderCart();
}
function renderCart() {
  const tbody = document.querySelector('#s-cart tbody');
  tbody.innerHTML = '';
  let total = 0;
  cart.forEach((c, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td></td><td></td><td></td><td></td><td><button class="btn btn-sm btn-danger" onclick="cart.splice('+i+',1); renderCart()">X</button></td>';
    tr.cells[0].textContent = c.name;
    tr.cells[1].textContent = c.unit_price;
    tr.cells[2].textContent = c.quantity;
    tr.cells[3].textContent = (c.unit_price * c.quantity).toFixed(2);
    tbody.appendChild(tr);
    total += c.quantity * c.unit_price;
  });
  document.getElementById('s-total').textContent = total.toFixed(2);
}
async function checkout() {
  if (cart.length === 0) return alert('Empty cart');
  const payload = {
    invoice_no: 'HD' + Date.now(), request_key: Date.now().toString(),
    items: cart.map(c => ({ product_id: c.product_id, quantity: c.quantity, unit_price: c.unit_price }))
  };
  const res = await window.apiFetch('/api/invoices', { method: 'POST', body: JSON.stringify(payload) });
  if (res.ok) { alert('Thanh toán thành công!'); cart = []; renderCart(); }
  else if (res.status === 409) {
    const e = await res.json();
    if (e.requires_confirmation) {
       document.getElementById('price-change-warning').style.display = 'block';
       document.getElementById('price-change-warning').textContent = e.error + ' Hãy làm mới lại trang để tải giá mới.';
    } else { alert(e.error); }
  } else { const e = await res.json(); alert(e.error); }
}
document.addEventListener('DOMContentLoaded', loadProducts);
  `,
  'invoices': `
function closeModal(id) { document.getElementById(id).style.display = 'none'; }
async function loadInvoices() {
  const res = await window.apiFetch('/api/invoices');
  const data = await res.json();
  const tbody = document.querySelector('#invoices-table tbody');
  tbody.innerHTML = '';
  data.forEach(inv => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td></td><td></td><td></td><td></td><td></td><td><button class="btn btn-sm btn-info" onclick="viewDetails('+inv.id+')">Chi tiết</button></td>';
    tr.cells[0].textContent = inv.id;
    tr.cells[1].textContent = inv.invoice_no;
    tr.cells[2].textContent = inv.total_amount;
    tr.cells[3].textContent = new Date(inv.created_at).toLocaleString();
    tr.cells[4].textContent = inv.created_by_name || inv.created_by;
    tbody.appendChild(tr);
  });
}
async function viewDetails(id) {
  const res = await window.apiFetch('/api/invoices/' + id);
  const data = await res.json();
  document.getElementById('invoice-details').textContent = JSON.stringify(data.items, null, 2);
  document.getElementById('invoice-modal').style.display = 'block';
}
document.addEventListener('DOMContentLoaded', loadInvoices);
  `,
  'inventory': `
async function loadInventory() {
  const res = await window.apiFetch('/api/inventory');
  const data = await res.json();
  const tbody = document.querySelector('#inventory-table tbody');
  tbody.innerHTML = '';
  data.forEach(i => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td></td><td></td><td></td><td></td>';
    tr.cells[0].textContent = i.id;
    tr.cells[1].textContent = i.sku;
    tr.cells[2].textContent = i.name;
    tr.cells[3].textContent = i.stock_quantity;
    tbody.appendChild(tr);
  });
}
document.addEventListener('DOMContentLoaded', loadInventory);
  `
};

for (const [name, content] of Object.entries(jsCode)) {
  fs.writeFileSync(path.join(__dirname, '../public/js', name + '.js'), content);
}
console.log('UI JS files updated.');
