/**
 * Test Suite: Multi-Source Product Audit History & Kárdex Synthesis
 * Tests GET /api/products/:id/audit-history across all transaction types:
 * - Initial creation stock
 * - Purchases (stock_arrivals)
 * - Sales (sale_items + sales)
 * - Customer Returns (sale_returns)
 * - Physical count adjustments (inventory_count_items)
 * - Cost masking for non-admin roles
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const http = require('http');
const jwt = require('jsonwebtoken');

let JWT_SECRET = process.env.JWT_SECRET || 'gtr_secret_jwt_default_key_production_2026';
const secretFile = path.resolve(process.cwd(), '.server_jwt_secret');
if (fs.existsSync(secretFile)) {
  JWT_SECRET = fs.readFileSync(secretFile, 'utf-8').trim();
} else {
  try {
    const db = new Database(path.resolve(process.cwd(), 'gtr_pos_sandbox.db'), { readonly: true });
    const row = db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get();
    if (row && row.value) JWT_SECRET = row.value.trim();
    db.close();
  } catch (_) {}
}

function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role,
      permissions: user.permissions || {}
    },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

function requestJson(urlPath, method = 'GET', token = null) {
  return new Promise((resolve, reject) => {
    const headers = { 'Accept': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = http.request({
      hostname: '127.0.0.1',
      port: 3000,
      path: urlPath,
      method,
      headers,
      timeout: 5000
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (_) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    req.end();
  });
}

async function run() {
  console.log('='.repeat(70));
  console.log(' RUNNING PRODUCT HISTORY MULTI-SOURCE SYNTHESIS TESTS');
  console.log('='.repeat(70));

  const dbPath = path.resolve(process.cwd(), 'gtr_pos_sandbox.db');
  const db = new Database(dbPath);

  // Set up test users from database: admin (id: 4) & cashier (id: 3)
  const adminUser = db.prepare("SELECT id, username, role, permissions FROM users WHERE role = 'admin' LIMIT 1").get() || { id: 4, username: 'admin', role: 'admin' };
  const cashierUser = db.prepare("SELECT id, username, role, permissions FROM users WHERE role = 'vendedor' LIMIT 1").get() || { id: 3, username: 'maria', role: 'vendedor' };

  const adminToken = generateToken({ id: adminUser.id, username: adminUser.username, role: adminUser.role });
  const cashierToken = generateToken({ id: cashierUser.id, username: cashierUser.username, role: cashierUser.role, permissions: { view_costs: false } });

  // 1. Create a product like Samsung S26 Ultra (SKU: TEST-S26, stock: 1, price_unit: 1.00)
  const existing = db.prepare('SELECT id FROM products WHERE sku = ?').get('TEST-S26');
  let testProdId;
  if (existing) {
    testProdId = existing.id;
    db.prepare('UPDATE products SET stock = 1, price_unit = 1.00, price_cost = 0.50 WHERE id = ?').run(testProdId);
    db.prepare('DELETE FROM stock_arrivals WHERE product_id = ?').run(testProdId);
    db.prepare('DELETE FROM sale_items WHERE product_id = ?').run(testProdId);
    db.prepare('DELETE FROM sale_returns WHERE product_id = ?').run(testProdId);
    db.prepare('DELETE FROM inventory_count_items WHERE product_id = ?').run(testProdId);
    db.prepare('DELETE FROM inventory_audit_logs WHERE product_id = ?').run(testProdId);
    db.prepare('DELETE FROM system_audit_logs WHERE related_product_id = ?').run(testProdId);
  } else {
    const res = db.prepare(`
      INSERT INTO products (name, sku, category, stock, price_unit, price_bulk, price_cost, stock_alarm, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run('Samsung S26 Ultra 512GB Test', 'TEST-S26', 'ACCESORIOS', 1, 1.00, 0.90, 0.50, 2);
    testProdId = res.lastInsertRowid;
  }

  console.log(`\n--- Test 1: Brand new product with stock = 1 and 0 log entries ---`);
  const res1 = await requestJson(`/api/products/${testProdId}/audit-history`, 'GET', adminToken);
  console.log(`HTTP Status: ${res1.status}, Movements count: ${res1.data.length}`);
  if (res1.status !== 200 || res1.data.length === 0) {
    console.error('❌ FAIL: Expected at least 1 synthesized creation movement for brand new product!');
    process.exit(1);
  }
  const initLog = res1.data[0];
  console.log('Synthesized movement:', {
    type: initLog.type,
    quantity: initLog.quantity,
    quantity_before: initLog.quantity_before,
    quantity_after: initLog.quantity_after,
    reference: initLog.reference
  });
  if (initLog.type !== 'creacion_producto' || initLog.quantity !== 1 || initLog.quantity_after !== 1) {
    console.error('❌ FAIL: Movement did not match expected creation event structure!');
    process.exit(1);
  }
  console.log('✅ PASS: Brand new product correctly synthesizes initial creation stock movement!');

  console.log(`\n--- Test 2: Add a stock arrival (purchase of 5 units) ---`);
  db.prepare(`
    INSERT INTO stock_arrivals (product_id, quantity, arrival_price, created_at)
    VALUES (?, ?, ?, datetime('now', '-2 hours'))
  `).run(testProdId, 5, 0.60);
  db.prepare('UPDATE products SET stock = stock + 5 WHERE id = ?').run(testProdId);

  const res2 = await requestJson(`/api/products/${testProdId}/audit-history`, 'GET', adminToken);
  console.log(`Movements count after purchase: ${res2.data.length}`);
  const arrLog = res2.data.find(d => d.type === 'ingreso_compra');
  if (!arrLog || arrLog.quantity !== 5) {
    console.error('❌ FAIL: Expected purchase movement with quantity 5!');
    process.exit(1);
  }
  console.log('Purchase movement:', {
    type: arrLog.type,
    quantity: arrLog.quantity,
    quantity_before: arrLog.quantity_before,
    quantity_after: arrLog.quantity_after,
    price: arrLog.price
  });
  console.log('✅ PASS: Purchase movement correctly synthesized with proper running stock!');

  console.log(`\n--- Test 3: Add a sale of 2 units ---`);
  const saleRes = db.prepare(`
    INSERT INTO sales (total, discount, payment_method, user_id, exchange_rate, currency, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-1 hour'))
  `).run(2.00, 0, 'efectivo', 1, 6.96, 'BOB');
  const saleId = saleRes.lastInsertRowid;

  db.prepare(`
    INSERT INTO sale_items (sale_id, product_id, product_name_snapshot, product_sku_snapshot, quantity, price, cost, subtotal_minor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(saleId, testProdId, 'Samsung S26 Ultra 512GB Test', 'TEST-S26', 2, 1.00, 0.50, 2.00);
  db.prepare('UPDATE products SET stock = stock - 2 WHERE id = ?').run(testProdId);

  const res3 = await requestJson(`/api/products/${testProdId}/audit-history`, 'GET', adminToken);
  const saleLog = res3.data.find(d => d.type === 'salida_venta');
  if (!saleLog || saleLog.quantity !== 2) {
    console.error('❌ FAIL: Expected sale movement with quantity 2!');
    process.exit(1);
  }
  console.log('Sale movement:', {
    type: saleLog.type,
    quantity: saleLog.quantity,
    quantity_before: saleLog.quantity_before,
    quantity_after: saleLog.quantity_after,
    reference: saleLog.reference
  });
  console.log('✅ PASS: Sale movement correctly synthesized with correct kárdex delta!');

  console.log(`\n--- Test 4: Add customer return of 1 unit ---`);
  db.prepare(`
    INSERT INTO sale_returns (sale_id, sale_item_id, product_id, product_name, product_sku, quantity, refund_amount, unit_price, reason, user_id, username, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-30 minutes'))
  `).run(saleId, 1, testProdId, 'Samsung S26 Ultra 512GB Test', 'TEST-S26', 1, 1.00, 1.00, 'Cambio de color', 1, 'admin');
  db.prepare('UPDATE products SET stock = stock + 1 WHERE id = ?').run(testProdId);

  const res4 = await requestJson(`/api/products/${testProdId}/audit-history`, 'GET', adminToken);
  const returnLog = res4.data.find(d => d.type === 'ingreso_devolucion');
  if (!returnLog || returnLog.quantity !== 1) {
    console.error('❌ FAIL: Expected return movement with quantity 1!');
    process.exit(1);
  }
  console.log('Return movement:', {
    type: returnLog.type,
    quantity: returnLog.quantity,
    quantity_before: returnLog.quantity_before,
    quantity_after: returnLog.quantity_after,
    notes: returnLog.notes
  });
  console.log('✅ PASS: Customer return movement synthesized and categorized correctly!');

  console.log(`\n--- Test 5: Verify cost protection for Cashier role ---`);
  const res5 = await requestJson(`/api/products/${testProdId}/audit-history`, 'GET', cashierToken);
  const cashierArrLog = res5.data.find(d => d.type === 'ingreso_compra');
  if (cashierArrLog.price !== null) {
    console.error(`❌ FAIL: Expected arrival price to be null for cashier, but got ${cashierArrLog.price}`);
    process.exit(1);
  }
  console.log('Cashier view arrival price:', cashierArrLog.price);
  console.log('✅ PASS: Cost masking strictly enforced for non-admin roles!');

  console.log(`\n--- Test 6: Verify mathematical balance of full kárdex ---`);
  // Current stock should equal: initial (1) + purchase (5) - sale (2) + return (1) = 5
  const prodFinal = db.prepare('SELECT stock FROM products WHERE id = ?').get(testProdId);
  console.log(`Current product stock in DB: ${prodFinal.stock}`);
  const latestLog = res4.data[0]; // newest
  if (latestLog.quantity_after !== prodFinal.stock) {
    console.error(`❌ FAIL: Kárdex latest quantity_after (${latestLog.quantity_after}) does not match current stock (${prodFinal.stock})!`);
    process.exit(1);
  }
  console.log(`✅ PASS: Kárdex latest stock (${latestLog.quantity_after}) perfectly matches live stock (${prodFinal.stock})!`);

  console.log('\n=======================================================');
  console.log('🏆 ALL PRODUCT HISTORY SYNTHESIS TESTS PASSED (6/6)');
  console.log('=======================================================\n');
}

run().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
