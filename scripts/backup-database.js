require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

async function backup() {
  const backupDir = path.join(__dirname, '../database/backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(backupDir, `backup_pos_store_${timestamp}.json`);

  const tables = [
    'users',
    'products',
    'invoices',
    'invoice_items',
    'stock_receipts',
    'stock_receipt_items',
    'stock_movements'
  ];

  const data = {};

  for (const table of tables) {
    const [rows] = await pool.query(`SELECT * FROM ${table}`);
    data[table] = rows;
  }

  fs.writeFileSync(backupFile, JSON.stringify(data, null, 2), 'utf8');
  console.log(`Backup completed successfully to: ${backupFile}`);
  await pool.end();
}

backup().catch(err => {
  console.error('Backup failed:', err);
  process.exit(1);
});
