const http = require('http');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');

const PORT = 3000;
const DB_PATH = './gtr_pos_sandbox.db';
const db = new Database(DB_PATH);

// Helper to make HTTP requests
function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const headers = options.headers || {};
    headers['x-app-environment'] = 'sandbox';
    const req = http.request({
      hostname: 'localhost',
      port: PORT,
      ...options,
      headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

function roundCashBs(amount) {
  if (!Number.isFinite(amount)) return 0;
  return Math.round((amount + Number.EPSILON) * 2) / 2;
}

async function runTests() {
  console.log("==================================================");
  console.log("   GTR POS - VALIDACIÓN EXHAUSTIVA DE 6 PUNTOS    ");
  console.log("==================================================");

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, details = "") {
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName} ${details ? "- " + details : ""}`);
      failed++;
    }
  }

  // Retrieve JWT secret from DB / file for test token generation
  const jwtSetting = db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get();
  let jwtSecret = jwtSetting?.value;
  if (!jwtSecret && fs.existsSync('./.server_jwt_secret')) {
    jwtSecret = fs.readFileSync('./.server_jwt_secret', 'utf8').trim();
  }

  // Ensure test users exist in SQLite
  // 1. Admin user
  let adminUser = db.prepare("SELECT * FROM users WHERE role = 'admin' LIMIT 1").get();
  if (!adminUser) {
    db.prepare("INSERT INTO users (username, password, role, permissions) VALUES (?, ?, ?, ?)").run('admin', 'admin123', 'admin', '{}');
    adminUser = db.prepare("SELECT * FROM users WHERE role = 'admin' LIMIT 1").get();
  }
  const adminToken = jwt.sign({ id: adminUser.id, username: adminUser.username, role: 'admin' }, jwtSecret);

  // 2. Vendedor user without special permissions
  let sellerUser = db.prepare("SELECT * FROM users WHERE role = 'vendedor' AND username = 'vendedor_test'").get();
  if (!sellerUser) {
    db.prepare("INSERT INTO users (username, password, role, permissions) VALUES (?, ?, ?, ?)").run(
      'vendedor_test', 'vend123', 'vendedor', JSON.stringify({
        create_sales: true,
        select_price_unit: true,
        select_price_bulk: true,
        manage_caja: true,
        view_costs: false,
        view_purchase_prices: false,
        modify_prices: false,
        edit_prices: false,
        register_manual_incomes: false,
        register_withdrawals: false,
        make_refunds: false,
        view_reports: false
      })
    );
    sellerUser = db.prepare("SELECT * FROM users WHERE username = 'vendedor_test'").get();
  }
  const sellerToken = jwt.sign({ id: sellerUser.id, username: sellerUser.username, role: 'vendedor' }, jwtSecret);

  // Get test product
  const testProduct = db.prepare("SELECT id, name, price_unit, price_bulk, price_cost, stock FROM products WHERE stock > 10 LIMIT 1").get();
  const rateRow = db.prepare("SELECT value FROM settings WHERE key = 'exchange_rate'").get();
  const currentRate = parseFloat(rateRow?.value || '6.96');

  // --- PUNTO 1: PRECIOS ---
  console.log("\n--- PUNTO 1: PRECIOS (roundBs exacto, mayorista, USD/Bs, total) ---");
  
  // 1.1 Venta con precio oficial unitario en Bs
  const officialPriceBs = roundCashBs(testProduct.price_unit * currentRate);
  const legitSaleRes = await request({
    path: '/api/sales',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sellerToken}`
    }
  }, {
    total: officialPriceBs,
    discount: 0,
    currency: 'BOB',
    exchange_rate: currentRate,
    items: [{ product_id: testProduct.id, quantity: 1, price: officialPriceBs }]
  });
  assert(legitSaleRes.status === 200, "Venta legítima a precio oficial unitario (roundCashBs a 0.50) aprobada con éxito");

  // 1.2 Venta con precio oficial mayorista en Bs
  const officialBulkBs = roundCashBs(testProduct.price_bulk * currentRate);
  const bulkSaleRes = await request({
    path: '/api/sales',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sellerToken}`
    }
  }, {
    total: officialBulkBs,
    discount: 0,
    currency: 'BOB',
    exchange_rate: currentRate,
    items: [{ product_id: testProduct.id, quantity: 1, price: officialBulkBs }]
  });
  assert(bulkSaleRes.status === 200, "Venta legítima a precio oficial mayorista (roundCashBs a 0.50) aprobada con éxito");

  // 1.3 Venta con precio no redondeado a 0.50 Bs (ej. +0.20 Bs)
  const unroundedPriceBs = officialPriceBs + 0.20;
  const unroundedPriceRes = await request({
    path: '/api/sales',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sellerToken}`
    }
  }, {
    total: unroundedPriceBs,
    discount: 0,
    currency: 'BOB',
    exchange_rate: currentRate,
    items: [{ product_id: testProduct.id, quantity: 1, price: unroundedPriceBs }]
  });
  assert(unroundedPriceRes.status === 403, "Venta con precio no redondeado a Bs 0.50 rechazada con 403");

  // 1.3 Venta con precio unitario alterado por vendedor no autorizado
  const alteredPriceRes = await request({
    path: '/api/sales',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sellerToken}`
    }
  }, {
    total: 1.00,
    discount: 0,
    currency: 'BOB',
    exchange_rate: currentRate,
    items: [{ product_id: testProduct.id, quantity: 1, price: 1.00 }]
  });
  assert(alteredPriceRes.status === 403, "Venta con precio alterado rechazada con 403");

  // 1.4 Venta con precio unitario normal pero total final manipulado (total falso)
  const alteredTotalRes = await request({
    path: '/api/sales',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sellerToken}`
    }
  }, {
    total: 0.50, // manipulado a pesar de item a precio oficial
    discount: 0,
    currency: 'BOB',
    exchange_rate: currentRate,
    items: [{ product_id: testProduct.id, quantity: 1, price: officialPriceBs }]
  });
  assert(alteredTotalRes.status === 403, "Venta con total final manipulado rechazada con 403");

  // --- PUNTO 2: CAJA ---
  console.log("\n--- PUNTO 2: CAJA (manage_caja no basta, permisos específicos e identidad) ---");
  
  // 2.1 Vendedor sin register_manual_incomes intenta ingreso manual
  const ingresoRes = await request({
    path: `/api/cash-accounts/${sellerUser.id}/adjust`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sellerToken}`
    }
  }, { amount: 50, type: 'ingreso_manual', notes: 'Prueba ingreso' });
  assert(ingresoRes.status === 403, "Ingreso manual sin permiso register_manual_incomes rechazado con 403");

  // 2.2 Vendedor sin register_withdrawals intenta retiro manual
  const retiroRes = await request({
    path: `/api/cash-accounts/${sellerUser.id}/adjust`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sellerToken}`
    }
  }, { amount: 50, type: 'retiro_manual', notes: 'Prueba retiro' });
  assert(retiroRes.status === 403, "Retiro manual sin permiso register_withdrawals rechazado con 403");

  // 2.3 Vendedor intenta ajustar la caja de otro vendedor
  const otherCashRes = await request({
    path: `/api/cash-accounts/${adminUser.id}/adjust`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sellerToken}`
    }
  }, { amount: 50, type: 'ingreso_manual', notes: 'Prueba caja ajena' });
  assert(otherCashRes.status === 403, "Ajuste en cuenta de caja ajena rechazado con 403");

  // --- PUNTO 3: USUARIOS ---
  console.log("\n--- PUNTO 3: USUARIOS (targetUser.permissions, preservación y bloqueo de elevación) ---");

  // 3.1 Vendedor intenta cambiar su propio rol a admin
  const elevateRoleRes = await request({
    path: `/api/users/${sellerUser.id}`,
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sellerToken}`
    }
  }, { role: 'admin' });
  assert(elevateRoleRes.status === 403, "Intento de elevar rol propio a admin rechazado con 403");

  // 3.2 Vendedor intenta agregarse permisos
  const elevatePermsRes = await request({
    path: `/api/users/${sellerUser.id}`,
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sellerToken}`
    }
  }, { permissions: { modify_prices: true, admin_users: true } });
  assert(elevatePermsRes.status === 403, "Intento de modificar permisos propios rechazado con 403");

  // 3.3 Admin actualiza usuario y preserva campos no modificados
  const adminUpdateRes = await request({
    path: `/api/users/${sellerUser.id}`,
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    }
  }, { email: 'vendedor_actualizado@test.com' });
  const checkUpdated = db.prepare("SELECT email, role, permissions FROM users WHERE id = ?").get(sellerUser.id);
  assert(adminUpdateRes.status === 200 && checkUpdated.email === 'vendedor_actualizado@test.com' && checkUpdated.role === 'vendedor',
    "Admin actualiza datos y preserva rol/permisos correctamente");

  // --- PUNTO 4: COSTOS Y CACHÉ ---
  console.log("\n--- PUNTO 4: COSTOS Y CACHÉ (Filtrado en todas las APIs de productos y reportes) ---");

  // 4.1 GET /api/products con token de vendedor no expone price_cost
  const sellerProdsRes = await request({
    path: '/api/products',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${sellerToken}` }
  });
  const productsList = Array.isArray(sellerProdsRes.body) ? sellerProdsRes.body : (sellerProdsRes.body.products || []);
  const exposedCost = productsList.some(p => p.price_cost !== null && p.price_cost !== undefined);
  assert(sellerProdsRes.status === 200 && !exposedCost, "GET /api/products para vendedor oculta estrictamente price_cost (null)");

  // 4.2 GET /api/sales/:id/items para vendedor oculta cost
  const salesRow = db.prepare("SELECT id FROM sales WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(sellerUser.id) || db.prepare("SELECT id FROM sales LIMIT 1").get();
  if (salesRow) {
    const saleItemsRes = await request({
      path: `/api/sales/${salesRow.id}/items`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${sellerToken}` }
    });
    const itemsList = Array.isArray(saleItemsRes.body) ? saleItemsRes.body : [];
    const exposedSaleCost = itemsList.some(it => it.cost !== null && it.cost !== undefined);
    assert(saleItemsRes.status === 200 && !exposedSaleCost, "GET /api/sales/:id/items para vendedor oculta costo unitario (null)");
  }

  // 4.3 GET /api/products/diagnose-duplicates rechazado para vendedor
  const dupesRes = await request({
    path: '/api/products/diagnose-duplicates',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${sellerToken}` }
  });
  assert(dupesRes.status === 401 || dupesRes.status === 403, "GET /api/products/diagnose-duplicates protegido con 401/403");

  // --- PUNTO 5: JWT PERSISTENTE Y PRIVADO ---
  console.log("\n--- PUNTO 5: JWT PERSISTENTE Y PRIVADO ---");
  const authSecurity = fs.readFileSync('./authSecurity.ts', 'utf8');
  assert(!authSecurity.includes('gtr_pos_secure_production_secret_key_fixed_998877'),
    "authSecurity.ts no contiene la clave fija vulnerable");
  assert(jwtSecret && jwtSecret.length >= 32, "Clave JWT es criptográficamente segura y persistente en el servidor");

  // 5.1 Exportación de tablas limpias no expone jwt_secret
  const exportRes = await request({
    path: '/api/diagnose/clean-tables-export',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  const exportedSettings = exportRes.body?.settings || [];
  const leakedSecret = exportedSettings.some(s => s.key === 'jwt_secret');
  assert(exportRes.status === 200 && !leakedSecret, "clean-tables-export no expone jwt_secret ni secretos privados");

  // --- PUNTO 6: AUTORIZACIÓN Y RUTAS CRÍTICAS ---
  console.log("\n--- PUNTO 6: AUTORIZACIÓN (Operaciones destructivas, devoluciones, respaldos) ---");

  // 6.1 POST /api/admin/reset-database
  const resetDbRes = await request({
    path: '/api/admin/reset-database',
    method: 'POST',
    headers: { 'Authorization': `Bearer ${sellerToken}` }
  });
  assert(resetDbRes.status === 403, "POST /api/admin/reset-database rechaza a vendedor con 403");

  // 6.2 POST /api/shifts/reset
  const resetShiftsRes = await request({
    path: '/api/shifts/reset',
    method: 'POST',
    headers: { 'Authorization': `Bearer ${sellerToken}` }
  });
  assert(resetShiftsRes.status === 403, "POST /api/shifts/reset rechaza a vendedor con 403");

  // 6.3 POST /api/settings/exchange-rate
  const changeRateRes = await request({
    path: '/api/settings/exchange-rate',
    method: 'POST',
    headers: { 'Authorization': `Bearer ${sellerToken}` }
  }, { rate: 7.50 });
  assert(changeRateRes.status === 403, "POST /api/settings/exchange-rate rechaza a vendedor con 403");

  // 6.4 POST /api/inventory-counts/:id/approve
  const approveCountRes = await request({
    path: '/api/inventory-counts/1/approve',
    method: 'POST',
    headers: { 'Authorization': `Bearer ${sellerToken}` }
  });
  assert(approveCountRes.status === 403, "POST /api/inventory-counts/:id/approve rechaza a vendedor con 403");

  // 6.5 POST /api/sales/refund (requiere make_refunds)
  const refundRes = await request({
    path: '/api/sales/refund',
    method: 'POST',
    headers: { 'Authorization': `Bearer ${sellerToken}` }
  }, { sale_id: 1, item_refunds: [{ sale_item_id: 1, quantity: 1 }] });
  assert(refundRes.status === 403, "POST /api/sales/refund sin permiso make_refunds rechazado con 403");

  // 6.6 POST /api/backup/push & pull
  const backupPushRes = await request({
    path: '/api/backup/push',
    method: 'POST',
    headers: { 'Authorization': `Bearer ${sellerToken}` }
  });
  assert(backupPushRes.status === 401 || backupPushRes.status === 403, "POST /api/backup/push rechaza acceso sin privilegios (401/403)");

  // 6.7 POST /api/backup/restore-safety-backup
  const restoreBackupRes = await request({
    path: '/api/backup/restore-safety-backup',
    method: 'POST',
    headers: { 'Authorization': `Bearer ${sellerToken}` }
  });
  assert(restoreBackupRes.status === 403, "POST /api/backup/restore-safety-backup rechaza a vendedor con 403");

  // 6.8 POST /api/sandbox/clone-production
  const sandboxCloneRes = await request({
    path: '/api/sandbox/clone-production',
    method: 'POST',
    headers: { 'Authorization': `Bearer ${sellerToken}` }
  });
  assert(sandboxCloneRes.status === 403, "POST /api/sandbox/clone-production rechaza a vendedor con 403");

  // 6.9 GET /api/analytics/phase3-metrics
  const analyticsRes = await request({
    path: '/api/analytics/phase3-metrics',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${sellerToken}` }
  });
  assert(analyticsRes.status === 403, "GET /api/analytics/phase3-metrics rechaza a vendedor con 403");

  // 6.10 GET /api/dashboard
  const dashRes = await request({
    path: '/api/dashboard',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${sellerToken}` }
  });
  assert(dashRes.status === 403, "GET /api/dashboard rechaza a vendedor con 403");

  console.log("\n==================================================");
  console.log(`TOTAL PRUEBAS EJECUTADAS: ${passed + failed}`);
  console.log(`APROBADAS: ${passed} | FALLIDAS: ${failed}`);
  console.log("==================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error("Test execution fatal error:", err);
  process.exit(1);
});
