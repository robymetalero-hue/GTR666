const Database = require('better-sqlite3');
const db = new Database('./gtr_pos.db', { readonly: true });
const testIds = [399, 400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415, 416, 417, 418, 419, 420, 421, 422, 423, 425, 426, 427, 428];
const placeholders = testIds.map(() => '?').join(',');

console.log('--- Processed Operations ---');
const procOps = db.prepare(`SELECT * FROM processed_operations WHERE client_operation_id LIKE '%test_sale%' OR client_operation_id LIKE '%debug_sale%'`).all();
console.log('Count:', procOps.length);
procOps.forEach(o => console.log(o.client_operation_id));

console.log('--- Accounts Receivable ---');
const ar = db.prepare(`SELECT * FROM accounts_receivable WHERE sale_id IN (${placeholders})`).all(...testIds);
console.log('Count:', ar.length);

db.close();
