import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, deleteDoc } from 'firebase/firestore';
import fs from 'fs';

/**
 * Script de auditoría y remediación de jwt_secret en Google Cloud Firestore.
 * Inspecciona las colecciones 'settings' y 'sandbox_settings'.
 * Si se pasa la bandera --purge, elimina de forma segura el documento sensible remoto
 * sin modificar la clave local en SQLite (.server_jwt_secret).
 */
async function auditAndPurge() {
  const configFile = './firebase-applet-config.json';
  if (!fs.existsSync(configFile)) {
    console.log('[Audit] firebase-applet-config.json no encontrado.');
    return;
  }

  const shouldPurge = process.argv.includes('--purge');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const app = initializeApp(config);
  const firestore = getFirestore(app, config.firestoreDatabaseId);

  const collections = ['settings', 'sandbox_settings'];
  console.log(`[Audit] Iniciando auditoría de 'jwt_secret' en Firestore (Modo: ${shouldPurge ? 'PURGA ACTIVA' : 'SOLO LECTURA / INSPECCIÓN'})...`);

  for (const coll of collections) {
    try {
      const docRef = doc(firestore, coll, 'jwt_secret');
      const snap = await getDoc(docRef);

      if (snap.exists()) {
        console.warn(`[ALERTA] Se encontró 'jwt_secret' en la colección '${coll}' de Firestore.`);
        if (shouldPurge) {
          await deleteDoc(docRef);
          console.log(`[REMEDIADO] Documento 'jwt_secret' eliminado exitosamente de '${coll}'.`);
        } else {
          console.log(`[Info] Para eliminar este documento remoto, ejecute el script con la bandera --purge.`);
        }
      } else {
        console.log(`[OK] La colección '${coll}' NO contiene el documento 'jwt_secret'.`);
      }
    } catch (err: any) {
      console.error(`[Error] Falló la comprobación en '${coll}':`, err.message);
    }
  }

  console.log('[Audit] Finalizada la comprobación de secretos en Firestore.');
  process.exit(0);
}

auditAndPurge();
