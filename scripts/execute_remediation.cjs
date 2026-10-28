const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const isExecuteMode = process.argv.includes('--execute');
console.log("=== INICIANDO EJECUCIÓN DE REMEDIACIÓN INCIDENTE #399 ===");
console.log(`Modo de ejecución: ${isExecuteMode ? 'EJECUCIÓN REAL (--execute)' : 'SIMULACIÓN SEGURA (--dry-run por defecto)'}`);

if (!isExecuteMode) {
  console.log("AVISO: Ejecutando en modo --dry-run. Ningún dato será modificado. Para ejecutar la remediación real, use: node scripts/execute_remediation.cjs --execute");
  process.exit(0);
}

// 1. Checkpoint WAL and create verified backup
const dbPath = path.resolve(process.cwd(), 'gtr_pos.db');
if (!fs.existsSync(dbPath)) {
  console.error("ERROR CRÍTICO: gtr_pos.db no existe.");
  process.exit(1);
}

const db = new Database(dbPath);

// Execute WAL checkpoint to consolidate WAL into main DB file
console.log("\n[1] Consolidando WAL checkpoint...");
const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)');
console.log("Resultado checkpoint:", checkpoint);

// Create backup directory if not exists
const backupDir = path.resolve(process.cwd(), 'backups');
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.resolve(backupDir, `incident_399_pre_clean_${timestamp}.db`);

console.log(`\n[2] Creando respaldo íntegro en: ${backupPath}`);
db.backup(backupPath)
  .then(() => {
    console.log("Respaldo completado exitosamente.");
    const backupDb = new Database(backupPath, { readonly: true });
    const bSale398 = backupDb.prepare('SELECT * FROM sales WHERE id = 398').get();
    const bItems398 = backupDb.prepare('SELECT * FROM sale_items WHERE sale_id = 398').all();
    backupDb.close();

    if (!bSale398 || bSale398.total !== 2150 || bItems398.length !== 2) {
      console.error("ERROR CRÍTICO: El respaldo no contiene la venta #398 íntegra. Abortando intervención.");
      process.exit(1);
    }
    console.log("Integridad del respaldo verificada: Venta #398 intacta con total 2150 BOB y 2 líneas (40 ítems).");

    // Proceed to Step 3: Atomic Transaction
    executeAtomicCleanup(db, backupPath);
  })
  .catch(err => {
    console.error("Error al crear el respaldo:", err);
    process.exit(1);
  });

function executeAtomicCleanup(db, backupPath) {
  console.log("\n[3] Ejecutando transacción atómica de remediación...");

  const testSaleIds = [
    399, 400, 401, 402, 403, 404, 405, 406, 407, 408,
    409, 410, 411, 412, 413, 414, 415, 416, 417, 418,
    419, 420, 421, 422, 423, 425, 426, 427, 428
  ];
  const placeholders = testSaleIds.map(() => '?').join(',');

  const cleanupTx = db.transaction(() => {
    // 1. INVARIANT ASSERTION
    const sale398 = db.prepare('SELECT * FROM sales WHERE id = 398').get();
    if (!sale398 || Number(sale398.total) !== 2150 || sale398.user_id !== 3) {
      throw new Error("Violación de invariante: Venta #398 no cumple con el estado esperado.");
    }
    const items398 = db.prepare('SELECT * FROM sale_items WHERE sale_id = 398').all();
    const sumQty398 = items398.reduce((s, it) => s + (it.quantity || 0), 0);
    if (sumQty398 !== 40) {
      throw new Error(`Violación de invariante: Venta #398 tiene ${sumQty398} ítems en vez de 40.`);
    }

    // Assert sale #424 (real offline sale) exists and is preserved
    const sale424 = db.prepare('SELECT * FROM sales WHERE id = 424').get();
    if (!sale424 || Number(sale424.total) !== 610 || sale424.user_id !== 3) {
      throw new Error("Violación de invariante: Venta #424 (legítima de @maria) no encontrada o corrupta.");
    }

    // 2. Create Quarantine Table
    db.prepare(`
      CREATE TABLE IF NOT EXISTS incident_quarantine_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id TEXT NOT NULL,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        backup_path TEXT NOT NULL,
        quarantined_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%S-04:00', 'now', '-4 hours'))
      )
    `).run();

    // Check if already applied
    const alreadyApplied = db.prepare("SELECT COUNT(*) as count FROM incident_quarantine_records WHERE incident_id = 'INCIDENT_399_20261027'").get();
    if (alreadyApplied.count > 0) {
      console.log("AVISO: La remediación del incidente INCIDENT_399_20261027 ya fue aplicada previamente. Idempotencia garantizada.");
      return;
    }

    // 3. Quarantine sales
    const salesToQuarantine = db.prepare(`SELECT * FROM sales WHERE id IN (${placeholders})`).all(...testSaleIds);
    const insertQ = db.prepare(`
      INSERT INTO incident_quarantine_records (incident_id, table_name, record_id, payload_json, reason, backup_path)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const s of salesToQuarantine) {
      insertQ.run('INCIDENT_399_20261027', 'sales', String(s.id), JSON.stringify(s), 'Venta de prueba generada por IA en incidente #399', backupPath);
    }
    console.log(`- Archivadas ${salesToQuarantine.length} ventas en cuarentena.`);

    // Quarantine sale items
    const itemsToQuarantine = db.prepare(`SELECT * FROM sale_items WHERE sale_id IN (${placeholders})`).all(...testSaleIds);
    for (const it of itemsToQuarantine) {
      insertQ.run('INCIDENT_399_20261027', 'sale_items', String(it.id), JSON.stringify(it), 'Línea de venta de prueba incidente #399', backupPath);
    }
    console.log(`- Archivadas ${itemsToQuarantine.length} líneas de venta en cuarentena.`);

    // Quarantine cash movements
    const cashToQuarantine = db.prepare(`SELECT * FROM cash_movements WHERE sale_id IN (${placeholders})`).all(...testSaleIds);
    for (const cm of cashToQuarantine) {
      insertQ.run('INCIDENT_399_20261027', 'cash_movements', String(cm.id), JSON.stringify(cm), 'Movimiento de caja prueba incidente #399', backupPath);
    }
    console.log(`- Archivados ${cashToQuarantine.length} movimientos de caja en cuarentena.`);

    // 4. RESTORE PRODUCT INVENTORY
    // Product 1: +1 unit (sold in test sale #417)
    const p1Before = db.prepare('SELECT stock FROM products WHERE id = 1').get()?.stock || 0;
    db.prepare("UPDATE products SET stock = stock + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%S-04:00', 'now', '-4 hours') WHERE id = 1").run();
    const p1After = db.prepare('SELECT stock FROM products WHERE id = 1').get()?.stock;
    console.log(`- Inventario Producto #1: antes = ${p1Before}, después = ${p1After} (restituida 1 unidad)`);

    // Product 5: +24 units (sold across test sales)
    const p5Before = db.prepare('SELECT stock FROM products WHERE id = 5').get()?.stock || 0;
    db.prepare("UPDATE products SET stock = stock + 24, updated_at = strftime('%Y-%m-%dT%H:%M:%S-04:00', 'now', '-4 hours') WHERE id = 5").run();
    const p5After = db.prepare('SELECT stock FROM products WHERE id = 5').get()?.stock;
    console.log(`- Inventario Producto #5: antes = ${p5Before}, después = ${p5After} (restituidas 24 unidades)`);

    // Record inventory audit logs for the restitution
    const insertInvLog = db.prepare(`
      INSERT INTO inventory_audit_logs (product_id, product_name, product_sku, type, quantity, price, user_id, username, reference, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%S-04:00', 'now', '-4 hours'))
    `);
    insertInvLog.run(1, 'MOUSE LOGITECH SUPER LIGTH 2', '1', 'ajuste', 1, 10, 4, 'admin', 'INCIDENT_399', 'Restitución administrativa por remediación incidente #399 (venta prueba #417)');
    insertInvLog.run(5, 'Hp goma/metal 16gb', '5', 'ajuste', 24, 58, 4, 'admin', 'INCIDENT_399', 'Restitución administrativa por remediación incidente #399 (24 unidades en ventas de prueba)');

    // 5. RESTORE CASH ACCOUNTS
    // Maria (seller_id: 3): -70 BOB (7 test sales of 10 BOB each; preserving 610 BOB from legitimate sale #424)
    const mBalBefore = db.prepare('SELECT current_balance FROM cash_accounts WHERE seller_id = 3').get()?.current_balance || 0;
    db.prepare("UPDATE cash_accounts SET current_balance = current_balance - 70, updated_at = strftime('%Y-%m-%dT%H:%M:%S-04:00', 'now', '-4 hours') WHERE seller_id = 3").run();
    const mBalAfter = db.prepare('SELECT current_balance FROM cash_accounts WHERE seller_id = 3').get()?.current_balance;
    console.log(`- Saldo Caja @maria: antes = ${mBalBefore} BOB, después = ${mBalAfter} BOB (conserva exactamente 610 BOB de venta legítima #424)`);

    // Admin (seller_id: 4): -232 BOB (4 test sales of 58 BOB each)
    const aBalBefore = db.prepare('SELECT current_balance FROM cash_accounts WHERE seller_id = 4').get()?.current_balance || 0;
    db.prepare("UPDATE cash_accounts SET current_balance = current_balance - 232, updated_at = strftime('%Y-%m-%dT%H:%M:%S-04:00', 'now', '-4 hours') WHERE seller_id = 4").run();
    const aBalAfter = db.prepare('SELECT current_balance FROM cash_accounts WHERE seller_id = 4').get()?.current_balance;
    console.log(`- Saldo Caja @admin: antes = ${aBalBefore} BOB, después = ${aBalAfter} BOB`);

    // Vendedor Test (seller_id: 7): -653 BOB
    const vBalBefore = db.prepare('SELECT current_balance FROM cash_accounts WHERE seller_id = 7').get()?.current_balance || 0;
    db.prepare("UPDATE cash_accounts SET current_balance = current_balance - 653, updated_at = strftime('%Y-%m-%dT%H:%M:%S-04:00', 'now', '-4 hours') WHERE seller_id = 7").run();
    const vBalAfter = db.prepare('SELECT current_balance FROM cash_accounts WHERE seller_id = 7').get()?.current_balance;
    console.log(`- Saldo Caja @vendedor_test: antes = ${vBalBefore} BOB, después = ${vBalAfter} BOB`);

    // 6. DELETE TEST CASH MOVEMENTS
    const delCash = db.prepare(`DELETE FROM cash_movements WHERE sale_id IN (${placeholders})`).run(...testSaleIds);
    console.log(`- Eliminados ${delCash.changes} movimientos de caja asociados a pruebas.`);

    // 7. DELETE TEST SALE ITEMS
    const delItems = db.prepare(`DELETE FROM sale_items WHERE sale_id IN (${placeholders})`).run(...testSaleIds);
    console.log(`- Eliminadas ${delItems.changes} líneas de ítems de ventas de prueba.`);

    // 8. DELETE TEST SALES
    const delSales = db.prepare(`DELETE FROM sales WHERE id IN (${placeholders})`).run(...testSaleIds);
    console.log(`- Eliminadas ${delSales.changes} ventas de prueba del historial.`);

    // 9. INSERT TOMBSTONES INTO deleted_records
    const insertDeleted = db.prepare(`
      INSERT OR IGNORE INTO deleted_records (table_name, record_id, deleted_at)
      VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%S-04:00', 'now', '-4 hours'))
    `);
    for (const sid of testSaleIds) {
      insertDeleted.run('sales', String(sid));
    }
    for (const it of itemsToQuarantine) {
      insertDeleted.run('sale_items', String(it.id));
    }
    for (const cm of cashToQuarantine) {
      insertDeleted.run('cash_movements', String(cm.id));
    }
    console.log(`- Registrados marcadores de eliminación en deleted_records.`);

    // 10. BLOCK TEST OPERATIONS IN processed_operations
    db.prepare(`
      UPDATE processed_operations 
      SET response_body = json_set(response_body, '$.status', 'blocked_incident_399')
      WHERE client_operation_id LIKE '%test_sale%' OR client_operation_id LIKE '%debug_sale%'
    `).run();
    console.log(`- Bloqueadas claves de operaciones de prueba en processed_operations.`);

    // 11. RECORD SYSTEM AUDIT LOG
    db.prepare(`
      INSERT INTO system_audit_logs (
        event_type, category, module, action, severity,
        entity_type, entity_id, user_id, user_name, user_role,
        reason, result, status, metadata, created_at
      ) VALUES (
        'ADMIN_INTERVENTION', 'AUDIT', 'SALES', 'INCIDENT_REMEDIATION', 'HIGH',
        'sales', '399-428', 4, 'admin', 'admin',
        'Remediación incidente #399: retiro de 29 ventas de prueba y preservación de #398 y #424',
        'SUCCESS', 'COMPLETED', ?, strftime('%Y-%m-%dT%H:%M:%S-04:00', 'now', '-4 hours')
      )
    `).run(JSON.stringify({
      incident_id: 'INCIDENT_399_20261027',
      deleted_sales_count: delSales.changes,
      deleted_sales_ids: testSaleIds,
      preserved_sale_398: { id: 398, total: 2150, user: 'maria', items: 40 },
      preserved_sale_424: { id: 424, total: 610, user: 'maria', items: 20 },
      stock_corrections: { product_1: '+1', product_5: '+24' },
      cash_corrections: { maria: '-70', admin: '-232', vendedor_test: '-653' },
      backup_file: backupPath
    }));
    console.log(`- Registrada entrada de auditoría formal en system_audit_logs.`);
  });

  try {
    cleanupTx();
    console.log("\n>>> TRANSACCIÓN ATÓMICA DE REMEDIACIÓN FINALIZADA CON ÉXITO <<<");
  } catch (err) {
    console.error("ERROR EN TRANSACCIÓN DE REMEDIACIÓN (ROLLBACK APLICADO):", err);
    process.exit(1);
  } finally {
    db.close();
  }
}
