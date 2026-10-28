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

    // 3. Inspect actual contaminated records present in DB (W09: never apply blind deltas if records are absent)
    const salesToQuarantine = db.prepare(`SELECT * FROM sales WHERE id IN (${placeholders})`).all(...testSaleIds);
    const itemsToQuarantine = db.prepare(`SELECT * FROM sale_items WHERE sale_id IN (${placeholders})`).all(...testSaleIds);
    const cashToQuarantine = db.prepare(`SELECT * FROM cash_movements WHERE sale_id IN (${placeholders})`).all(...testSaleIds);

    if (salesToQuarantine.length === 0 && itemsToQuarantine.length === 0 && cashToQuarantine.length === 0) {
      console.log("AVISO: No existen ventas ni movimientos de prueba (399-428) pendientes de retiro en la base de datos. Idempotencia garantizada: no se aplican ajustes adicionales de stock ni de caja.");
      return;
    }

    const insertQ = db.prepare(`
      INSERT INTO incident_quarantine_records (incident_id, table_name, record_id, payload_json, reason, backup_path)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const s of salesToQuarantine) {
      const exists = db.prepare("SELECT 1 FROM incident_quarantine_records WHERE table_name = 'sales' AND record_id = ?").get(String(s.id));
      if (!exists) {
        insertQ.run('INCIDENT_399_20261027', 'sales', String(s.id), JSON.stringify(s), 'Venta de prueba generada por IA en incidente #399', backupPath);
      }
    }
    console.log(`- Archivadas ${salesToQuarantine.length} ventas en cuarentena.`);

    for (const it of itemsToQuarantine) {
      const exists = db.prepare("SELECT 1 FROM incident_quarantine_records WHERE table_name = 'sale_items' AND record_id = ?").get(String(it.id));
      if (!exists) {
        insertQ.run('INCIDENT_399_20261027', 'sale_items', String(it.id), JSON.stringify(it), 'Línea de venta de prueba incidente #399', backupPath);
      }
    }
    console.log(`- Archivadas ${itemsToQuarantine.length} líneas de venta en cuarentena.`);

    for (const cm of cashToQuarantine) {
      const exists = db.prepare("SELECT 1 FROM incident_quarantine_records WHERE table_name = 'cash_movements' AND record_id = ?").get(String(cm.id));
      if (!exists) {
        insertQ.run('INCIDENT_399_20261027', 'cash_movements', String(cm.id), JSON.stringify(cm), 'Movimiento de caja prueba incidente #399', backupPath);
      }
    }
    console.log(`- Archivados ${cashToQuarantine.length} movimientos de caja en cuarentena.`);

    // 4. W09: Dynamically compute exact stock restoration from itemsToQuarantine (minus any prior returns)
    const stockAdjustments = new Map();
    const itemPriceByProd = new Map();
    for (const it of itemsToQuarantine) {
      const pId = Number(it.product_id);
      if (!pId) continue;
      let returnedQty = 0;
      try {
        const retRow = db.prepare('SELECT COALESCE(SUM(quantity), 0) as rq FROM sale_returns WHERE sale_item_id = ?').get(it.id);
        returnedQty = Number(retRow?.rq || 0);
      } catch (_) {}
      const netQtyToRestore = Math.max(0, (Number(it.quantity) || 0) - returnedQty);
      if (netQtyToRestore > 0) {
        stockAdjustments.set(pId, (stockAdjustments.get(pId) || 0) + netQtyToRestore);
        itemPriceByProd.set(pId, Number(it.price || 0));
      }
    }

    const insertInvLog = db.prepare(`
      INSERT INTO inventory_audit_logs (product_id, product_name, product_sku, type, quantity, price, user_id, username, reference, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%S-04:00', 'now', '-4 hours'))
    `);

    const stockCorrectionsSummary = {};
    for (const [pId, deltaQty] of stockAdjustments.entries()) {
      const prodRow = db.prepare('SELECT id, name, sku, stock FROM products WHERE id = ?').get(pId);
      if (!prodRow) continue;
      const beforeStock = Number(prodRow.stock || 0);
      db.prepare("UPDATE products SET stock = stock + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%S-04:00', 'now', '-4 hours') WHERE id = ?").run(deltaQty, pId);
      const afterStock = db.prepare('SELECT stock FROM products WHERE id = ?').get(pId)?.stock;
      console.log(`- Inventario Producto #${pId}: antes = ${beforeStock}, después = ${afterStock} (restituidas ${deltaQty} unidades)`);
      insertInvLog.run(
        pId,
        prodRow.name || `Producto #${pId}`,
        prodRow.sku || String(pId),
        'ajuste',
        deltaQty,
        itemPriceByProd.get(pId) || 0,
        4,
        'admin',
        'INCIDENT_399',
        `Restitución administrativa por remediación incidente #399 (${deltaQty} u. en ventas de prueba)`
      );
      stockCorrectionsSummary[`product_${pId}`] = `+${deltaQty}`;
    }

    // 5. W09: Dynamically compute exact cash account deductions from cashToQuarantine
    const saleRateById = new Map();
    for (const s of salesToQuarantine) {
      saleRateById.set(Number(s.id), Number(s.exchange_rate || 6.96));
    }
    const cashDeductionsBySeller = new Map();
    for (const cm of cashToQuarantine) {
      const sellerId = Number(cm.seller_id);
      if (!sellerId) continue;
      const rawAmt = Number(cm.amount || 0);
      const rate = saleRateById.get(Number(cm.sale_id)) || 6.96;
      const amtInBs = cm.currency === 'USD' ? Math.round(rawAmt * rate * 100) / 100 : rawAmt;
      cashDeductionsBySeller.set(sellerId, Math.round(((cashDeductionsBySeller.get(sellerId) || 0) + amtInBs) * 100) / 100);
    }

    const cashCorrectionsSummary = {};
    for (const [sellerId, deductBs] of cashDeductionsBySeller.entries()) {
      if (deductBs === 0) continue;
      const accBefore = db.prepare('SELECT seller_username, current_balance FROM cash_accounts WHERE seller_id = ?').get(sellerId);
      const balBefore = Number(accBefore?.current_balance || 0);
      db.prepare("UPDATE cash_accounts SET current_balance = MAX(0, ROUND(current_balance - ?, 2)), updated_at = strftime('%Y-%m-%dT%H:%M:%S-04:00', 'now', '-4 hours') WHERE seller_id = ?").run(deductBs, sellerId);
      const accAfter = db.prepare('SELECT seller_username, current_balance FROM cash_accounts WHERE seller_id = ?').get(sellerId);
      const sLabel = accBefore?.seller_username || `seller_${sellerId}`;
      console.log(`- Saldo Caja @${sLabel}: antes = ${balBefore} BOB, después = ${accAfter?.current_balance} BOB (ajuste -${deductBs} BOB)`);
      cashCorrectionsSummary[sLabel] = `-${deductBs}`;
    }

    // 6. DELETE TEST CASH MOVEMENTS, RETURNS, CREDITS, ITEMS, AND SALES
    const delCash = db.prepare(`DELETE FROM cash_movements WHERE sale_id IN (${placeholders})`).run(...testSaleIds);
    console.log(`- Eliminados ${delCash.changes} movimientos de caja asociados a pruebas.`);

    try {
      db.prepare(`DELETE FROM sale_returns WHERE sale_id IN (${placeholders})`).run(...testSaleIds);
      db.prepare(`DELETE FROM credit_payments WHERE account_receivable_id IN (SELECT id FROM accounts_receivable WHERE sale_id IN (${placeholders}))`).run(...testSaleIds);
      db.prepare(`DELETE FROM accounts_receivable WHERE sale_id IN (${placeholders})`).run(...testSaleIds);
    } catch (_) {}

    const delItems = db.prepare(`DELETE FROM sale_items WHERE sale_id IN (${placeholders})`).run(...testSaleIds);
    console.log(`- Eliminadas ${delItems.changes} líneas de ítems de ventas de prueba.`);

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
      SET status = 'blocked_incident_399',
          response_body = json_set(COALESCE(response_body, '{}'), '$.status', 'blocked_incident_399')
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
        'Remediación incidente #399: retiro de ventas de prueba y preservación de #398 y #424',
        'SUCCESS', 'COMPLETED', ?, strftime('%Y-%m-%dT%H:%M:%S-04:00', 'now', '-4 hours')
      )
    `).run(JSON.stringify({
      incident_id: 'INCIDENT_399_20261027',
      deleted_sales_count: delSales.changes,
      deleted_sales_ids: salesToQuarantine.map(s => s.id),
      preserved_sale_398: { id: 398, total: 2150, user: 'maria', items: 40 },
      preserved_sale_424: { id: 424, total: 610, user: 'maria', items: 20 },
      stock_corrections: stockCorrectionsSummary,
      cash_corrections: cashCorrectionsSummary,
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
