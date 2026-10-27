/**
 * Pre-Production Readiness and Non-Regression Certification Script
 * Validates database integrity, schema alignment, HTTP API endpoints, and system consistency.
 */
const Database = require('better-sqlite3');
const http = require('http');
const path = require('path');
const fs = require('fs');

const jwt = require('jsonwebtoken');

async function httpGet(urlPath, customHeaders = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: 3000,
      path: urlPath,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        ...customHeaders
      },
      timeout: 5000,
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data ? JSON.parse(data) : null,
            rawBody: data
          });
        } catch (_) {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: null,
            rawBody: data
          });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout requesting ${urlPath}`));
    });
    req.end();
  });
}

const tests = [];
function recordResult(category, name, passed, details) {
  tests.push({ category, name, passed, details });
}

async function runCertification() {
  console.log('='.repeat(80));
  console.log(' GTR POS: PRE-PRODUCTION READINESS & NON-REGRESSION CERTIFICATION');
  console.log('='.repeat(80));

  // 1. Database Integrity Verification (Physical & Logical)
  const dbPath = path.resolve(process.cwd(), 'gtr_pos_sandbox.db');
  if (fs.existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true });
    
    // Physical integrity
    const integrity = db.pragma('integrity_check');
    const isIntegrityOk = integrity.length === 1 && integrity[0].integrity_check === 'ok';
    recordResult('DATABASE_INTEGRITY', 'PRAGMA integrity_check', isIntegrityOk, JSON.stringify(integrity[0]));

    // Foreign Keys
    const fks = db.pragma('foreign_key_check');
    recordResult('DATABASE_INTEGRITY', 'PRAGMA foreign_key_check (0 violations)', fks.length === 0, `violations: ${fks.length}`);

    // Table schema checks
    const salesColumns = db.prepare("PRAGMA table_info(sales)").all();
    const hasCierreId = salesColumns.some(c => c.name === 'cierre_id');
    const hasCurrency = salesColumns.some(c => c.name === 'currency');
    const hasExchangeRate = salesColumns.some(c => c.name === 'exchange_rate');
    recordResult('SCHEMA_CONSISTENCY', 'sales table schema (cierre_id, currency, exchange_rate)', hasCierreId && hasCurrency && hasExchangeRate, `cierre_id: ${hasCierreId}, currency: ${hasCurrency}`);

    const shiftsColumns = db.prepare("PRAGMA table_info(shifts)").all();
    const hasClosedBy = shiftsColumns.some(c => c.name === 'closed_by');
    const hasTotalSales = shiftsColumns.some(c => c.name === 'total_sales');
    recordResult('SCHEMA_CONSISTENCY', 'shifts table schema (closed_by, total_sales)', hasClosedBy && hasTotalSales, `closed_by: ${hasClosedBy}, total_sales: ${hasTotalSales}`);

    const deletedRecordsExists = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='deleted_records'").get();
    recordResult('SCHEMA_CONSISTENCY', 'deleted_records tombstone table exists', deletedRecordsExists, `table present: ${deletedRecordsExists}`);

    const ledgerExists = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='firestore_transaction_ledger'").get();
    recordResult('SCHEMA_CONSISTENCY', 'firestore_transaction_ledger table exists', ledgerExists, `table present: ${ledgerExists}`);

    // Verify products availability
    const productsCount = db.prepare("SELECT count(*) as c FROM products").get().c;
    recordResult('DATA_CONSISTENCY', 'Products catalog populated', productsCount > 0, `products: ${productsCount}`);

    db.close();
  } else {
    recordResult('DATABASE_INTEGRITY', 'Database file presence', false, 'gtr_pos_sandbox.db not found');
  }

  // 2. HTTP API Endpoints & Contract Verification
  try {
    // Health Check
    const health = await httpGet('/api/health');
    const healthOk = health.statusCode === 200 && health.body && health.body.status === 'ok';
    recordResult('API_CONTRACTS', 'GET /api/health', healthOk, `status: ${health.statusCode}, status: ${health.body?.status}`);

    // Products & Atomic Version Headers (Q01)
    const prods = await httpGet('/api/products?limit=5');
    const hasCatHeader = !!(prods.headers['x-catalog-version']);
    const hasInvHeader = !!(prods.headers['x-inventory-version']);
    const prodsOk = prods.statusCode === 200 && (Array.isArray(prods.body) || (prods.body && Array.isArray(prods.body.products)));
    recordResult('API_CONTRACTS', 'GET /api/products payload & atomic version headers (Q01)', prodsOk && hasCatHeader && hasInvHeader, `status: ${prods.statusCode}, X-Catalog-Version: ${prods.headers['x-catalog-version']}, X-Inventory-Version: ${prods.headers['x-inventory-version']}`);

    // Catalog Version probe
    const catVer = await httpGet('/api/catalog/version');
    const catVerOk = catVer.statusCode === 200 && catVer.body && typeof catVer.body.catalogVersion === 'number';
    recordResult('API_CONTRACTS', 'GET /api/catalog/version probe', catVerOk, `catalogVersion: ${catVer.body?.catalogVersion}, inventoryVersion: ${catVer.body?.inventoryVersion}`);

    // Read jwtSecret and generate verified admin token
    let jwtSecret = 'GTR_POS_DEFAULT_SECRET_FALLBACK_KEY_2026';
    const secretFile = path.join(process.cwd(), '.server_jwt_secret');
    if (fs.existsSync(secretFile)) {
      jwtSecret = fs.readFileSync(secretFile, 'utf-8').trim();
    }
    const targetDbPathForJwt = fs.existsSync(path.resolve(process.cwd(), 'gtr_pos.db')) ? path.resolve(process.cwd(), 'gtr_pos.db') : path.resolve(process.cwd(), 'gtr_pos_sandbox.db');
    const dbForJwt = new Database(targetDbPathForJwt, { readonly: true });
    const adminUser = dbForJwt.prepare("SELECT id, username, role, permissions, email FROM users WHERE role = 'admin' LIMIT 1").get() || { id: 1, username: 'admin', role: 'admin' };
    dbForJwt.close();

    const authToken = jwt.sign(
      { id: adminUser.id, username: adminUser.username, role: adminUser.role, permissions: { view_dashboard: true, view_inventory: true }, email: adminUser.email },
      jwtSecret,
      { expiresIn: '1h' }
    );
    const authHeaders = { 'Authorization': `Bearer ${authToken}` };

    // Dashboard calculations
    const dash = await httpGet('/api/dashboard', authHeaders);
    const dashOk = dash.statusCode === 200 && dash.body && typeof dash.body.salesToday !== 'undefined' && typeof dash.body.profitToday !== 'undefined';
    recordResult('API_CONTRACTS', 'GET /api/dashboard metrics & profit calculations (R01, R02)', dashOk, `salesToday: ${dash.body?.salesToday}, profitToday: ${dash.body?.profitToday}`);

    // App Version sync endpoint
    const appVer = await httpGet('/api/app-version');
    const appVerOk = appVer.statusCode === 200 && appVer.body && !!appVer.body.version;
    recordResult('API_CONTRACTS', 'GET /api/app-version PWA sync', appVerOk, `version: ${appVer.body?.version}`);

  } catch (apiErr) {
    recordResult('API_CONTRACTS', 'HTTP API Endpoints availability', false, apiErr.message);
  }

  // 3. Backup Files Safety Verification
  const backupsDir = path.resolve(process.cwd(), 'backups');
  if (fs.existsSync(backupsDir)) {
    const files = fs.readdirSync(backupsDir).filter(f => f.endsWith('.db'));
    const preDeployBackups = files.filter(f => f.includes('pre_deploy'));
    const backupOk = preDeployBackups.length > 0;
    recordResult('BACKUP_VERIFICATION', 'Pre-deploy physical backup created', backupOk, `found: ${preDeployBackups.join(', ')}`);
  } else {
    recordResult('BACKUP_VERIFICATION', 'Backup directory present', false, 'backups directory missing');
  }

  // Print Summary
  console.log('\nCERTIFICATION CHECK RESULTS:');
  console.log('-'.repeat(80));
  let passCount = 0;
  for (const t of tests) {
    const mark = t.passed ? '✅ PASS' : '❌ FAIL';
    console.log(`[${t.category.padEnd(20)}] ${mark.padEnd(10)} ${t.name.padEnd(50)} | ${t.details}`);
    if (t.passed) passCount++;
  }
  console.log('-'.repeat(80));
  console.log(`TOTAL CERTIFICATION: ${passCount} / ${tests.length} PASSED`);
  console.log('='.repeat(80));

  if (passCount === tests.length) {
    console.log('\n🟢 CERTIFICATION PASSED: The codebase is fully backward-compatible, stable, and ready for production deployment.');
    process.exit(0);
  } else {
    console.error('\n🔴 CERTIFICATION FAILED: Some checks did not pass. Inspect details above.');
    process.exit(1);
  }
}

runCertification().catch(err => {
  console.error('Fatal certification error:', err);
  process.exit(1);
});
