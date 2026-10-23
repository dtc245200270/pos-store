require('dotenv').config();
const pool = require('../config/db');

async function testConnection() {
  try {
    const host = process.env.DB_HOST || '127.0.0.1';
    const port = process.env.DB_PORT || 3306;
    const user = process.env.DB_USER;
    const dbName = process.env.DB_NAME;

    console.log('Thong tin cau hinh ket noi (khong bao gom mat khau):');
    console.log(`- Host: ${host}`);
    console.log(`- Port: ${port}`);
    console.log(`- User: ${user}`);
    console.log(`- Database target: ${dbName}`);

    const [rows] = await pool.query('SELECT 1 AS alive, DATABASE() AS current_db, CURRENT_USER() AS connected_user');
    
    console.log('\nKet qua truy van:');
    console.log(`- SELECT 1: ${rows[0].alive}`);
    console.log(`- Database xac nhan: ${rows[0].current_db}`);
    console.log(`- User xac nhan: ${rows[0].connected_user}`);

    if (rows[0].current_db === dbName) {
      console.log('\nXAC NHAN: Ket noi thanh cong vao dung co so du lieu pos_store!');
    } else {
      console.warn(`\nCANH BAO: Database hien tai (${rows[0].current_db}) khac voi cau hinh (${dbName})`);
    }

    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('\nLOI KET NOI DATABASE:', err.message);
    if (err.code) console.error(`- Ma loi: ${err.code}`);
    process.exit(1);
  }
}

testConnection();
