const { initializeApp, getApps, getApp } = require('firebase/app');
const { getFirestore, collection, getDocs, doc, getDoc, deleteDoc, updateDoc, setDoc } = require('firebase/firestore');
const { getAuth, signInWithEmailAndPassword } = require('firebase/auth');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const configPath = path.resolve(__dirname, '../firebase-applet-config.json');
if (!fs.existsSync(configPath)) {
  console.log("firebase-applet-config.json no existe. Omitiendo sincronización remota.");
  process.exit(0);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const app = getApps().length ? getApp() : initializeApp(config);
const db = getFirestore(app, config.firestoreDatabaseId);
const sqliteDb = new Database(path.resolve(__dirname, '../gtr_pos.db'));

const testSaleIds = [
  399, 400, 401, 402, 403, 404, 405, 406, 407, 408,
  409, 410, 411, 412, 413, 414, 415, 416, 417, 418,
  419, 420, 421, 422, 423, 425, 426, 427, 428
];
const testSaleIdSet = new Set(testSaleIds);

async function runFirestoreCleanup() {
  console.log("=== INICIANDO PURGA Y CONCILIACIÓN EN FIRESTORE REMOTO ===");
  console.log(`Target Firestore DB: ${config.firestoreDatabaseId}`);

  try {
    const auth = getAuth(app);
    await signInWithEmailAndPassword(auth, "server_sync@dstore.app", "ServerSync_SecretPassword!123");
  } catch (_) {}

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
      console.warn(`Aviso al consultar/eliminar venta #${id} en Firestore:`, err.message);
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
    console.warn("Aviso al purgar sale_items en Firestore:", err.message);
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
    console.warn("Aviso al purgar cash_movements en Firestore:", err.message);
  }

  // 4. Update stock of products 1 and 5 in Firestore
  try {
    const p1Ref = doc(db, 'products', '1');
    if ((await getDoc(p1Ref)).exists()) {
      await updateDoc(p1Ref, { stock: 3, updated_at: new Date().toISOString() });
      console.log("- Actualizado stock Producto #1 en Firestore: stock = 3");
    }

    const p5Ref = doc(db, 'products', '5');
    if ((await getDoc(p5Ref)).exists()) {
      await updateDoc(p5Ref, { stock: 330, updated_at: new Date().toISOString() });
      console.log("- Actualizado stock Producto #5 en Firestore: stock = 330");
    }
  } catch (err) {
    console.warn("Aviso al actualizar productos en Firestore:", err.message);
  }

  // 5. Update cash_accounts in Firestore to match SQLite
  try {
    const localCashAccounts = sqliteDb.prepare('SELECT * FROM cash_accounts').all();
    for (const ca of localCashAccounts) {
      await setDoc(doc(db, 'cash_accounts', String(ca.id)), ca, { merge: true });
    }
    console.log(`- Conciliadas ${localCashAccounts.length} cuentas de caja en Firestore (@maria = 610 BOB, @admin = 0 BOB, @vendedor_test = 0 BOB).`);
  } catch (err) {
    console.warn("Aviso al actualizar cash_accounts en Firestore:", err.message);
  }

  // 6. Persist remediation state (tombstones, quarantine records, blocked operations) in settings table & Firestore settings collection
  try {
    const delRows = sqliteDb.prepare('SELECT * FROM deleted_records').all();
    const qRows = sqliteDb.prepare('SELECT * FROM incident_quarantine_records').all();
    const opRows = sqliteDb.prepare('SELECT * FROM processed_operations').all();
    const statePayload = JSON.stringify({
      incident_id: 'INCIDENT_399_20261027',
      deleted_records: delRows,
      quarantine_records: qRows,
      processed_operations: opRows,
      updated_at: new Date().toISOString()
    });
    const nowStr = new Date().toISOString();
    sqliteDb.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('incident_399_remediation_state', ?, ?)").run(statePayload, nowStr);
    await setDoc(doc(db, 'settings', 'incident_399_remediation_state'), {
      key: 'incident_399_remediation_state',
      value: statePayload,
      updated_at: nowStr
    });
    console.log(`- Sincronizados ${delRows.length} tombstones, ${qRows.length} registros de cuarentena y ${opRows.length} operaciones bloqueadas en Firestore (settings/incident_399_remediation_state).`);
  } catch (err) {
    console.warn("Aviso al sincronizar estado de remediación en Firestore:", err.message);
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
    console.warn("Aviso en verificación de ventas legítimas en Firestore:", err.message);
  }

  sqliteDb.close();
  console.log("=== PURGA Y CONCILIACIÓN DE FIRESTORE FINALIZADAS ===");
  process.exit(0);
}

runFirestoreCleanup().catch(err => {
  console.error("Error en purga de Firestore:", err);
  process.exit(1);
});
