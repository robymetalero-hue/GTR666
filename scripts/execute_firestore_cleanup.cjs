const { initializeApp, getApps, getApp } = require('firebase/app');
const { getFirestore, doc, getDoc, deleteDoc, updateDoc, setDoc } = require('firebase/firestore');
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

const testSaleIds = [
  399, 400, 401, 402, 403, 404, 405, 406, 407, 408,
  409, 410, 411, 412, 413, 414, 415, 416, 417, 418,
  419, 420, 421, 422, 423, 425, 426, 427, 428
];

async function runFirestoreCleanup() {
  console.log("=== INICIANDO PURGA EN FIRESTORE REMOTO ===");
  console.log(`Target Firestore DB: ${config.firestoreDatabaseId}`);

  // 1. Purge test sales
  let deletedCount = 0;
  for (const id of testSaleIds) {
    try {
      const docRef = doc(db, 'sales', String(id));
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        await deleteDoc(docRef);
        console.log(`- Eliminado de Firestore sales #${id}`);
        deletedCount++;
      }
    } catch (err) {
      console.warn(`Aviso al consultar/eliminar venta #${id} en Firestore:`, err.message);
    }
  }
  console.log(`Total documentos sales eliminados de Firestore: ${deletedCount}`);

  // 2. Update stock of products 1 and 5 in Firestore
  try {
    const p1Ref = doc(db, 'products', '1');
    const p1Snap = await getDoc(p1Ref);
    if (p1Snap.exists()) {
      await updateDoc(p1Ref, { stock: 3, updated_at: new Date().toISOString() });
      console.log("- Actualizado stock Producto #1 en Firestore: stock = 3");
    }

    const p5Ref = doc(db, 'products', '5');
    const p5Snap = await getDoc(p5Ref);
    if (p5Snap.exists()) {
      await updateDoc(p5Ref, { stock: 330, updated_at: new Date().toISOString() });
      console.log("- Actualizado stock Producto #5 en Firestore: stock = 330");
    }
  } catch (err) {
    console.warn("Aviso al actualizar productos en Firestore:", err.message);
  }

  // 3. Write invalidation tombstones in Firestore
  try {
    for (const id of testSaleIds) {
      const tombstoneRef = doc(db, 'invalidated_test_sales', String(id));
      await setDoc(tombstoneRef, {
        sale_id: id,
        incident_id: 'INCIDENT_399_20261027',
        invalidated_at: new Date().toISOString(),
        reason: 'Remediación de incidente de pruebas en producción',
        status: 'tombstoned'
      });
    }
    console.log(`- Registrados ${testSaleIds.length} marcadores de invalidación (tombstones) en Firestore.`);
  } catch (err) {
    console.warn("Aviso al registrar tombstones en Firestore:", err.message);
  }

  // 4. Verify Sale #398 and #424 in Firestore
  try {
    const s398Snap = await getDoc(doc(db, 'sales', '398'));
    if (s398Snap.exists()) {
      console.log(`- Verificación Firestore: Venta #398 existe remotamente: total = ${s398Snap.data().total}`);
    } else {
      console.log("- Venta #398 no reside en Firestore (solo en SQLite local).");
    }

    const s424Snap = await getDoc(doc(db, 'sales', '424'));
    if (s424Snap.exists()) {
      console.log(`- Verificación Firestore: Venta #424 existe remotamente: total = ${s424Snap.data().total}`);
    } else {
      console.log("- Venta #424 no reside en Firestore (solo en SQLite local).");
    }
  } catch (err) {
    console.warn("Aviso en verificación de ventas legítimas en Firestore:", err.message);
  }

  console.log("=== PURGA Y TOMBSTONING DE FIRESTORE FINALIZADOS ===");
  process.exit(0);
}

runFirestoreCleanup().catch(err => {
  console.error("Error en purga de Firestore:", err);
  process.exit(1);
});
