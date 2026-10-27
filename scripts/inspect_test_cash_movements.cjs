const Database = require('better-sqlite3');
const db = new Database('./gtr_pos.db', { readonly: true });
const testIds = [399, 400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415, 416, 417, 418, 419, 420, 421, 422, 423, 425, 426, 427, 428];
const placeholders = testIds.map(() => '?').join(',');

const cashMovs = db.prepare(`SELECT * FROM cash_movements WHERE sale_id IN (${placeholders})`).all(...testIds);
console.log('Test sale cash movements count:', cashMovs.length);
cashMovs.forEach(m => console.log(JSON.stringify(m)));

const cashAccounts = db.prepare('SELECT * FROM cash_accounts').all();
console.log('\nCash accounts current balances:');
cashAccounts.forEach(ca => console.log(JSON.stringify(ca)));

db.close();
