const fs = require('fs');
const path = require('path');

const isExecuteMode = process.argv.includes('--execute');

const testSaleIds = [
  399, 400, 401, 402, 403, 404, 405, 406, 407, 408,
  409, 410, 411, 412, 413, 414, 415, 416, 417, 418,
  419, 420, 421, 422, 423, 425, 426, 427, 428
];
const testSaleIdSet = new Set(testSaleIds);

// Y11: Verify --execute BEFORE opening SQLite or initializing Firebase
if (!isExecuteMode) {
  console.log("=== PURGA Y CONCILIACIÓN EN FIRESTORE REMOTO (MODO DRY-RUN) ===");
  console.log("Modo de ejecución: SIMULACIÓN SEGURA (--dry-run por defecto)");
  console.log("AVISO: Ejecutando en modo --dry-run sin abrir base de datos local ni conexiones remotas.");
  console.log("Para aplicar cambios reales en Firestore, pase el flag explícito: node scripts/execute_firestore_cleanup.cjs --execute");
  process.exit(0);
}

const configPath = path.resolve(__dirname, '../firebase-applet-config.json');
if (!fs.existsSync(configPath)) {
  console.error("ERROR: firebase-applet-config.json no existe. No se puede ejecutar la purga remota.");
  process.exit(1);
}

const { initializeApp, getApps, getApp } = require('firebase/app');
const { getFirestore, collection, getDocs, doc, getDoc, deleteDoc, updateDoc, setDoc } = require('firebase/firestore');
const { getAuth, signInWithEmailAndPassword } = require('firebase/auth');
const Database = require('better-sqlite3');

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const app = getApps().length ? getApp() : initializeApp(config);
const db = getFirestore(app, config.firestoreDatabaseId);
const sqliteDb = new Database(path.resolve(__dirname, '../gtr_pos.db'));

async function runFirestoreCleanup() {
  console.log("=== INICIANDO PURGA Y CONCILIACIÓN EN FIRESTORE REMOTO ===");
  console.log(`Target Firestore DB: ${config.firestoreDatabaseId}`);
  console.log("Modo de ejecución: EJECUCIÓN REAL (--execute)");

  const errors = [];
  const recordError = (step, err) => {
    const msg = err && err.message ? err.message : String(err);
    console.error(`[ERROR FIRESTORE - ${step}]: ${msg}`);
    errors.push({ step, error: msg, timestamp: new Date().toISOString() });
  };

  const syncEmail = process.env.FIREBASE_SYNC_EMAIL;
  const syncPassword = process.env.FIREBASE_SYNC_PASSWORD;
  if (syncEmail && syncPassword) {
    try {
      const auth = getAuth(app);
      await signInWithEmailAndPassword(auth, syncEmail, syncPassword);
    } catch (authErr) {
      recordError('auth', authErr);
    }
  }

  // 1. Purge test sales
  let deletedSalesCount = 0;
  for (const id of testSaleIds) {
    try {
      const docRef = doc(db, 'sales', String(id));
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        await deleteDoc(docRef);
        deletedSalesCount++;
      }
    } catch (err) {
      recordError(`delete_sale_${id}`, err);
    }
  }
  console.log(`- Documentos sales eliminados de Firestore en esta ejecución: ${deletedSalesCount}`);

  // 2. Purge test sale_items in Firestore
  try {
    const siSnap = await getDocs(collection(db, 'sale_items'));
    let delItems = 0;
    for (const d of siSnap.docs) {
      if (testSaleIdSet.has(Number(d.data().sale_id))) {
        await deleteDoc(doc(db, 'sale_items', d.id));
        delItems++;
      }
    }
    console.log(`- Eliminadas ${delItems} líneas de sale_items de prueba en Firestore.`);
  } catch (err) {
    recordError('purge_sale_items', err);
  }

  // 3. Purge test cash_movements in Firestore
  try {
    const cmSnap = await getDocs(collection(db, 'cash_movements'));
    let delCash = 0;
    for (const d of cmSnap.docs) {
      if (testSaleIdSet.has(Number(d.data().sale_id))) {
        await deleteDoc(doc(db, 'cash_movements', d.id));
        delCash++;
      }
    }
    console.log(`- Eliminados ${delCash} movimientos de cash_movements de prueba en Firestore.`);
  } catch (err) {
    recordError('purge_cash_movements', err);
  }

  // 4. W10: Update stock of affected products in Firestore dynamically from current verified SQLite state
  try {
    const affectedProds = sqliteDb.prepare('SELECT id, stock, updated_at FROM products WHERE id IN (1, 5)').all();
    for (const prod of affectedProds) {
      const pRef = doc(db, 'products', String(prod.id));
      if ((await getDoc(pRef)).exists()) {
        const nowIso = prod.updated_at || new Date().toISOString();
        await updateDoc(pRef, { stock: Number(prod.stock), updated_at: nowIso });
        console.log(`- Sincronizado stock Producto #${prod.id} en Firestore desde SQLite: stock = ${prod.stock}`);
      }
    }
  } catch (err) {
    recordError('sync_products_stock', err);
  }

  // 5. Update cash_accounts in Firestore to match SQLite
  try {
    const localCashAccounts = sqliteDb.prepare('SELECT * FROM cash_accounts').all();
    for (const ca of localCashAccounts) {
      await setDoc(doc(db, 'cash_accounts', String(ca.id)), ca, { merge: true });
    }
    console.log(`- Conciliadas ${localCashAccounts.length} cuentas de caja en Firestore desde SQLite.`);
  } catch (err) {
    recordError('sync_cash_accounts', err);
  }

  // 6. Persist remediation state (tombstones, quarantine records, blocked operations) in settings table & Firestore settings collection
  try {
    const delRows = sqliteDb.prepare('SELECT * FROM deleted_records').all();
    const qRows = sqliteDb.prepare('SELECT * FROM incident_quarantine_records').all();
    const opRows = sqliteDb.prepare('SELECT * FROM processed_operations').all();
    const nowStr = new Date().toISOString();
    const statePayload = JSON.stringify({
      incident_id: 'INCIDENT_399_20261027',
      deleted_records: delRows,
      quarantine_records: qRows,
      processed_operations: opRows,
      sync_status: errors.length === 0 ? 'CONFIRMED' : 'PENDING_RETRY',
      sync_errors: errors,
      updated_at: nowStr
    });
    sqliteDb.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('incident_399_remediation_state', ?, ?)").run(statePayload, nowStr);
    await setDoc(doc(db, 'settings', 'incident_399_remediation_state'), {
      key: 'incident_399_remediation_state',
      value: statePayload,
      updated_at: nowStr
    });
    console.log(`- Sincronizados ${delRows.length} tombstones, ${qRows.length} registros de cuarentena y ${opRows.length} operaciones en Firestore.`);
  } catch (err) {
    recordError('sync_remediation_state', err);
  }

  // 7. Verify Sale #398 and #424 in Firestore
  try {
    const s398Snap = await getDoc(doc(db, 'sales', '398'));
    if (s398Snap.exists()) {
      console.log(`- Verificación Firestore: Venta #398 existe remotamente: total = ${s398Snap.data().total}`);
    }
    const s424Snap = await getDoc(doc(db, 'sales', '424'));
    if (s424Snap.exists()) {
      console.log(`- Verificación Firestore: Venta #424 existe remotamente: total = ${s424Snap.data().total}`);
    }
  } catch (err) {
    recordError('verify_legitimate_sales', err);
  }

  // W11: Record explicit status in local SQLite and fail with exit code 1 if any cloud operation failed
  try {
    const nowStr = new Date().toISOString();
    const statusObj = {
      status: errors.length === 0 ? 'CONFIRMED' : 'PENDING_CLOUD_CLEANUP',
      error_count: errors.length,
      errors,
      updated_at: nowStr
    };
    sqliteDb.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('incident_399_firestore_cleanup_status', ?, ?)").run(JSON.stringify(statusObj), nowStr);
  } catch (_) {}

  sqliteDb.close();

  if (errors.length > 0) {
    console.error(`=== ERROR: LA PURGA EN FIRESTORE TUVO ${errors.length} FALLO(S). ESTADO MARCADO COMO PENDIENTE ===`);
    process.exit(1);
  }

  console.log("=== PURGA Y CONCILIACIÓN DE FIRESTORE FINALIZADAS CON ÉXITO ===");
  process.exit(0);
}

runFirestoreCleanup().catch(err => {
  console.error("Error crítico en purga de Firestore:", err);
  try { sqliteDb.close(); } catch (_) {}
  process.exit(1);
});
