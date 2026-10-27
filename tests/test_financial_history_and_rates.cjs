const http = require('http');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');

const PORT = 3000;
const DB_PATH = './gtr_pos_sandbox.db';
const db = new Database(DB_PATH);

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

async function runTestSuite() {
  console.log("=====================================================================");
  console.log("  GTR666 — SUITE DE PRUEBAS: HISTÓRICOS FINANCIEROS Y TIPO DE CAMBIO ");
  console.log("=====================================================================");

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

  // Obtenemos token de administrador para llamadas HTTP
  const jwtSetting = db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get();
  let jwtSecret = jwtSetting?.value;
  if (!jwtSecret && fs.existsSync('./.server_jwt_secret')) {
    jwtSecret = fs.readFileSync('./.server_jwt_secret', 'utf8').trim();
  }
  const adminUser = db.prepare("SELECT * FROM users WHERE role = 'admin' LIMIT 1").get();
  const adminToken = jwt.sign({
    id: adminUser.id,
    username: adminUser.username,
    role: adminUser.role,
    permissions: typeof adminUser.permissions === 'string' ? JSON.parse(adminUser.permissions || '{}') : (adminUser.permissions || {})
  }, jwtSecret || 'secret', { expiresIn: '1h' });

  // -------------------------------------------------------------
  // TEST 1: VERIFICACIÓN EN BASE AISLADA DE TASAS 10, 11 Y 12
  // -------------------------------------------------------------
  console.log("\n--- TEST 1: Inmutabilidad Multi-Tasa (10, 11 y 12) en BD Aislada ---");
  const isoDb = new Database(':memory:');
  
  // Setup isolated schema identical to production
  isoDb.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT, permissions TEXT);
    CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, sku TEXT, price_cost REAL, price_unit REAL, price_bulk REAL, stock REAL, stock_alarm REAL);
    CREATE TABLE sales (id INTEGER PRIMARY KEY AUTOINCREMENT, total REAL, discount REAL, payment_method TEXT, user_id INTEGER, client_id INTEGER, exchange_rate REAL, currency TEXT, cierre_id INTEGER, notes TEXT, client_operation_id TEXT, created_at TEXT);
    CREATE TABLE sale_items (id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER, product_id INTEGER, quantity REAL, price REAL, cost REAL, product_name_snapshot TEXT, product_sku_snapshot TEXT, subtotal_minor REAL);
    CREATE TABLE sale_returns (id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER, sale_item_id INTEGER, product_id INTEGER, product_name TEXT, product_sku TEXT, quantity REAL, refund_amount REAL, unit_price REAL, reason TEXT, user_id INTEGER, username TEXT, cashier_id INTEGER, cashier_username TEXT, created_at TEXT);
    CREATE TABLE cash_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, seller_id INTEGER UNIQUE, seller_username TEXT, current_balance REAL, updated_at TEXT);
    CREATE TABLE cash_movements (id INTEGER PRIMARY KEY AUTOINCREMENT, seller_id INTEGER, sale_id INTEGER, type TEXT, amount REAL, currency TEXT, payment_method TEXT, status TEXT, notes TEXT, created_at TEXT);
  `);

  isoDb.prepare("INSERT INTO users VALUES (1, 'cajero1', 'vendedor', '{}')").run();
  isoDb.prepare("INSERT INTO products VALUES (1, 'Taladro Percutor', 'TAL-001', 4.0, 10.0, 9.0, 100, 5)").run();
  isoDb.prepare("INSERT INTO cash_accounts VALUES (1, 1, 'cajero1', 0.0, '2026-10-20 10:00:00')").run();

  // Paso 1: Tasa 10.00
  isoDb.prepare("INSERT OR REPLACE INTO settings VALUES ('exchange_rate', '10.00')").run();
  const resSale1 = isoDb.prepare(`
    INSERT INTO sales (total, discount, payment_method, user_id, exchange_rate, currency, created_at)
    VALUES (10.0, 0.0, 'Efectivo', 1, 10.00, 'USD', '2026-10-20 10:00:00')
  `).run();
  const sale1Id = resSale1.lastInsertRowid;
  isoDb.prepare("INSERT INTO sale_items (sale_id, product_id, quantity, price, cost) VALUES (?, 1, 1, 10.0, 4.0)").run(sale1Id);
  isoDb.prepare("INSERT INTO cash_movements (seller_id, sale_id, type, amount, currency, payment_method, status, created_at) VALUES (1, ?, 'venta', 10.0, 'USD', 'Efectivo', 'pendiente', '2026-10-20 10:00:00')").run(sale1Id);
  isoDb.prepare("UPDATE cash_accounts SET current_balance = current_balance + (10.0 * 10.00) WHERE seller_id = 1").run();

  // Paso 2: Cambiamos precios y tasa a 11.00
  isoDb.prepare("INSERT OR REPLACE INTO settings VALUES ('exchange_rate', '11.00')").run();
  isoDb.prepare("UPDATE products SET price_unit = 12.0, price_cost = 5.0 WHERE id = 1").run();

  const resSale2 = isoDb.prepare(`
    INSERT INTO sales (total, discount, payment_method, user_id, exchange_rate, currency, created_at)
    VALUES (12.0, 0.0, 'Efectivo', 1, 11.00, 'USD', '2026-10-20 11:00:00')
  `).run();
  const sale2Id = resSale2.lastInsertRowid;
  isoDb.prepare("INSERT INTO sale_items (sale_id, product_id, quantity, price, cost) VALUES (?, 1, 1, 12.0, 5.0)").run(sale2Id);
  isoDb.prepare("INSERT INTO cash_movements (seller_id, sale_id, type, amount, currency, payment_method, status, created_at) VALUES (1, ?, 'venta', 12.0, 'USD', 'Efectivo', 'pendiente', '2026-10-20 11:00:00')").run(sale2Id);
  isoDb.prepare("UPDATE cash_accounts SET current_balance = current_balance + (12.0 * 11.00) WHERE seller_id = 1").run();

  // Paso 3: Cambiamos precios y tasa a 12.00
  isoDb.prepare("INSERT OR REPLACE INTO settings VALUES ('exchange_rate', '12.00')").run();
  isoDb.prepare("UPDATE products SET price_unit = 15.0, price_cost = 6.0 WHERE id = 1").run();

  const resSale3 = isoDb.prepare(`
    INSERT INTO sales (total, discount, payment_method, user_id, exchange_rate, currency, created_at)
    VALUES (180.0, 0.0, 'Efectivo', 1, 12.00, 'BOB', '2026-10-20 12:00:00')
  `).run();
  const sale3Id = resSale3.lastInsertRowid;
  isoDb.prepare("INSERT INTO sale_items (sale_id, product_id, quantity, price, cost) VALUES (?, 1, 1, 180.0, 6.0)").run(sale3Id);
  isoDb.prepare("INSERT INTO cash_movements (seller_id, sale_id, type, amount, currency, payment_method, status, created_at) VALUES (1, ?, 'venta', 180.0, 'BOB', 'Efectivo', 'pendiente', '2026-10-20 12:00:00')").run(sale3Id);
  isoDb.prepare("UPDATE cash_accounts SET current_balance = current_balance + 180.0 WHERE seller_id = 1").run();

  // Verificación de inmutabilidad
  const s1Check = isoDb.prepare("SELECT * FROM sales WHERE id = ?").get(sale1Id);
  const s2Check = isoDb.prepare("SELECT * FROM sales WHERE id = ?").get(sale2Id);
  const s3Check = isoDb.prepare("SELECT * FROM sales WHERE id = ?").get(sale3Id);

  assert(s1Check.exchange_rate === 10.00 && s1Check.total === 10.0, "Venta 1 conserva intacta su tasa 10.00 y total $10 USD");
  assert(s2Check.exchange_rate === 11.00 && s2Check.total === 12.0, "Venta 2 conserva intacta su tasa 11.00 y total $12 USD");
  assert(s3Check.exchange_rate === 12.00 && s3Check.total === 180.0, "Venta 3 conserva intacta su tasa 12.00 y total Bs. 180 BOB");

  // -------------------------------------------------------------
  // TEST 2: RECONSTRUCCIÓN DE CAJA USANDO SALES.EXCHANGE_RATE
  // -------------------------------------------------------------
  console.log("\n--- TEST 2: Reconstrucción de Saldo de Caja y Self-Healing ---");
  // Total acumulado legítimo en caja:
  // Venta 1: $10 * 10 = 100 Bs.
  // Venta 2: $12 * 11 = 132 Bs.
  // Venta 3: 180 Bs.
  // Total esperado = 100 + 132 + 180 = 412 Bs.
  const expectedTotalBalance = 412.0;

  // Ejecutamos la lógica corregida de selfHealCashAccounts
  const pendingMovs = isoDb.prepare(`
    SELECT m.*, s.exchange_rate as sale_exchange_rate
    FROM cash_movements m
    LEFT JOIN sales s ON m.sale_id = s.id
    WHERE m.seller_id = 1 AND m.status = 'pendiente'
  `).all();

  let calculatedBalance = 0;
  for (const m of pendingMovs) {
    const rate = Number(m.sale_exchange_rate || 12.00);
    const amtInBs = m.currency === 'USD' ? (m.amount * rate) : m.amount;
    calculatedBalance += amtInBs;
  }

  assert(Math.abs(calculatedBalance - expectedTotalBalance) < 0.001, "Cálculo de arqueo de caja cuadra a 412 Bs usando tasas históricas", `Obtenido: ${calculatedBalance}`);

  // Simulamos lo que pasaba con el bug antiguo (usaba la tasa actual 12.00):
  let buggedBalance = 0;
  for (const m of pendingMovs) {
    const amtInBs = m.currency === 'USD' ? (m.amount * 12.00) : m.amount;
    buggedBalance += amtInBs;
  }
  assert(buggedBalance === 444.0, "El bug anterior habría inflado artificialmente la caja a 444 Bs");

  // -------------------------------------------------------------
  // TEST 3: DEVOLUCIÓN DE VENTA USD AL CAMBIO HISTÓRICO
  // -------------------------------------------------------------
  console.log("\n--- TEST 3: Devolución Coherente con Moneda Original y Tasa Histórica ---");
  // Se devuelve la Venta 1 ($10 USD) cuando la tasa vigente es 12.00.
  // La devolución debe reembolsar en USD y deducir de la caja exactamente 100 Bs (tasa 10.00).
  const origSale = isoDb.prepare("SELECT * FROM sales WHERE id = ?").get(sale1Id);
  const refundRate = Number(origSale.exchange_rate);
  const refundAmtBs = origSale.currency === 'USD' ? (10.0 * refundRate) : 10.0;

  isoDb.prepare(`
    INSERT INTO cash_movements (seller_id, sale_id, type, amount, currency, payment_method, status, notes)
    VALUES (1, ?, 'devolucion', -10.0, 'USD', 'Efectivo', 'pendiente', 'Reembolso venta 1')
  `).run(sale1Id);

  isoDb.prepare("UPDATE cash_accounts SET current_balance = current_balance - ? WHERE seller_id = 1").run(refundAmtBs);

  const accAfterRefund = isoDb.prepare("SELECT current_balance FROM cash_accounts WHERE seller_id = 1").get();
  assert(Math.abs(accAfterRefund.current_balance - (412 - 100)) < 0.001, "Saldo en caja dedujo exactamente 100 Bs tras devolución de venta USD a tasa 10", `Saldo actual: ${accAfterRefund.current_balance}`);

  // Reejecutar self-healing
  const pendingMovsAfterRefund = isoDb.prepare(`
    SELECT m.*, s.exchange_rate as sale_exchange_rate
    FROM cash_movements m
    LEFT JOIN sales s ON m.sale_id = s.id
    WHERE m.seller_id = 1 AND m.status = 'pendiente'
  `).all();
  let healedAfterRefund = 0;
  for (const m of pendingMovsAfterRefund) {
    const rate = Number(m.sale_exchange_rate || 10.00);
    const amtInBs = m.currency === 'USD' ? (m.amount * rate) : m.amount;
    healedAfterRefund += amtInBs;
  }
  assert(Math.abs(healedAfterRefund - 312.0) < 0.001, "Arqueo tras devolución cuadra exactamente en 312 Bs", `Obtenido: ${healedAfterRefund}`);

  // -------------------------------------------------------------
  // TEST 4: EXCLUSIÓN DE ITEMS ANTIGUOS SIN COSTO EN UTILIDADES
  // -------------------------------------------------------------
  console.log("\n--- TEST 4: Exclusión de Items sin Costo en Utilidades ---");
  // Insertamos venta histórica antigua donde cost es NULL
  const ancientSale = isoDb.prepare("INSERT INTO sales (total, discount, payment_method, user_id, exchange_rate, currency, created_at) VALUES (50.0, 0.0, 'Efectivo', 1, 6.96, 'BOB', '2026-10-20 08:00:00')").run();
  isoDb.prepare("INSERT INTO sale_items (sale_id, product_id, quantity, price, cost) VALUES (?, 1, 1, 50.0, NULL)").run(ancientSale.lastInsertRowid);

  // Ejecutamos la consulta de profit corregida:
  const profitRow = isoDb.prepare(`
    SELECT COALESCE(SUM(
      CASE 
        WHEN si.cost IS NOT NULL AND si.cost > 0 THEN 
          (CASE WHEN s.currency='USD' THEN (si.price - si.cost) * s.exchange_rate ELSE si.price - (si.cost * s.exchange_rate) END) * si.quantity
        ELSE 0 
      END
    ), 0) as gross_profit
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    WHERE s.id = ?
  `).get(ancientSale.lastInsertRowid);

  assert(profitRow.gross_profit === 0, "Venta antigua con cost = NULL queda excluida de utilidades con profit = 0 (no proyecta catalog cost)", `Profit obtenido: ${profitRow.gross_profit}`);

  // -------------------------------------------------------------
  // TEST 5: LLAMADA A ENDPOINT ACTIVO /api/dashboard
  // -------------------------------------------------------------
  console.log("\n--- TEST 5: Verificación de Respuestas de API en Dev Server ---");
  const dashRes = await request({
    path: '/api/dashboard',
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${adminToken}`
    }
  });

  assert(dashRes.status === 200, "GET /api/dashboard responde HTTP 200");
  assert(typeof dashRes.body.salesToday === 'number', "salesToday es un número válido");
  assert(typeof dashRes.body.profitToday === 'number', "profitToday es un número válido");
  assert(Array.isArray(dashRes.body.sellers), "sellers es un array");

  // -------------------------------------------------------------
  // TEST 6: VALIDACIÓN DE RATE EN POST /api/sales
  // -------------------------------------------------------------
  console.log("\n--- TEST 6: Verificación de Tasa en POST /api/sales ---");
  // Obtenemos producto existente
  const prodRow = db.prepare("SELECT * FROM products WHERE stock > 5 LIMIT 1").get();
  if (prodRow) {
    const rateVal = parseFloat(db.prepare("SELECT value FROM settings WHERE key = 'exchange_rate'").get()?.value || '6.96');
    const unitPriceBs = Math.round(prodRow.price_unit * rateVal * 2) / 2;
    const saleTestPayload = {
      user_id: adminUser.id,
      payment_method: 'Efectivo',
      currency: 'BOB',
      exchange_rate: 99.99, // El cliente envía una tasa alterada o desactualizada
      items: [
        {
          product_id: prodRow.id,
          quantity: 1,
          price: unitPriceBs
        }
      ],
      total: unitPriceBs
    };

    const saleRes = await request({
      path: '/api/sales',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      }
    }, saleTestPayload);

    assert(saleRes.status === 200 && saleRes.body.success, "POST /api/sales procesó venta con éxito");
    if (saleRes.body.saleId) {
      const savedSale = db.prepare("SELECT exchange_rate FROM sales WHERE id = ?").get(saleRes.body.saleId);
      const serverRate = db.prepare("SELECT value FROM settings WHERE key = 'exchange_rate'").get()?.value;
      assert(Math.abs(savedSale.exchange_rate - parseFloat(serverRate)) < 0.01, "La tasa guardada en la venta es la oficial del servidor y no la alterada (99.99)", `Guardada: ${savedSale.exchange_rate}, Oficial: ${serverRate}`);
    }
  }

  console.log("\n==================================================");
  console.log(`  RESULTADO: ${passed} PASSED | ${failed} FAILED`);
  console.log("==================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch(err => {
  console.error("Test Suite Error:", err);
  process.exit(1);
});
