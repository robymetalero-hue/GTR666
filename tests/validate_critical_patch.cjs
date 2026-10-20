/**
 * GTR POS - Suite de Validación Integral de Seguridad Crítica y Cero Regresiones
 */
const http = require('http');

function makeRequest(method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, body: json || data });
      });
    });

    req.on('error', (err) => reject(err));
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

let passed = 0;
let failed = 0;

function assert(condition, testName, details = '') {
  if (condition) {
    console.log(`[PASS] ${testName}`);
    passed++;
  } else {
    console.error(`[FAIL] ${testName} - ${details}`);
    failed++;
  }
}

async function runValidation() {
  console.log("==================================================");
  console.log("  GTR POS - VALIDACIÓN DE PARCHE DE SEGURIDAD    ");
  console.log("==================================================\n");

  // 1. Obtener tokens de autenticación para admin y vendedor
  let adminToken = '';
  let sellerToken = '';
  let sellerId = 2;

  try {
    const adminLogin = await makeRequest('POST', '/api/auth/login', {}, { username: 'admin', password: '123' });
    if (adminLogin.status === 200 && adminLogin.body && adminLogin.body.token) {
      adminToken = adminLogin.body.token;
    }
  } catch (err) {
    console.warn("Could not login as admin:", err.message);
  }

  // 1. EXPOSICIÓN DE COSTOS
  console.log("--- 1. Exposición de Precios de Costo ---");
  // 1.1 Anónimo / sin token no debe recibir price_cost
  const anonProds = await makeRequest('GET', '/api/products');
  const prodsList = Array.isArray(anonProds.body) ? anonProds.body : (anonProds.body?.products || []);
  const anonHasCost = prodsList.some(p => p.price_cost !== null && p.price_cost !== undefined);
  assert(!anonHasCost, "GET /api/products anónimo oculta estrictamente price_cost (null)");

  // 1.2 Admin con token sí recibe price_cost
  if (adminToken) {
    const adminProds = await makeRequest('GET', '/api/products', { 'Authorization': `Bearer ${adminToken}` });
    const adminProdsList = Array.isArray(adminProds.body) ? adminProds.body : (adminProds.body?.products || []);
    const adminHasCost = adminProdsList.length > 0 && adminProdsList.some(p => p.price_cost !== null && p.price_cost !== undefined);
    assert(adminHasCost, "GET /api/products con token de Admin sí incluye price_cost");
  }

  // 1.3 Exportación administrativa /api/diagnose/clean-tables-export protegida
  const anonExport = await makeRequest('GET', '/api/diagnose/clean-tables-export');
  assert(anonExport.status === 401 || anonExport.status === 403, "GET /api/diagnose/clean-tables-export rechaza acceso no autorizado (401/403)");

  if (adminToken) {
    const adminExport = await makeRequest('GET', '/api/diagnose/clean-tables-export', { 'Authorization': `Bearer ${adminToken}` });
    const exportedSettings = adminExport.body?.settings || [];
    const leaksSecret = exportedSettings.some(s => s.key && s.key.includes('jwt_secret'));
    assert(adminExport.status === 200 && !leaksSecret, "Exportación de Admin no filtra jwt_secret en tabla settings");
  }

  // 2. ELEVACIÓN DE PRIVILEGIOS
  console.log("\n--- 2. Elevación de Privilegios ---");
  // 2.1 Intento de modificar usuario sin autenticación
  const unauthPut = await makeRequest('PUT', '/api/users/2', {}, { role: 'admin' });
  assert(unauthPut.status === 401 || unauthPut.status === 403, "PUT /api/users/:id rechaza modificación sin autenticación (401/403)");

  // 3. OPERACIONES DESTRUCTIVAS
  console.log("\n--- 3. Acceso a Operaciones Destructivas ---");
  const resetDbUnauth = await makeRequest('POST', '/api/admin/reset-database');
  assert(resetDbUnauth.status === 401 || resetDbUnauth.status === 403, "POST /api/admin/reset-database rechaza acceso no autorizado (401/403)");

  const resetShiftUnauth = await makeRequest('POST', '/api/shifts/reset');
  assert(resetShiftUnauth.status === 401 || resetShiftUnauth.status === 403, "POST /api/shifts/reset rechaza acceso no autorizado (401/403)");

  const exchangeRateFakeUser = await makeRequest('POST', '/api/settings/exchange-rate', {}, { rate: 10.5, user: { role: 'admin' } });
  assert(exchangeRateFakeUser.status === 401 || exchangeRateFakeUser.status === 403, "POST /api/settings/exchange-rate no acepta req.body.user falso (401/403)");

  const approveCountUnauth = await makeRequest('POST', '/api/inventory-counts/1/approve');
  assert(approveCountUnauth.status === 401 || approveCountUnauth.status === 403, "POST /api/inventory-counts/:id/approve rechaza sin admin (401/403)");

  const adjustCashUnauth = await makeRequest('POST', '/api/cash-accounts/1/adjust', {}, { amount: 100, type: 'ingreso_manual' });
  assert(adjustCashUnauth.status === 401 || adjustCashUnauth.status === 403, "POST /api/cash-accounts/:sellerId/adjust rechaza sin permisos (401/403)");

  // 4. MANIPULACIÓN DE PRECIOS
  console.log("\n--- 4. Manipulación de Ventas e Inventario ---");
  // Intento de venta con precio alterado no autorizado
  if (prodsList.length > 0) {
    const testProd = prodsList[0];
    const tamperedSale = await makeRequest('POST', '/api/sales', {}, {
      total: 0.01,
      discount: 0,
      payment_method: 'Efectivo',
      user_id: 2,
      currency: 'BOB',
      items: [
        { product_id: testProd.id, quantity: 1, price: 0.01 }
      ]
    });
    // Debe ser rechazado con 401 (sin sesión) o 403 (precio manipulado)
    assert(tamperedSale.status === 401 || tamperedSale.status === 403, "POST /api/sales rechaza precio unitario alterado (401/403)");
  }

  // 5. SECRETOS EN ARCHIVOS
  console.log("\n--- 5. Secretos y JWT ---");
  const fs = require('fs');
  const authSecCode = fs.readFileSync('authSecurity.ts', 'utf-8');
  const hasFixedSecret = authSecCode.includes('gtr_pos_secure_production_secret_key_fixed_998877');
  assert(!hasFixedSecret, "authSecurity.ts no contiene la clave fija de respaldo vulnerable");

  console.log("\n==================================================");
  console.log(`TOTAL PRUEBAS: ${passed + failed} | APROBADAS: ${passed} | FALLIDAS: ${failed}`);
  console.log("==================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runValidation().catch(e => {
  console.error("Test execution failed:", e);
  process.exit(1);
});
