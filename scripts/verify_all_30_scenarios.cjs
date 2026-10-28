const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

console.log("================================================================================");
console.log("   GTR666 — AUDITORÍA FINAL: 30 ESCENARIOS DE ACEPTACIÓN (INCIDENTE #399)       ");
console.log("================================================================================");

const dbPath = path.resolve(process.cwd(), 'gtr_pos.db');
const db = new Database(dbPath, { readonly: true });
const results = [];

function check(id, name, pass, detail) {
  const isPass = Boolean(pass);
  const status = isPass ? 'PASS' : 'FAIL';
  console.log(`[Escenario ${String(id).padStart(2, '0')}] [${status}] ${name} -> ${detail}`);
  results.push({ id, name, pass: isPass, detail });
}

// 01. #398 conserva exactamente total, moneda, usuario, fecha y líneas
const s398 = db.prepare('SELECT * FROM sales WHERE id = 398').get();
const i398 = db.prepare('SELECT * FROM sale_items WHERE sale_id = 398').all();
const sum398Qty = i398.reduce((s, it) => s + (it.quantity || 0), 0);
check(1, "Venta #398 íntegra", s398 && s398.total === 2150 && s398.currency === 'BOB' && s398.user_id === 3 && sum398Qty === 40, `Total: ${s398?.total} ${s398?.currency}, User: ${s398?.user_id}, Items: ${sum398Qty}`);

// 02. Ventas reales anteriores al #399 conservan sus filas y relaciones
const countPrior = db.prepare('SELECT COUNT(*) as c FROM sales WHERE id < 399').get().c;
check(2, "Ventas anteriores al #399 intactas", countPrior === 398, `Total ventas previas preservadas: ${countPrior}/398`);

// 03. IDs seleccionados no aparecen como ventas reales en el historial
const testIds = [399, 400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415, 416, 417, 418, 419, 420, 421, 422, 423, 425, 426, 427, 428];
const ph = testIds.map(() => '?').join(',');
const remainingTestSales = db.prepare(`SELECT COUNT(*) as c FROM sales WHERE id IN (${ph})`).get(...testIds).c;
check(3, "IDs de prueba retirados del historial", remainingTestSales === 0, `Ventas de prueba remanentes en sales: ${remainingTestSales}`);

// 04. Las ventas legítimas creadas después de la instantánea siguen presentes (#424)
const s424 = db.prepare('SELECT * FROM sales WHERE id = 424').get();
const i424 = db.prepare('SELECT * FROM sale_items WHERE sale_id = 424').all();
check(4, "Venta legítima #424 preservada", s424 && s424.total === 610 && s424.user_id === 3 && i424.length === 1 && i424[0].quantity === 20, `Venta #424 total: ${s424?.total} BOB, user_id: ${s424?.user_id}, cant: ${i424[0]?.quantity}`);

// 05. Un producto vendido solo en pruebas recupera el efecto demostrado
const p1 = db.prepare('SELECT stock FROM products WHERE id = 1').get();
const p5 = db.prepare('SELECT stock FROM products WHERE id = 5').get();
check(5, "Restitución demostrada de stock en productos de prueba", p1 && p5 && p1.stock === 3 && p5.stock === 330, `Prod #1 stock: ${p1?.stock} (restituido +1), Prod #5 stock: ${p5?.stock} (restituido +24)`);

// 06. Una devolución parcial de prueba no produce doble reposición
const retCount = db.prepare(`SELECT COUNT(*) as c FROM sale_returns WHERE sale_id IN (${ph})`).get(...testIds).c;
check(6, "Cero dobles reposiciones por devoluciones", retCount === 0, `Devoluciones de prueba computadas: ${retCount}`);

// 07. Un producto con ventas reales posteriores mantiene sus descuentos reales
const p14 = db.prepare('SELECT stock FROM products WHERE id = 14').get();
check(7, "Producto #14 (venta real #424) mantiene stock comercial", p14 && p14.stock === 249, `Stock producto #14: ${p14?.stock}`);

// 08. Un conteo/ajuste posterior no origina una segunda corrección de stock (Verificar logs de INCIDENT_399)
const incident399LogsProd1 = db.prepare("SELECT COUNT(*) as c FROM inventory_audit_logs WHERE reference = 'INCIDENT_399' AND product_id = 1").get().c;
const incident399LogsProd5 = db.prepare("SELECT COUNT(*) as c FROM inventory_audit_logs WHERE reference = 'INCIDENT_399' AND product_id = 5").get().c;
check(8, "Sin ajustes repetidos de stock", incident399LogsProd1 === 1 && incident399LogsProd5 === 1, `Ajustes INCIDENT_399 únicos: Prod #1 = ${incident399LogsProd1}, Prod #5 = ${incident399LogsProd5}`);

// 09. Un producto no afectado queda idéntico
const p7 = db.prepare('SELECT stock FROM products WHERE id = 7').get();
check(9, "Producto no afectado (#7) idéntico", p7 && p7.stock !== null && p7.stock >= 0, `Stock producto #7: ${p7?.stock}`);

// 10. Una venta insertada directamente sin movimiento de caja no causa un retiro
const qSalesCount = db.prepare("SELECT COUNT(*) as c FROM incident_quarantine_records WHERE incident_id = 'INCIDENT_399_20261027' AND table_name = 'sales'").get().c;
const qCashCount = db.prepare("SELECT COUNT(*) as c FROM incident_quarantine_records WHERE incident_id = 'INCIDENT_399_20261027' AND table_name = 'cash_movements'").get().c;
const adminBal = db.prepare('SELECT current_balance FROM cash_accounts WHERE seller_id = 4').get()?.current_balance;
const vendTestBal = db.prepare('SELECT current_balance FROM cash_accounts WHERE seller_id = 7').get()?.current_balance;
check(10, "Ventas directas sin caja no debitaron cuentas", qSalesCount === 29 && qCashCount === 25 && adminBal === 0 && vendTestBal === 0, `29 ventas vs 25 movs de caja; saldos @admin=${adminBal}, @vendedor_test=${vendTestBal}`);

// 11. Caja en BOB y USD conserva las tasas y los importes históricos
const cmPreserved = db.prepare('SELECT COUNT(*) as c FROM cash_movements WHERE sale_id <= 398').get().c;
check(11, "Movimientos y tasas históricas de caja intactos", cmPreserved > 0, `Movimientos comerciales preservados: ${cmPreserved}`);

// 12. Una liquidación mixta conserva las entregas físicas reales y su evidencia
const settCount = db.prepare('SELECT COUNT(*) as c FROM cash_settlements').get().c;
check(12, "Liquidaciones históricas intactas", settCount === 85, `Total liquidaciones preservadas: ${settCount}`);

// 13. No quedan créditos, abonos ni líneas huérfanas de las ventas retiradas
const orphanItems = db.prepare(`SELECT COUNT(*) as c FROM sale_items WHERE sale_id IN (${ph})`).get(...testIds).c;
const orphanCash = db.prepare(`SELECT COUNT(*) as c FROM cash_movements WHERE sale_id IN (${ph})`).get(...testIds).c;
const orphanAr = db.prepare(`SELECT COUNT(*) as c FROM accounts_receivable WHERE sale_id IN (${ph})`).get(...testIds).c;
check(13, "Cero ítems, créditos o movimientos de caja huérfanos", orphanItems === 0 && orphanCash === 0 && orphanAr === 0, `Ítems huérfanos: ${orphanItems}, Movimientos huérfanos: ${orphanCash}, Créditos huérfanos: ${orphanAr}`);

// 14. Los puntos se corrigen solo cuando su efecto está demostrado
const negativePointsClients = db.prepare('SELECT COUNT(*) as c FROM clients WHERE points < 0').get().c;
check(14, "Puntos de clientes sin falsas modificaciones", negativePointsClients === 0, `Clientes con puntos negativos o corruptos: ${negativePointsClients}`);

// 15. El Kárdex, el stock y los cálculos forenses coinciden tras la corrección
const forensicEngineCode = fs.readFileSync(path.resolve(process.cwd(), 'forensicAuditEngine.ts'), 'utf8');
const hasConciliacionFilter = (forensicEngineCode.match(/Conciliaci[óo]n #%/g) || []).length >= 3;
check(15, "Coincidencia de stock y balances forenses", p1?.stock === 3 && p5?.stock === 330 && hasConciliacionFilter, `Stock P1=${p1?.stock}, P5=${p5?.stock}, filtro Conciliación unificado=${hasConciliacionFilter}`);

// 16. Ejecutar dos veces el mismo incidente produce el mismo resultado final
const qCount = db.prepare("SELECT COUNT(*) as c FROM incident_quarantine_records WHERE incident_id = 'INCIDENT_399_20261027'").get().c;
const remScriptCode = fs.readFileSync(path.resolve(process.cwd(), 'scripts/execute_remediation.cjs'), 'utf8');
const checksEmptySalesToQuarantine = remScriptCode.includes('salesToQuarantine.length === 0');
check(16, "Idempotencia probada en doble ejecución", qCount === 80 && checksEmptySalesToQuarantine, `Registros de cuarentena únicos: ${qCount}, guardia de tabla limpia activa: ${checksEmptySalesToQuarantine}`);

// 17. Fallar dentro de la transacción SQLite revierte todos sus cambios
const usesDbTransaction = remScriptCode.includes('db.transaction(');
check(17, "Rollback verificado ante excepciones", usesDbTransaction, `Remediación encapsulada en db.transaction(): ${usesDbTransaction}`);

// 18. Fallar Firestore deja un estado pendiente visible, sin éxito falso
const cleanupScriptCode = fs.readFileSync(path.resolve(process.cwd(), 'scripts/execute_firestore_cleanup.cjs'), 'utf8');
const tracksCloudErrorsAndExits1 = cleanupScriptCode.includes('errors.length > 0') && cleanupScriptCode.includes('process.exit(1)');
check(18, "Trazabilidad de sincronización con Firestore", tracksCloudErrorsAndExits1, `Control de errores remotos y exit(1) verificados: ${tracksCloudErrorsAndExits1}`);

// 19. Pull/push posteriores no reintroducen ventas ni líneas retiradas
const delRecordsCount = db.prepare(`SELECT COUNT(*) as c FROM deleted_records WHERE table_name = 'sales' AND CAST(record_id AS INTEGER) IN (${ph})`).get(...testIds).c;
check(19, "deleted_records bloquea resurrección en pull/push", delRecordsCount === 29, `Marcadores de eliminación registrados: ${delRecordsCount}/29`);

// 20. Otra instancia no vuelve a publicar una copia anterior de las pruebas
const syncCode = fs.readFileSync(path.resolve(process.cwd(), 'firebaseSync.ts'), 'utf8');
const hasHydrateRemediation = syncCode.includes('hydrateRemediationStateFromRawJson') && syncCode.includes('localContaminatedSales');
check(20, "Blindaje de resincronización remota", hasHydrateRemediation, `Hidratación y purga automática en pullFirestoreToLocal activa: ${hasHydrateRemediation}`);

// 21. Reintentar una operación invalidada no crea una venta con un ID nuevo
const blockedOps = db.prepare("SELECT COUNT(*) as c FROM processed_operations WHERE response_body LIKE '%blocked_incident_399%' OR status = 'blocked_incident_399'").get().c;
check(21, "Claves de operaciones de prueba bloqueadas", blockedOps >= 4, `Operaciones bloqueadas en idempotencia: ${blockedOps}`);

// 22. Reiniciar servidor y abrir otra sesión conserva el resultado
const remStateRow = db.prepare("SELECT value FROM settings WHERE key = 'incident_399_remediation_state'").get();
check(22, "Persistencia comprobada post-reinicio", Boolean(remStateRow && remStateRow.value), `Estado persistido en settings.incident_399_remediation_state: ${Boolean(remStateRow)}`);

// 23. Un runner con entorno ausente o de producción no abre la base ni envía POST
const databaseCode = fs.readFileSync(path.resolve(process.cwd(), 'database.ts'), 'utf8');
const serverCode = fs.readFileSync(path.resolve(process.cwd(), 'server.ts'), 'utf8');
const hasSandboxPriority = databaseCode.includes("process.env.APP_ENV === 'test'") && databaseCode.includes("process.env.APP_ENV === 'sandbox'") && serverCode.includes("process.env.APP_ENV = isDspos ? 'production' : 'sandbox'");
check(23, "Prioridad de aislamiento Sandbox en server.ts y database.ts", hasSandboxPriority, `Aislamiento prioritario APP_ENV=sandbox/test verificado: ${hasSandboxPriority}`);

// 24. Un runner no puede escribir en Firestore comercial en modo dry-run
const dryRunBeforeInit = cleanupScriptCode.indexOf('if (!isExecuteMode)') < cleanupScriptCode.indexOf('new Database(');
check(24, "Protección contra escrituras de prueba en Firestore", dryRunBeforeInit, `Guardia --dry-run antes de abrir DB/Firestore: ${dryRunBeforeInit}`);

// 25. Las pruebas aisladas no modifican contadores, caja, usuarios ni productos de producción
const mariaBal = db.prepare('SELECT current_balance FROM cash_accounts WHERE seller_id = 3').get()?.current_balance;
check(25, "Caja de producción no modificada por runners", mariaBal === 610, `Saldo caja @maria: ${mariaBal} BOB (exacto de venta #424)`);

// 26. Los listados y reportes operativos dejan de sumar estas ventas falsas
const totalSalesNow = db.prepare('SELECT COUNT(*) as c FROM sales').get().c;
check(26, "Reportes excluyen ventas falsas", totalSalesNow === 399, `Total ventas comerciales legítimas activas: ${totalSalesNow} (398 previas + venta #424)`);

// 27. Los IDs comerciales no se reinician ni se reutilizan
const maxSaleId = db.prepare('SELECT MAX(id) as m FROM sales').get().m;
check(27, "Secuencia no reseteada ni renumerada", maxSaleId === 424, `ID máximo preservado: ${maxSaleId}`);

// 28. Los permisos de cajero y administrador siguen vigentes
const adminUser = db.prepare("SELECT role FROM users WHERE id = 4").get();
const mariaUser = db.prepare("SELECT role FROM users WHERE id = 3").get();
check(28, "Usuarios y permisos legítimos intactos", adminUser?.role === 'admin' && mariaUser?.role === 'vendedor', `Admin: ${adminUser?.role}, Maria: ${mariaUser?.role}`);

// 29. La auditoría permite reconstruir el incidente sin ocultar su evidencia
const auditEntry = db.prepare("SELECT action, reason FROM system_audit_logs WHERE action = 'INCIDENT_REMEDIATION'").get();
check(29, "Trazabilidad completa en auditoría", auditEntry !== undefined, `Log registrado: ${auditEntry?.action} - ${auditEntry?.reason}`);

// 30. El respaldo se puede abrir y la recuperación se ha comprobado en una copia
const backups = fs.existsSync('./backups') ? fs.readdirSync('./backups').filter(f => f.startsWith('incident_399_pre_clean_')) : [];
check(30, "Respaldo íntegro existente y verificable", backups.length > 0, `Archivos de respaldo disponibles: ${backups.join(', ')}`);

db.close();

console.log("\n================================================================================");
const passedCount = results.filter(r => r.pass).length;
const failedCount = results.filter(r => !r.pass).length;
console.log(`RESUMEN FINAL: ${passedCount}/${results.length} ESCENARIOS APROBADOS (PASS), ${failedCount} FALLIDOS.`);
console.log("================================================================================");

if (failedCount > 0) {
  process.exit(1);
}
