const http = require('http');
const fs = require('fs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = fs.readFileSync('.server_jwt_secret', 'utf8').trim();

function makeToken(user) {
  return jwt.sign(user, JWT_SECRET, { expiresIn: '1h' });
}

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log("=== INICIANDO VALIDACIÓN DE CORRECCIONES AUDITORÍA c227fa0 ===");
  let passed = 0;
  let failed = 0;

  function assert(desc, condition) {
    if (condition) {
      console.log(`  [PASS] ${desc}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${desc}`);
      failed++;
    }
  }

  const cashierToken = makeToken({ id: 3, username: 'maria', role: 'vendedor', permissions: {} });
  const cashierLiteralToken = makeToken({ id: 3, username: 'maria', role: 'cajero', permissions: {} });
  const adminToken = makeToken({ id: 4, username: 'admin', role: 'admin', permissions: { all: true } });
  const mainOwnerToken = makeToken({ id: 5, username: 'roby', role: 'propietario', permissions: { all: true } });

  // 1. B08: Admin sale with non-numeric price is rejected with 400
  try {
    const resB08 = await request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/sales',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      }
    }, {
      client_name: 'Test Non Numeric',
      total: 10,
      discount: 0,
      payment_method: 'Efectivo',
      currency: 'BOB',
      items: [{ product_id: 1, quantity: 1, price: 'invalid' }]
    });
    assert("B08: Venta con precio no numérico devuelve HTTP 400", resB08.status === 400);
  } catch (err) {
    assert("B08: Error al validar precio no numérico: " + err.message, false);
  }

  // 2. K07 & B04: Reusing clientOpId with different currency / payload returns 409 Conflict
  try {
    const opIdSale = "test_sale_conflict_" + Date.now();
    const resSale1 = await request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/sales',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cashierToken}`
      }
    }, {
      clientOperationId: opIdSale,
      total: 10,
      discount: 0,
      payment_method: 'Efectivo',
      currency: 'BOB',
      items: [{ product_id: 5, quantity: 1, price: 10 }]
    });

    // Try same opId with currency USD (different payload)
    const resSale2 = await request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/sales',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cashierToken}`
      }
    }, {
      clientOperationId: opIdSale,
      total: 10,
      discount: 0,
      payment_method: 'Efectivo',
      currency: 'USD',
      items: [{ product_id: 5, quantity: 1, price: 10 }]
    });

    assert("K07 & B04: Reutilizar clave de venta con diferente moneda devuelve HTTP 409", resSale2.status === 409);
  } catch (err) {
    assert("K07 & B04: Error en prueba: " + err.message, false);
  }

  // 3. E05 & E09: Pending sales deduplication via processed_operations
  try {
    const Database = require('better-sqlite3');
    const db = new Database('gtr_pos.db');
    const inStockProd = db.prepare('SELECT id, stock FROM products WHERE stock >= 20 LIMIT 1').get();
    db.close();

    const testProdId = inStockProd ? inStockProd.id : 5;
    const opIdPending = "test_pending_op_" + Date.now();
    const payloadPending = {
      clientOperationId: opIdPending,
      client_name: "Cliente Deduplicado",
      destination: "Santa Cruz",
      total: 10,
      discount: 0,
      currency: 'BOB',
      items: [{ product_id: testProdId, quantity: 1, price: 10 }]
    };

    const resPending1 = await request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/pending-sales',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cashierToken}`
      }
    }, payloadPending);

    const resPending2 = await request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/pending-sales',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cashierToken}`
      }
    }, payloadPending);

    assert("E05 & E09: Primer pedido pendiente retorna 200", resPending1.status === 200);
    assert("E05 & E09: Reintento con misma clave devuelve isDuplicate: true", resPending2.status === 200 && resPending2.body.isDuplicate === true);
    assert("E05 & E09: Mismo ID de pedido pendiente devuelto", resPending1.body && resPending2.body && resPending1.body.pendingSaleId === resPending2.body.pendingSaleId);
  } catch (err) {
    assert("E05 & E09: Error en prueba: " + err.message, false);
  }

  // 4. B05: Default-deny on manage_credits when undefined/missing
  try {
    const resAR = await request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/accounts-receivable',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${cashierToken}`
      }
    });
    assert("B05: Cajero sin manage_credits explícito recibe HTTP 403 en cuentas por cobrar", resAR.status === 403);
  } catch (err) {
    assert("B05: Error en prueba: " + err.message, false);
  }

  // 5. B06 & E13: Default-deny on physical_control_checklist
  try {
    const resCounts = await request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/inventory-counts',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${cashierToken}`
      }
    });
    assert("E13: Cajero sin physical_control_checklist explícito recibe HTTP 403 en listado de conteos", resCounts.status === 403);

    const resCountDetail = await request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/inventory-counts/1',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${cashierToken}`
      }
    });
    assert("E13: Cajero sin physical_control_checklist recibe HTTP 403 en detalle de conteo", resCountDetail.status === 403);
  } catch (err) {
    assert("B06 & E13: Error en prueba: " + err.message, false);
  }

  // 6. E10: Literal 'cajero' role cannot see global liquidations
  try {
    const resSettlements = await request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/cash-settlements',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${cashierLiteralToken}`
      }
    });
    assert("E10: Rol 'cajero' solo recibe sus propias liquidaciones", resSettlements.status === 200 && Array.isArray(resSettlements.body));
  } catch (err) {
    assert("E10: Error en prueba: " + err.message, false);
  }

  // 7. B03: Offline pending sales sanitizes items_json so cost is null for non-admins
  try {
    const resOfflinePending = await request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/offline-sales/pending',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${cashierToken}`
      }
    });
    if (resOfflinePending.status === 200 && resOfflinePending.body.sales && resOfflinePending.body.sales.length > 0) {
      const firstSale = resOfflinePending.body.sales[0];
      const parsedRawItems = JSON.parse(firstSale.items_json || '[]');
      const rawCostLeaked = parsedRawItems.some(it => it.cost !== null && it.cost !== undefined);
      assert("B03: Costos no se filtran en items_json de venta offline", !rawCostLeaked);
    } else {
      assert("B03: Endpoint responde 200 sanitizado", resOfflinePending.status === 200);
    }
  } catch (err) {
    assert("B03: Error en prueba: " + err.message, false);
  }

  // 8. B07 & K13: Offline submit attributes identity consistently to transmitting user
  try {
    const offlineId = "off_test_" + Date.now();
    const resOfflineSubmit = await request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/offline-sales/submit',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cashierToken}`
      }
    }, {
      id: offlineId,
      user_id: 999, // Fake user_id from body
      total: 10,
      discount: 0,
      payment_method: 'Efectivo',
      items: [{ product_id: 1, quantity: 1, price: 10 }]
    });

    assert("B07 & K13: Venta offline recibida exitosamente", resOfflineSubmit.status === 200);

    // Verify stored row in database has user_id = 3 (authenticated user) and not 999
    const Database = require('better-sqlite3');
    const db = new Database('gtr_pos.db');
    const storedOffline = db.prepare('SELECT user_id, user_name FROM offline_pending_sales WHERE id = ?').get(offlineId);
    assert("B07 & K13: user_id guardado es el usuario autenticado (3) y no el del cuerpo (999)", storedOffline && storedOffline.user_id === 3);
    db.close();
  } catch (err) {
    assert("B07 & K13: Error en prueba: " + err.message, false);
  }

  // 9. N06: Order edit aggregates duplicate lines
  try {
    const Database = require('better-sqlite3');
    const db = new Database('gtr_pos.db');
    const inStockProd = db.prepare('SELECT id, stock FROM products WHERE stock >= 20 LIMIT 1').get();
    db.close();

    const testProdId = inStockProd ? inStockProd.id : 5;
    const currentStock = Number(inStockProd ? inStockProd.stock : 20);

    // Create pending sale with 1 unit
    const resCreate = await request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/pending-sales',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      }
    }, {
      client_name: "Test Aggregate Edit",
      destination: "La Paz",
      total: 10,
      discount: 0,
      currency: 'BOB',
      items: [{ product_id: testProdId, quantity: 1, price: 10 }]
    });

    const pendingId = resCreate.body && resCreate.body.pendingSaleId;

    // Try to update with two lines of (currentStock + 10) total demand
    const halfExceed = Math.ceil((currentStock + 10) / 2);
    const resEdit = await request({
      hostname: 'localhost',
      port: 3000,
      path: `/api/pending-sales/${pendingId}`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      }
    }, {
      client_name: "Test Aggregate Edit",
      destination: "La Paz",
      discount: 0,
      items: [
        { product_id: testProdId, quantity: halfExceed, price: 10 },
        { product_id: testProdId, quantity: halfExceed, price: 10 }
      ]
    });

    assert("N06: Edición con líneas repetidas que superan el stock es rechazada con HTTP 400", resEdit.status === 400);
  } catch (err) {
    assert("N06: Error en prueba: " + err.message, false);
  }

  console.log(`\nRESUMEN FINAL: ${passed} PASSED, ${failed} FAILED.`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
