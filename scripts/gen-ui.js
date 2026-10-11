const fs = require('fs');

const files = ['products', 'employees', 'sales', 'invoices', 'stock-receipts', 'inventory'];

files.forEach(name => {
  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>${name} - POS Store</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
</head>
<body>
  <div class="container mt-5">
    <h2>${name.toUpperCase()}</h2>
    <div id="data-container">Đang tải...</div>
  </div>
  <script src="/public/js/auth.js"></script>
  <script src="/public/js/layout.js"></script>
  <script src="/public/js/${name}.js"></script>
</body>
</html>`;

  const js = `document.addEventListener('DOMContentLoaded', async () => {
  try {
    let endpoint = '/api/${name}';
    if (endpoint === '/api/sales') endpoint = '/api/products'; // for sales we fetch products
    const res = await window.apiFetch(endpoint);
    if (res && res.ok) {
      const data = await res.json();
      document.getElementById('data-container').innerHTML = '<pre>' + JSON.stringify(data, null, 2) + '</pre>';
    }
  } catch (err) {
    console.error(err);
  }
});`;

  fs.writeFileSync('views/' + name + '.html', html);
  fs.writeFileSync('public/js/' + name + '.js', js);
});

console.log('Generated UI stubs');
