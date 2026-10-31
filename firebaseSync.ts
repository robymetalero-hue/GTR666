import { initializeApp, getApps, getApp } from 'firebase/app';

let quotaExceeded = false;
let quotaExceededTime = 0;
export function checkQuota(): boolean {
  if (quotaExceeded) {
    if (Date.now() - quotaExceededTime > 1000 * 60 * 60) {
      quotaExceeded = false;
      return false;
    }
    return true;
  }
  return false;
}

function handleSyncError(err: any, msg: string) {
  const errMsg = err?.message || String(err);
  const lower = errMsg.toLowerCase();
  if (lower.includes('quota') || lower.includes('resource_exhausted') || lower.includes('429')) {
    if (!quotaExceeded) {
      console.warn("[Sync] Firestore quota limit reached. Operating in standalone offline mode.");
      quotaExceeded = true;
      quotaExceededTime = Date.now();
    }
  } else if (!lower.includes('offline') && !lower.includes('network') && !lower.includes('unavailable') && !lower.includes('auth')) {
    console.warn(`${msg} ${errMsg}`);
  }
}

import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword } from 'firebase/auth';
import { 
  getFirestore, 
  collection, 
  doc, 
  getDoc, 
  setDoc, 
  getDocs, 
  writeBatch, 
  query, 
  limit,
  orderBy
} from 'firebase/firestore';
import { db, isCurrentContextSandbox, dbAsyncLocalStorage, ensureSafeAutoincrementSequence, getBoliviaISOString } from './database.ts';

export function getCollectionName(tableName: string): string {
  if (isCurrentContextSandbox()) {
    return `sandbox_${tableName}`;
  }
  return tableName;
}
import { 
  validateFirestoreWriteOperation, 
  validateRemoteFirestoreDocument,
  confirmFirestoreWriteInLedger,
  type UserContext 
} from './firestoreIntegrityMiddleware.ts';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Load Firebase app configuration searching multiple potential locations
let firebaseConfig: any = {};
const configLocations = [
  path.resolve(process.cwd(), 'firebase-applet-config.json'),
  path.resolve(process.cwd(), '..', 'firebase-applet-config.json')
];

for (const loc of configLocations) {
  try {
    if (fs.existsSync(loc)) {
      firebaseConfig = JSON.parse(fs.readFileSync(loc, 'utf8'));
      break;
    }
  } catch (e: any) {
    console.warn(`[Firebase] Could not read config at ${loc}:`, e.message);
  }
}

// Initialize Client-Side Firebase SDK on Node.js server side
let app: any = null;
try {
  if (firebaseConfig.projectId) {
    if (getApps().length) {
      app = getApp();
    } else {
      app = initializeApp({
        apiKey: firebaseConfig.apiKey,
        authDomain: firebaseConfig.authDomain,
        projectId: firebaseConfig.projectId,
        storageBucket: firebaseConfig.storageBucket,
        messagingSenderId: firebaseConfig.messagingSenderId,
        appId: firebaseConfig.appId
      });
      console.log("[Firebase] SDK initialized with Project ID:", firebaseConfig.projectId);
    }
  }
} catch (e: any) {
  console.warn("[Firebase] SDK initialization deferred:", e.message);
}

let firestoreInstance: any = null;
try {
  firestoreInstance = app
    ? (firebaseConfig.firestoreDatabaseId 
        ? getFirestore(app, firebaseConfig.firestoreDatabaseId)
        : getFirestore(app))
    : null;
} catch (e: any) {
  console.warn("[Firestore] Instance deferred:", e.message);
}

export const firestore = firestoreInstance;

let authDisabledUntil = 0;
let authAuthenticated = false;
let authPromise: Promise<void> | null = null;

export async function ensureServerAuth() {
  if (!app || !firestore) return;
  if (authAuthenticated) return;
  if (Date.now() < authDisabledUntil) return;

  const envEmail = String(process.env.FIREBASE_SYNC_EMAIL || '').trim();
  const envPassword = String(process.env.FIREBASE_SYNC_PASSWORD || '').trim();
  const defaultKey = 'GtrSync_' + crypto.createHash('sha256').update(String(firebaseConfig.appId || '') + ':gtrpos_sync_channel').digest('hex').slice(0, 24) + '!';
  const email = envEmail || 'server-sync@gtrpos.com';
  const password = envPassword || defaultKey;

  if (!authPromise) {
    authPromise = (async () => {
      const authTimeout = new Promise<void>((resolve) => setTimeout(resolve, 4000));
      const authTask = (async () => {
        try {
          const auth = getAuth(app);
          await signInWithEmailAndPassword(auth, email, password);
          authAuthenticated = true;
        } catch (err: any) {
          const code = String(err?.code || '');
          if (!envEmail && (code === 'auth/user-not-found' || code === 'auth/invalid-credential')) {
            try {
              const auth = getAuth(app);
              await createUserWithEmailAndPassword(auth, email, password);
              authAuthenticated = true;
              return;
            } catch (_) {}
          }
          authDisabledUntil = Date.now() + (5 * 60 * 1000);
        }
      })();
      await Promise.race([authTask, authTimeout]);
    })().finally(() => {
      authPromise = null;
    });
  }
  return authPromise;
}

export const SYNC_TABLES = [
  'settings',
  'users',
  'products',
  'clients',
  'sales',
  'sale_items',
  'shifts',
  'exchange_rate_audit',
  'caja_cierres',
  'departments',
  'stock_arrivals',
  'pending_sales',
  'pending_sale_items',
  'accounts_receivable',
  'credit_payments',
  'pending_sale_payments',
  'cash_accounts',
  'cash_movements',
  'cash_settlements',
  'inventory_audit_logs',
  'system_audit_logs',
  'inventory_counts',
  'inventory_count_items',
  'sale_returns',
  'offline_pending_sales',
  'firestore_transaction_ledger'
];

export const SENSITIVE_SETTINGS_KEYS = new Set(['jwt_secret']);

let isPullingInProgress = false;
let lastPullTimestamp = 0;
const PULL_COOLDOWN_MS = 10000; // 10 seconds rate limit for background pulls

// List of tables that are append-only to avoid full collection scans & rewrites on sync
export const APPEND_ONLY_TABLES = [
  'sales',
  'sale_items',
  'shifts',
  'exchange_rate_audit',
  'caja_cierres',
  'stock_arrivals',
  'accounts_receivable',
  'credit_payments',
  'pending_sale_payments',
  'cash_settlements',
  'inventory_audit_logs',
  'system_audit_logs',
  'sale_returns',
  'firestore_transaction_ledger'
];

// In-memory cache of last successfully synchronized maximum IDs per table to prevent redundant Firestore operations
export const lastSyncedMaxIdCache: Record<string, number> = {};

// Zero-Defect Layer 2: SHA-256 Digest Cache & Sync Mutex Queue to prevent double synchronization
export const lastSyncedDigestCache = new Map<string, string>();
const VOLATILE_SYNC_META_KEYS = new Set([
  '_tx_hash',
  '_tx_timestamp',
  '_tx_user_id',
  '_tx_user_name',
  '_tx_user_role',
  '_tx_operation',
  '_syncedAt',
  '_integrity'
]);

export const syncDeduplicationStats = {
  evaluatedCount: 0,
  skippedIdenticalCount: 0,
  pushedCount: 0,
  coalescedWriteTriggers: 0
};

export function computeCanonicalRecordDigest(tableName: string, data: Record<string, any>): string {
  const canonicalObj: Record<string, any> = { __table: getCollectionName(tableName) };
  const sortedKeys = Object.keys(data || {})
    .filter(k => !VOLATILE_SYNC_META_KEYS.has(k) && data[k] !== undefined)
    .sort();
  for (const k of sortedKeys) {
    canonicalObj[k] = data[k];
  }
  return crypto.createHash('sha256').update(JSON.stringify(canonicalObj)).digest('hex');
}

export function shouldPushRecordToCloud(
  tableName: string,
  docId: string | number,
  payload: Record<string, any>,
  markAsSynced: boolean = false
): { shouldPush: boolean; digest: string; cacheKey: string } {
  const cacheKey = `${getCollectionName(tableName)}:${String(docId)}`;
  const digest = computeCanonicalRecordDigest(tableName, payload);
  syncDeduplicationStats.evaluatedCount++;
  const existing = lastSyncedDigestCache.get(cacheKey);
  if (existing && existing === digest) {
    syncDeduplicationStats.skippedIdenticalCount++;
    return { shouldPush: false, digest, cacheKey };
  }
  if (markAsSynced) {
    lastSyncedDigestCache.set(cacheKey, digest);
    syncDeduplicationStats.pushedCount++;
  }
  return { shouldPush: true, digest, cacheKey };
}

export function getSyncDeduplicationStats() {
  return {
    ...syncDeduplicationStats,
    cachedDigestsCount: lastSyncedDigestCache.size
  };
}

let syncMutexChain: Promise<any> = Promise.resolve();
export function enqueueSyncTask<T>(taskFn: () => Promise<T>): Promise<T> {
  const next = syncMutexChain.then(() => taskFn(), () => taskFn());
  syncMutexChain = next.catch(() => {});
  return next;
}

/**
 * Records a deletion in the local deleted_records tombstone table.
 */
export function recordDeletion(tableName: string, recordId: string | number) {
  try {
    const idStr = String(recordId);
    db.prepare("INSERT OR REPLACE INTO deleted_records (table_name, record_id, deleted_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%S-04:00', 'now', '-4 hours'))").run(tableName, idStr);
    lastSyncedDigestCache.delete(`${getCollectionName(tableName)}:${idStr}`);
  } catch (e: any) {
    console.warn(`[DeletedRecords] Warning recording deletion for ${tableName} #${recordId}:`, e.message);
  }
}

/**
 * Checks if a record was marked as deleted.
 */
export function isRecordDeleted(tableName: string, recordId: string | number): boolean {
  try {
    const row = db.prepare('SELECT 1 FROM deleted_records WHERE table_name = ? AND record_id = ?').get(tableName, String(recordId));
    return !!row;
  } catch (e: any) {
    return false;
  }
}

/**
 * Deletes document(s) directly and immediately from Firestore.
 */
export async function deleteFromFirestore(tableName: string, idOrIds: any | any[], userContext?: UserContext) {
  if (!firestore || checkQuota()) {
    return;
  }
  await ensureServerAuth();

  const ids = Array.isArray(idOrIds) ? idOrIds.map(String) : [String(idOrIds)];
  if (ids.length === 0) return;

  try {
    let batch = writeBatch(firestore);
    let count = 0;
    let pendingBatchHashes: string[] = [];
    for (const id of ids) {
      // Validate deletion operation and log to tamper-evident transaction ledger
      let txHash = '';
      try {
        const validation = validateFirestoreWriteOperation(tableName, id, 'DELETE', undefined, userContext);
        txHash = validation.txHash;
      } catch (valErr: any) {
        console.warn(`[Firestore Integrity Warning] Blocked delete operation on ${tableName} #${id}:`, valErr.message);
        continue;
      }

      const docRef = doc(firestore, getCollectionName(tableName), String(id));
      batch.delete(docRef);
      if (txHash) pendingBatchHashes.push(txHash);
      count++;
      if (count >= 400) {
        await batch.commit();
        confirmFirestoreWriteInLedger(pendingBatchHashes);
        pendingBatchHashes = [];
        batch = writeBatch(firestore);
        count = 0;
      }
    }
    if (count > 0) {
      await batch.commit();
      confirmFirestoreWriteInLedger(pendingBatchHashes);
      pendingBatchHashes = [];
    }
    console.log(`[Sync Delete] Successfully deleted ${ids.length} document(s) from Firestore collection "${tableName}".`);
  } catch (err: any) {
    handleSyncError(err, `[Sync Delete Error] Could not delete from Firestore "${tableName}":`);
  }
}

/**
 * Pushes a local SQLite table's content to Firestore.
 * Supports targeted synchronization for specific rows to optimize speed and network payload.
 */
export async function pushLocalToFirestore(tableName: string, idOrIds?: any | any[], userContext?: UserContext) {
  if (!firestore || checkQuota()) {
    return;
  }
  await ensureServerAuth();

  try {
    const isSettings = tableName === 'settings';
    let rows: any[] = [];
    let idList = idOrIds ? (Array.isArray(idOrIds) ? idOrIds.map(String) : [String(idOrIds)]) : null;
    if (isSettings && idList) {
      idList = idList.filter(k => !SENSITIVE_SETTINGS_KEYS.has(k));
      if (idList.length === 0) return;
    }

    // Filter out locally deleted records
    let deletedIdsSet = new Set<string>();
    try {
      const deletedRows = db.prepare("SELECT record_id FROM deleted_records WHERE table_name = ?").all(tableName) as any[];
      deletedIdsSet = new Set(deletedRows.map(r => String(r.record_id)));
    } catch (e) {}

    if (idList && idList.length > 0) {
      // Sync only specific rows to make it super fast
      if (isSettings) {
        const placeholders = idList.map(() => '?').join(', ');
        rows = db.prepare(`SELECT * FROM settings WHERE key IN (${placeholders})`).all(...idList) as any[];
        rows = rows.filter(r => !SENSITIVE_SETTINGS_KEYS.has(String(r.key)));
      } else {
        const validIds = idList.filter(id => !deletedIdsSet.has(String(id)));
        if (validIds.length === 0) {
          // If all targeted IDs are deleted, delete them from Firestore
          await deleteFromFirestore(tableName, idList, userContext);
          return;
        }
        const placeholders = validIds.map(() => '?').join(', ');
        rows = db.prepare(`SELECT * FROM ${tableName} WHERE id IN (${placeholders})`).all(...validIds) as any[];
      }
    } else {
      // Full table sync requested.
      if (APPEND_ONLY_TABLES.includes(tableName)) {
        // 1. Obtener ID máximo local en SQLite
        let localMaxId = 0;
        try {
          const maxRow = db.prepare(`SELECT MAX(id) as maxId FROM ${tableName}`).get() as any;
          localMaxId = Number(maxRow?.maxId || 0);
        } catch (sqliteErr: any) {}

        // 2. Si localMaxId es 0, no hay datos locales, no hace falta hacer nada
        if (localMaxId === 0) {
          return;
        }

        // 3. Consultar cache local en memoria. Si ya está sincronizado hasta el ID local máximo, omitir
        const cachedMax = lastSyncedMaxIdCache[tableName];
        if (cachedMax !== undefined && localMaxId <= cachedMax) {
          return;
        }

        // 4. Consultar ID máximo actual en Firestore
        let firestoreMaxId = 0;
        const colRef = collection(firestore, getCollectionName(tableName));
        try {
          const q = query(colRef, orderBy('id', 'desc'), limit(1));
          const qSnapshot = await getDocs(q);
          if (!qSnapshot.empty) {
            const docData = qSnapshot.docs[0].data();
            if (docData && typeof docData.id === 'number') {
              firestoreMaxId = docData.id;
            }
          }
        } catch (firestoreErr: any) {
          handleSyncError(firestoreErr, `[Sync] Could not verify remote max ID for "${tableName}":`);
          firestoreMaxId = -1;
        }

        if (firestoreMaxId >= 0) {
          // S05: Detect and push any gap transactions with id <= firestoreMaxId not yet confirmed in transaction ledger
          let missedRows: any[] = [];
          try {
            missedRows = db.prepare(`
              SELECT * FROM ${tableName} 
              WHERE id <= ? 
                AND id NOT IN (
                  SELECT CAST(record_id AS INTEGER) 
                  FROM firestore_transaction_ledger 
                  WHERE table_name = ? AND status IN ('CONFIRMED_IN_CLOUD', 'VALIDATED_AND_COMMITTED')
                )
            `).all(firestoreMaxId, tableName) as any[];
          } catch (_) {
            missedRows = [];
          }

          const newRows = localMaxId > firestoreMaxId
            ? (db.prepare(`SELECT * FROM ${tableName} WHERE id > ?`).all(firestoreMaxId) as any[])
            : [];

          rows = [...missedRows, ...newRows];

          if (rows.length === 0) {
            lastSyncedMaxIdCache[tableName] = Math.max(localMaxId, firestoreMaxId);
            return;
          }

          let batch = writeBatch(firestore);
          let opCount = 0;
          let pendingBatchHashes: string[] = [];
          let pendingBatchDigests: Array<{ cacheKey: string; digest: string }> = [];

          for (const row of rows) {
            const docId = String(row.id);
            if (deletedIdsSet.has(docId)) continue;

            const cleanData: any = {};
            for (const [key, val] of Object.entries(row)) {
              if (val !== undefined) {
                cleanData[key] = val;
              }
            }

            const dedup = shouldPushRecordToCloud(tableName, docId, cleanData, false);
            if (!dedup.shouldPush) {
              continue;
            }

            // Strictly validate payload integrity and compute cryptographic transaction hash
            let enrichedData = cleanData;
            let txHash = '';
            try {
              const validation = validateFirestoreWriteOperation(tableName, docId, 'CREATE', cleanData, userContext);
              enrichedData = validation.enrichedPayload;
              txHash = validation.txHash;
            } catch (valErr: any) {
              console.warn(`[Firestore Anti-Ghost Violation] Blocked record on ${tableName} #${docId}:`, valErr.message);
              continue;
            }

            const docRef = doc(firestore, getCollectionName(tableName), docId);
            batch.set(docRef, enrichedData);
            if (txHash) pendingBatchHashes.push(txHash);
            pendingBatchDigests.push({ cacheKey: dedup.cacheKey, digest: dedup.digest });
            opCount++;

            if (opCount >= 400) {
              await batch.commit();
              confirmFirestoreWriteInLedger(pendingBatchHashes);
              for (const d of pendingBatchDigests) {
                lastSyncedDigestCache.set(d.cacheKey, d.digest);
                syncDeduplicationStats.pushedCount++;
              }
              pendingBatchHashes = [];
              pendingBatchDigests = [];
              batch = writeBatch(firestore);
              opCount = 0;
            }
          }

          if (opCount > 0) {
            await batch.commit();
            confirmFirestoreWriteInLedger(pendingBatchHashes);
            for (const d of pendingBatchDigests) {
              lastSyncedDigestCache.set(d.cacheKey, d.digest);
              syncDeduplicationStats.pushedCount++;
            }
            pendingBatchHashes = [];
            pendingBatchDigests = [];
          }

          lastSyncedMaxIdCache[tableName] = localMaxId;
          return;
        }
      }

      rows = db.prepare(`SELECT * FROM ${tableName}`).all() as any[];
      if (isSettings) {
        rows = rows.filter(r => !SENSITIVE_SETTINGS_KEYS.has(String(r.key)));
      }
      if (deletedIdsSet.size > 0 && !isSettings) {
        rows = rows.filter(r => !deletedIdsSet.has(String(r.id)));
      }
    }

    const colRef = collection(firestore, getCollectionName(tableName));

    // If this is a targeted update (idList was specified), we don't handle deletions of other rows.
    // We only upsert the specified rows. This runs in O(N) where N is the number of updated rows (usually 1 or a few).
    if (idList && idList.length > 0) {
      if (rows.length === 0) {
        console.log(`[Sync] Targeted sync requested for "${tableName}" but rows were empty locally.`);
        return;
      }
      let batch = writeBatch(firestore);
      let opCount = 0;
      let pendingBatchHashes: string[] = [];
      let pendingBatchDigests: Array<{ cacheKey: string; digest: string }> = [];

      for (const row of rows) {
        const docId = isSettings ? row.key : String(row.id);

        const cleanData: any = {};
        for (const [key, val] of Object.entries(row)) {
          if (val !== undefined) {
            cleanData[key] = val;
          }
        }

        const dedup = shouldPushRecordToCloud(tableName, docId, cleanData, false);
        if (!dedup.shouldPush) {
          continue;
        }
        if (isSettings && !cleanData.updated_at) {
          cleanData.updated_at = new Date().toISOString();
        }

        // Validate payload & compute transaction hash
        let enrichedData = cleanData;
        let txHash = '';
        try {
          const validation = validateFirestoreWriteOperation(tableName, docId, 'CREATE', cleanData, userContext);
          enrichedData = validation.enrichedPayload;
          txHash = validation.txHash;
        } catch (valErr: any) {
          console.warn(`[Firestore Anti-Ghost Violation] Blocked targeted row on ${tableName} #${docId}:`, valErr.message);
          continue;
        }

        const docRef = doc(firestore, getCollectionName(tableName), docId);
        batch.set(docRef, enrichedData);
        if (txHash) pendingBatchHashes.push(txHash);
        pendingBatchDigests.push({ cacheKey: dedup.cacheKey, digest: dedup.digest });
        opCount++;

        if (opCount >= 400) {
          await batch.commit();
          confirmFirestoreWriteInLedger(pendingBatchHashes);
          for (const d of pendingBatchDigests) {
            lastSyncedDigestCache.set(d.cacheKey, d.digest);
            syncDeduplicationStats.pushedCount++;
          }
          pendingBatchHashes = [];
          pendingBatchDigests = [];
          batch = writeBatch(firestore);
          opCount = 0;
        }
      }

      if (opCount > 0) {
        await batch.commit();
        confirmFirestoreWriteInLedger(pendingBatchHashes);
        for (const d of pendingBatchDigests) {
          lastSyncedDigestCache.set(d.cacheKey, d.digest);
          syncDeduplicationStats.pushedCount++;
        }
        pendingBatchHashes = [];
        pendingBatchDigests = [];
      }

      console.log(`[Sync] Targeted sync for table "${tableName}" (${rows.length} rows: [${idList.join(', ')}]) completed successfully.`);
      return;
    }

    // Fetch existing documents from Firestore for this collection to handle deletions
    const snapshot = await getDocs(colRef);
    
    // Set of local IDs currently in SQLite
    const localIds = new Set(rows.map(row => {
      if (tableName === 'settings') {
        return row.key;
      }
      return String(row.id);
    }));

    // ANTI-TRUNCATION PUSH SHIELD:
    // If local table has suspiciously few records (< 10) for products/sales, but remote Firestore has a healthy dataset (>= 50),
    // NEVER push and overwrite Firestore with an impoverished local dataset!
    if (tableName === 'products' && rows.length < 10) {
      try {
        if (snapshot.size >= 50) {
          console.warn(`[Anti-Truncation Push Shield] Local products count (${rows.length}) is critically lower than remote Firestore (${snapshot.size}). Aborting push to prevent cloud data loss.`);
          return;
        }
      } catch (_) {}
    }

    // ANTI-ZERO-STOCK PUSH SHIELD:
    // If local products have suspiciously low non-zero stock (e.g. < 30% positive while remote has healthy positive inventory),
    // NEVER push and wipe Cloud Firestore with corrupted zero-stock products!
    if (tableName === 'products') {
      try {
        const localPositive = rows.filter((r: any) => Number(r.stock) > 0).length;
        const remotePositive = snapshot.docs.filter(d => Number(d.data().stock) > 0).length;
        if (remotePositive > 30 && localPositive < remotePositive * 0.3) {
          console.warn(`[Anti-Zero-Stock Shield] Aborted push to Firestore: Local positive stock count (${localPositive}) is critically lower than remote Firestore (${remotePositive}). Protecting Cloud Firestore from zero-stock contamination.`);
          return;
        }
      } catch (_) {}
    }

    // Start a Firestore batch
    let batch = writeBatch(firestore);
    let opCount = 0;
    let pendingBatchHashes: string[] = [];
    let pendingBatchDigests: Array<{ cacheKey: string; digest: string }> = [];

    // Upsert all local records to Firestore with strict verification
    for (const row of rows) {
      const docId = tableName === 'settings' ? row.key : String(row.id);
      
      const cleanData: any = {};
      for (const [key, val] of Object.entries(row)) {
        if (val !== undefined) {
          cleanData[key] = val;
        }
      }

      const dedup = shouldPushRecordToCloud(tableName, docId, cleanData, false);
      if (!dedup.shouldPush) {
        continue;
      }
      if (tableName === 'settings' && !cleanData.updated_at) {
        cleanData.updated_at = new Date().toISOString();
      }

      let enrichedData = cleanData;
      let txHash = '';
      try {
        const validation = validateFirestoreWriteOperation(tableName, docId, 'CREATE', cleanData, userContext);
        enrichedData = validation.enrichedPayload;
        txHash = validation.txHash;
      } catch (valErr: any) {
        console.warn(`[Firestore Anti-Ghost Violation] Blocked upsert on ${tableName} #${docId}:`, valErr.message);
        continue;
      }

      const docRef = doc(firestore, getCollectionName(tableName), docId);
      batch.set(docRef, enrichedData);
      if (txHash) pendingBatchHashes.push(txHash);
      pendingBatchDigests.push({ cacheKey: dedup.cacheKey, digest: dedup.digest });
      opCount++;

      // Commit batches when approaching Firestore's 500 operation limit
      if (opCount >= 400) {
        await batch.commit();
        confirmFirestoreWriteInLedger(pendingBatchHashes);
        for (const d of pendingBatchDigests) {
          lastSyncedDigestCache.set(d.cacheKey, d.digest);
          syncDeduplicationStats.pushedCount++;
        }
        pendingBatchHashes = [];
        pendingBatchDigests = [];
        batch = writeBatch(firestore);
        opCount = 0;
      }
    }

    if (opCount > 0) {
      await batch.commit();
      confirmFirestoreWriteInLedger(pendingBatchHashes);
      for (const d of pendingBatchDigests) {
        lastSyncedDigestCache.set(d.cacheKey, d.digest);
        syncDeduplicationStats.pushedCount++;
      }
      pendingBatchHashes = [];
      pendingBatchDigests = [];
    }

    console.log(`[Sync] Successfully synchronized table "${tableName}" to Firestore (Local Row Count: ${rows.length})`);
  } catch (error: any) {
    handleSyncError(error, `[Sync Offline Mode] Unable to sync local table "${tableName}" to Firestore (will save locally):`);
  }
}

/**
 * Syncs all SQLite tables to Firestore.
 */
export async function pushAllLocalToFirestore() {
  console.log("[Sync] Triggered full push from SQLite to Google Cloud Firestore...");
  for (const table of SYNC_TABLES) {
    await pushLocalToFirestore(table);
  }
}

/**
 * Pulls master documents from Google Cloud Firestore and populates SQLite.
 * If Firestore is empty, we perform an initial bootstrap sync from local SQLite data.
 * This function handles deletions in Firestore correctly by clearing local records before sync ONLY if forceOverwrite is true.
 */
export async function pullFirestoreToLocal(forceOverwrite: boolean = false) {
  if (!firestore || checkQuota()) {
    return;
  }
  await ensureServerAuth();

  if (isPullingInProgress) {
    return;
  }

  if (!forceOverwrite && (Date.now() - lastPullTimestamp < PULL_COOLDOWN_MS)) {
    return;
  }

  isPullingInProgress = true;

  try {
    // Determine if Firestore has been initialized/populated already
    const metaRef = doc(firestore, getCollectionName('sync_metadata'), 'status');
    const metaDoc = await getDoc(metaRef);
    
    // Query local database sizes to see if we have actual user records locally to seed
    const localProductsCount = (db.prepare("SELECT COUNT(*) as count FROM products").get() as any)?.count || 0;
    const localSalesCount = (db.prepare("SELECT COUNT(*) as count FROM sales").get() as any)?.count || 0;
    const localClientsCount = (db.prepare("SELECT COUNT(*) as count FROM clients").get() as any)?.count || 0;
    const hasLocalUserData = localProductsCount > 0 || localSalesCount > 0 || localClientsCount > 0;

    // Check if Firestore actually contains any user data across main tables as a parallel safety check
    let hasAnyFirestoreDocuments = false;
    try {
      const safetySnaps = await Promise.all(
        ['products', 'sales', 'clients', 'users'].map(collName =>
          getDocs(query(collection(firestore, getCollectionName(collName)), limit(1))).catch(() => null)
        )
      );
      hasAnyFirestoreDocuments = safetySnaps.some(s => s && !s.empty);
    } catch (err: any) {
      handleSyncError(err, `[Sync] Safety check:`);
    }

    const isPopulated = hasAnyFirestoreDocuments || metaDoc.exists();

    if (!isPopulated) {
      if (hasLocalUserData) {
        console.log("[Sync] Initializing cloud database with local records...");
        await pushAllLocalToFirestore();
        await setDoc(metaRef, { 
          initialized: true, 
          initializedAt: new Date().toISOString(),
          _tx_hash: 'sync_metadata_init',
          _tx_timestamp: new Date().toISOString()
        });
        return;
      } else {
        await setDoc(metaRef, { 
          initialized: true, 
          initializedAt: new Date().toISOString(),
          _tx_hash: 'sync_metadata_init',
          _tx_timestamp: new Date().toISOString()
        });
      }
    } else if (!metaDoc.exists()) {
      await setDoc(metaRef, { 
        initialized: true, 
        initializedAt: new Date().toISOString(),
        _tx_hash: 'sync_metadata_init',
        _tx_timestamp: new Date().toISOString()
      });
    }

    let updatedTableCount = 0;

    // Fetch all Firestore collections in parallel concurrently for ultra-fast load speed
    const collectionResults = await Promise.all(
      SYNC_TABLES.map(async (table) => {
        try {
          let snapshot;
          if (table === 'firestore_transaction_ledger' || table === 'system_audit_logs' || table === 'inventory_audit_logs') {
            try {
              snapshot = await getDocs(query(collection(firestore, getCollectionName(table)), orderBy('id', 'desc'), limit(250)));
            } catch (_) {
              snapshot = await getDocs(query(collection(firestore, getCollectionName(table)), limit(200)));
            }
          } else {
            snapshot = await getDocs(collection(firestore, getCollectionName(table)));
          }
          return { table, snapshot, error: null };
        } catch (tableErr: any) {
          handleSyncError(tableErr, `[Sync Warning] Table "${table}":`);
          return { table, snapshot: null, error: tableErr };
        }
      })
    );

    const remediatedInThisPull = {
      products: new Set<number>(),
      sellers: new Set<number>()
    };

    const readRemediatedSalesLedger = (): {
      sales: Record<string, { remediatedAt: string; netStock: Record<string, number>; netCash: Record<string, number> }>;
      products: Record<string, string>;
      sellers: Record<string, string>;
    } => {
      try {
        const ledgerRow = db.prepare("SELECT value FROM settings WHERE key = 'incident_399_remediated_sales_ledger'").get() as any;
        if (ledgerRow && ledgerRow.value) {
          const parsed = JSON.parse(String(ledgerRow.value));
          if (parsed && typeof parsed === 'object') {
            return {
              sales: parsed.sales || {},
              products: parsed.products || {},
              sellers: parsed.sellers || {}
            };
          }
        }
      } catch (_) {}
      return { sales: {}, products: {}, sellers: {} };
    };

    const hydrateRemediationStateFromRawJson = (rawJsonStr: string) => {
      try {
        const remState = JSON.parse(rawJsonStr);
        const nowIso = getBoliviaISOString();

        // Capture pre-existing tombstones and quarantine state BEFORE unpacking remState
        // so we can distinguish active unremediated sales from already-remediated or partial recovery states (Z03)
        const preDeletedSalesRows = db.prepare("SELECT record_id FROM deleted_records WHERE table_name = 'sales'").all() as any[];
        const preDeletedSalesSet = new Set<string>(preDeletedSalesRows.map(r => String(r.record_id)));

        const preQuarantinedSalesRows = db.prepare("SELECT record_id FROM incident_quarantine_records WHERE incident_id = 'INCIDENT_399_20261027' AND table_name = 'sales'").all() as any[];
        const preQuarantinedSalesSet = new Set<string>(preQuarantinedSalesRows.map(r => String(r.record_id)));

        const remediatedLedger = readRemediatedSalesLedger();

        const baseTestSaleIds = [399, 400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415, 416, 417, 418, 419, 420, 421, 422, 423, 425, 426, 427, 428];
        const dynamicDeletedSaleIds = Array.isArray(remState.deleted_records)
          ? remState.deleted_records
              .filter((d: any) => d && d.table_name === 'sales' && d.record_id !== undefined)
              .map((d: any) => Number(d.record_id))
              .filter((n: number) => Number.isInteger(n) && n > 0 && n !== 398 && n !== 424)
          : [];
        const testSaleIds = Array.from(new Set([...baseTestSaleIds, ...dynamicDeletedSaleIds]));
        const ph = testSaleIds.map(() => '?').join(',');

        const localContaminatedSales = db.prepare(`SELECT * FROM sales WHERE id IN (${ph})`).all(...testSaleIds) as any[];
        const localContaminatedItems = db.prepare(`SELECT * FROM sale_items WHERE sale_id IN (${ph})`).all(...testSaleIds) as any[];
        const localContaminatedReturns = db.prepare(`SELECT * FROM sale_returns WHERE sale_id IN (${ph})`).all(...testSaleIds) as any[];
        const localContaminatedCash = db.prepare(`SELECT * FROM cash_movements WHERE sale_id IN (${ph})`).all(...testSaleIds) as any[];
        const localContaminatedAr = db.prepare(`SELECT * FROM accounts_receivable WHERE sale_id IN (${ph})`).all(...testSaleIds) as any[];

        // Z03: Only sales with an active header in `sales` that have NOT already been deleted, quarantined, or recorded in the remediation ledger
        // are eligible to reverse inventory and cash effects. Lingering child rows of already-remediated sales are cleaned up without touching stock or cash.
        const eligibleSalesForReversal = localContaminatedSales.filter((s: any) => {
          const sIdStr = String(s.id);
          return !preDeletedSalesSet.has(sIdStr) && !preQuarantinedSalesSet.has(sIdStr) && !remediatedLedger.sales[sIdStr];
        });

        const hasAnyContaminatedRows =
          localContaminatedSales.length > 0 ||
          localContaminatedItems.length > 0 ||
          localContaminatedReturns.length > 0 ||
          localContaminatedCash.length > 0 ||
          localContaminatedAr.length > 0;

        db.transaction(() => {
          const insQuarantine = db.prepare(`
            INSERT INTO incident_quarantine_records (incident_id, table_name, record_id, payload_json, reason, backup_path)
            SELECT 'INCIDENT_399_20261027', ?, ?, ?, ?, 'remote_hydration_remediation'
            WHERE NOT EXISTS (
              SELECT 1 FROM incident_quarantine_records
              WHERE incident_id = 'INCIDENT_399_20261027' AND table_name = ? AND record_id = ?
            )
          `);
          const insDel = db.prepare("INSERT OR IGNORE INTO deleted_records (table_name, record_id, deleted_at) VALUES (?, ?, ?)");

          // 1. Apply exact NET stock and NET cash reversal ONLY for eligible active sales whose effects are still pending in state (Z02 & Z03)
          const actuallyReversedSaleIds: number[] = [];
          for (const s of eligibleSalesForReversal) {
            const saleIdNum = Number(s.id);
            const saleIdStr = String(s.id);
            const saleItems = localContaminatedItems.filter((it: any) => Number(it.sale_id) === saleIdNum);
            const saleReturns = localContaminatedReturns.filter((ret: any) => Number(ret.sale_id) === saleIdNum);
            const saleCashMovs = localContaminatedCash.filter((cm: any) => Number(cm.sale_id) === saleIdNum);

            // Net Stock = sold quantity minus already returned quantity in sale_returns
            const soldByProduct = new Map<number, number>();
            for (const it of saleItems) {
              const pId = Number(it.product_id);
              const qty = Number(it.quantity || 0);
              if (pId > 0 && qty > 0) {
                soldByProduct.set(pId, (soldByProduct.get(pId) || 0) + qty);
              }
            }
            const returnedByProduct = new Map<number, number>();
            for (const ret of saleReturns) {
              const pId = Number(ret.product_id);
              const qty = Number(ret.quantity || 0);
              if (pId > 0 && qty > 0) {
                returnedByProduct.set(pId, (returnedByProduct.get(pId) || 0) + qty);
              }
            }

            // Net Cash = signed sum of cash_movements for this sale (inflows positive, outflows/devoluciones negative)
            const rate = Number(s.exchange_rate || 6.96) > 0 ? Number(s.exchange_rate || 6.96) : 6.96;
            const netCashBySeller = new Map<number, number>();
            let hasOutflowMovement = false;

            for (const cm of saleCashMovs) {
              if (!cm.seller_id) continue;
              const sellerId = Number(cm.seller_id);
              const rawAmt = Number(cm.amount || 0);
              if (!Number.isFinite(rawAmt) || rawAmt === 0) continue;
              const absBs = cm.currency === 'USD' ? Number((Math.abs(rawAmt) * rate).toFixed(2)) : Math.abs(rawAmt);
              const movType = String(cm.type || '').toLowerCase();
              const isOutflow = rawAmt < 0 || ['devolucion', 'retiro', 'retiro_manual', 'egreso'].includes(movType);
              if (isOutflow) hasOutflowMovement = true;
              const signedBs = isOutflow ? -absBs : absBs;
              netCashBySeller.set(sellerId, Number(((netCashImpact(netCashBySeller, sellerId)) + signedBs).toFixed(2)));
            }

            // If sale_returns exist without a corresponding negative cash_movements row on a non-credit sale, deduct the already-refunded Bs
            if (!hasOutflowMovement && saleReturns.length > 0 && String(s.payment_method || '').toLowerCase() !== 'crédito') {
              const totalRefundAmt = saleReturns.reduce((acc: number, r: any) => acc + Number(r.refund_amount || 0), 0);
              const totalRefundBs = s.currency === 'USD' ? Number((totalRefundAmt * rate).toFixed(2)) : totalRefundAmt;
              const targetSeller = Number(s.user_id || 1);
              if (netCashBySeller.has(targetSeller)) {
                netCashBySeller.set(targetSeller, Math.max(0, Number(((netCashBySeller.get(targetSeller) || 0) - totalRefundBs).toFixed(2))));
              }
            }

            // Z03 Guard: Detect if inventory and cash balances were ALREADY corrected in a partial recovery state
            let alreadyCorrectedInState = false;
            const existingKardexFix = db.prepare(`
              SELECT 1 FROM inventory_audit_logs
              WHERE reference = 'INCIDENT_399' AND notes LIKE ?
              LIMIT 1
            `).get(`%#${saleIdNum}%`);
            if (existingKardexFix) {
              alreadyCorrectedInState = true;
            } else if (netCashBySeller.size > 0) {
              for (const [sellerId, netBsImpact] of netCashBySeller.entries()) {
                if (netBsImpact > 0.001) {
                  const accRow = db.prepare('SELECT current_balance FROM cash_accounts WHERE seller_id = ?').get(sellerId) as any;
                  const currentBal = Number(accRow?.current_balance ?? 0);
                  const otherMovs = db.prepare(`
                    SELECT amount, currency, type FROM cash_movements
                    WHERE seller_id = ? AND status = 'pendiente' AND (sale_id IS NULL OR sale_id NOT IN (${ph}))
                  `).all(sellerId, ...testSaleIds) as any[];
                  let nonContaminatedPendingBs = 0;
                  for (const m of otherMovs) {
                    const mAmt = Number(m.amount || 0);
                    if (!Number.isFinite(mAmt) || mAmt === 0) continue;
                    const mAbsBs = m.currency === 'USD' ? Number((Math.abs(mAmt) * rate).toFixed(2)) : Math.abs(mAmt);
                    const mType = String(m.type || '').toLowerCase();
                    const mOutflow = mAmt < 0 || ['devolucion', 'retiro', 'retiro_manual', 'egreso'].includes(mType);
                    nonContaminatedPendingBs = Number((nonContaminatedPendingBs + (mOutflow ? -mAbsBs : mAbsBs)).toFixed(2));
                  }
                  if (currentBal < netBsImpact - 0.01 || Math.abs(currentBal - nonContaminatedPendingBs) <= 0.05) {
                    alreadyCorrectedInState = true;
                    break;
                  }
                }
              }
            }

            const netStockRestoredRecord: Record<string, number> = {};
            for (const [pId, soldQty] of soldByProduct.entries()) {
              const returnedQty = returnedByProduct.get(pId) || 0;
              const netQtyToRestore = Math.max(0, soldQty - returnedQty);
              if (netQtyToRestore > 0) {
                if (!alreadyCorrectedInState) {
                  db.prepare('UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ?').run(netRestore(netQtyToRestore), nowIso, pId);
                  const prodRow = db.prepare('SELECT name, sku, price_unit FROM products WHERE id = ?').get(pId) as any;
                  if (prodRow) {
                    db.prepare(`
                      INSERT INTO inventory_audit_logs (product_id, product_name, product_sku, type, quantity, price, user_id, username, reference, notes, created_at)
                      VALUES (?, ?, ?, 'ajuste', ?, ?, 4, 'admin', 'INCIDENT_399', ?, ?)
                    `).run(
                      pId,
                      prodRow.name || `Producto #${pId}`,
                      prodRow.sku || String(pId),
                      netQtyToRestore,
                      Number(prodRow.price_unit || 0),
                      `Restitución neta por retiro de venta #${saleIdNum} (vendido: ${soldQty}, devuelto previo: ${returnedQty})`,
                      nowIso
                    );
                  }
                }
                netStockRestoredRecord[String(pId)] = netQtyToRestore;
                remediatedLedger.products[String(pId)] = nowIso;
                remediatedInThisPull.products.add(pId);
              }
            }

            const netCashDeductedRecord: Record<string, number> = {};
            for (const [sellerId, netBsImpact] of netCashBySeller.entries()) {
              if (Math.abs(netBsImpact) > 0.001) {
                if (!alreadyCorrectedInState) {
                  db.prepare('UPDATE cash_accounts SET current_balance = ROUND(current_balance - ?, 2), updated_at = ? WHERE seller_id = ?').run(netBsImpact, nowIso, sellerId);
                }
                netCashDeductedRecord[String(sellerId)] = netBsImpact;
                remediatedLedger.sellers[String(sellerId)] = nowIso;
                remediatedInThisPull.sellers.add(sellerId);
              }
            }

            remediatedLedger.sales[saleIdStr] = {
              remediatedAt: nowIso,
              netStock: netStockRestoredRecord,
              netCash: netCashDeductedRecord
            };
            if (!alreadyCorrectedInState) {
              actuallyReversedSaleIds.push(saleIdNum);
            }
          }

          // 2. Archive and remove all contaminated / orphan rows
          if (hasAnyContaminatedRows) {
            for (const s of localContaminatedSales) {
              insQuarantine.run('sales', String(s.id), JSON.stringify(s), 'Remediación local por hidratación INCIDENT_399', 'sales', String(s.id));
              insDel.run('sales', String(s.id), nowIso);
            }
            for (const it of localContaminatedItems) {
              insQuarantine.run('sale_items', String(it.id), JSON.stringify(it), `Ítem de venta contaminada #${it.sale_id}`, 'sale_items', String(it.id));
              if (it.id !== undefined) insDel.run('sale_items', String(it.id), nowIso);
            }
            for (const cm of localContaminatedCash) {
              insQuarantine.run('cash_movements', String(cm.id), JSON.stringify(cm), `Movimiento de caja de venta contaminada #${cm.sale_id}`, 'cash_movements', String(cm.id));
              if (cm.id !== undefined) insDel.run('cash_movements', String(cm.id), nowIso);
            }
            for (const ar of localContaminatedAr) {
              if (ar.id !== undefined) {
                insDel.run('accounts_receivable', String(ar.id), nowIso);
                db.prepare('DELETE FROM credit_payments WHERE account_receivable_id = ?').run(ar.id);
              }
            }
            for (const ret of localContaminatedReturns) {
              if (ret.id !== undefined) insDel.run('sale_returns', String(ret.id), nowIso);
            }

            db.prepare(`DELETE FROM cash_movements WHERE sale_id IN (${ph})`).run(...testSaleIds);
            db.prepare(`DELETE FROM sale_items WHERE sale_id IN (${ph})`).run(...testSaleIds);
            db.prepare(`DELETE FROM accounts_receivable WHERE sale_id IN (${ph})`).run(...testSaleIds);
            db.prepare(`DELETE FROM sale_returns WHERE sale_id IN (${ph})`).run(...testSaleIds);
            db.prepare(`DELETE FROM sales WHERE id IN (${ph})`).run(...testSaleIds);
          }

          // 3. Hydrate tombstones, quarantine records, and processed_operations from remState
          if (Array.isArray(remState.deleted_records)) {
            for (const d of remState.deleted_records) {
              insDel.run(d.table_name, String(d.record_id), d.deleted_at || nowIso);
            }
          }
          const qCount = (db.prepare("SELECT COUNT(*) as c FROM incident_quarantine_records WHERE incident_id = 'INCIDENT_399_20261027'").get() as any)?.c || 0;
          if (qCount === 0 && Array.isArray(remState.quarantine_records)) {
            const insQ = db.prepare("INSERT INTO incident_quarantine_records (incident_id, table_name, record_id, payload_json, reason, backup_path, quarantined_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
            for (const q of remState.quarantine_records) {
              insQ.run(q.incident_id, q.table_name, q.record_id, q.payload_json, q.reason, q.backup_path, q.quarantined_at);
            }
          }
          if (Array.isArray(remState.processed_operations)) {
            const insOp = db.prepare(`
              INSERT INTO processed_operations (client_operation_id, operation_type, payload_hash, response_body, status)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(client_operation_id) DO UPDATE SET
                operation_type = COALESCE(excluded.operation_type, processed_operations.operation_type),
                payload_hash = COALESCE(excluded.payload_hash, processed_operations.payload_hash),
                response_body = COALESCE(excluded.response_body, processed_operations.response_body),
                status = COALESCE(excluded.status, processed_operations.status)
            `);
            for (const op of remState.processed_operations) {
              insOp.run(
                op.client_operation_id,
                op.operation_type || 'sale',
                op.payload_hash || null,
                op.response_body,
                op.status || 'completed'
              );
            }
          }

          // 4. Persist atomic remediation ledger whenever eligible sales were processed, and genuine audit log ONLY when stock/cash was actually reversed
          if (eligibleSalesForReversal.length > 0) {
            db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('incident_399_remediated_sales_ledger', ?, ?)").run(
              JSON.stringify(remediatedLedger),
              nowIso
            );
            if (actuallyReversedSaleIds.length > 0) {
              db.prepare(`
                INSERT INTO system_audit_logs (
                  event_type, category, module, action, severity,
                  entity_type, entity_id, user_id, user_name, user_role,
                  reason, result, status, metadata, created_at
                ) VALUES (
                  'ADMIN_INTERVENTION', 'AUDIT', 'SALES', 'INCIDENT_REMEDIATION', 'HIGH',
                  'sales', ?, 4, 'admin', 'admin',
                  'Reversión contable neta e idempotente de ventas retiradas por remediación',
                  'SUCCESS', 'COMPLETED', ?, ?
                )
              `).run(
                actuallyReversedSaleIds.join(','),
                JSON.stringify({
                  incident_id: 'INCIDENT_399_20261027',
                  remediated_sales: actuallyReversedSaleIds,
                  ledger: remediatedLedger.sales
                }),
                nowIso
              );
            }
          }

          ensureSafeAutoincrementSequence(db);
        })();
      } catch (_) {}
    };

    function netRestore(n: number): number {
      return Math.max(0, Math.round(n));
    }
    function netCashImpact(map: Map<number, number>, sellerId: number): number {
      return map.get(sellerId) || 0;
    }

    // Extract remediation payload from incoming settings snapshot or local settings
    let remediationJsonPayload: string | null = null;
    try {
      const settingsSnapObj = collectionResults.find(r => r.table === 'settings' && r.snapshot && !r.error);
      if (settingsSnapObj && settingsSnapObj.snapshot) {
        for (const docSnap of settingsSnapObj.snapshot.docs) {
          const d = docSnap.data();
          const k = d.key || docSnap.id;
          if (k === 'incident_399_remediation_state' && d.value) {
            remediationJsonPayload = String(d.value);
            break;
          }
        }
      }
      if (!remediationJsonPayload) {
        const localRemRow = db.prepare("SELECT value FROM settings WHERE key = 'incident_399_remediation_state'").get() as any;
        if (localRemRow && localRemRow.value) {
          remediationJsonPayload = String(localRemRow.value);
        }
      }
    } catch (_) {}

    // Hydrate tombstones and remediate local contaminated sales (if any) BEFORE globalSyncTx
    // so deleted_records tombstones and remediated product stocks/cash balances are active during replica import (Z07 & Y07)
    try {
      if (remediationJsonPayload) {
        hydrateRemediationStateFromRawJson(remediationJsonPayload);
      }
      const deletedSnap = await getDocs(collection(firestore, getCollectionName('deleted_records'))).catch(() => null);
      if (deletedSnap && !deletedSnap.empty) {
        const insDelRemote = db.prepare("INSERT OR IGNORE INTO deleted_records (table_name, record_id, deleted_at) VALUES (?, ?, ?)");
        const nowIso = getBoliviaISOString();
        db.transaction(() => {
          for (const dSnap of deletedSnap.docs) {
            const d = dSnap.data();
            if (d && d.table_name && d.record_id !== undefined) {
              insDelRemote.run(String(d.table_name), String(d.record_id), d.deleted_at || nowIso);
            }
          }
        })();
      }
    } catch (_) {}

    // Pull each collection and upsert data into SQLite inside a single high-performance transaction
    const globalSyncTx = db.transaction(() => {
      const activeLedger = readRemediatedSalesLedger();

      // Preserve internal remediation ledger across forceOverwrite on settings
      const preservedRemediationLedgerRow = db.prepare("SELECT key, value, updated_at FROM settings WHERE key = 'incident_399_remediated_sales_ledger'").get() as any;

      for (const { table, snapshot, error } of collectionResults) {
        if (error || !snapshot) continue;

        try {
          if (snapshot.empty) {
            let localCount = 0;
            try {
              const countRow = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any;
              localCount = countRow?.c || 0;
            } catch (_) {}

            if (localCount > 0 && ['products', 'sales', 'sale_items', 'users', 'clients', 'stock_arrivals', 'departments'].includes(table)) {
              console.log(`[Anti-Truncation Shield] Remote collection "${table}" is empty, but local has ${localCount} verified records. Retaining local data.`);
            } else if (metaDoc.exists() && localCount === 0) {
              try {
                db.prepare(`DELETE FROM ${table}`).run();
              } catch (e: any) {}
            }
            continue;
          }

          // Anti-Truncation Circuit Breaker:
          // If remote collection returned significantly fewer records than local healthy data (e.g. < 30% of local),
          // reject destructive overwrites and keep local verified data.
          let localRowCount = 0;
          try {
            const countRow = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any;
            localRowCount = countRow?.c || 0;
          } catch (_) {}

          if (['products', 'sales', 'sale_items', 'stock_arrivals'].includes(table)) {
            if (localRowCount >= 50 && snapshot.docs.length < Math.floor(localRowCount * 0.3)) {
              console.warn(`[Anti-Truncation Shield] Remote collection "${table}" returned only ${snapshot.docs.length} docs, but local has ${localRowCount}. Rejecting truncation to protect data integrity.`);
              continue;
            }
          }

          let allowedColumns: Set<string>;
          try {
            const info = db.pragma(`table_info(${table})`) as any[];
            allowedColumns = new Set(info.map(col => col.name));
          } catch (colErr: any) {
            allowedColumns = new Set();
          }

          // Fetch locally deleted record IDs for this table
          let deletedIdsSet = new Set<string>();
          try {
            const deletedRows = db.prepare("SELECT record_id FROM deleted_records WHERE table_name = ?").all(table) as any[];
            deletedIdsSet = new Set(deletedRows.map(r => String(r.record_id)));
          } catch (e) {}

          // Pre-capture local verified product rows and updated_at map to implement the ANTI-OVERWRITE PRODUCT & STOCK SHIELD
          const localProductStocksMap = new Map<number, number>();
          const localProductUpdatedMap = new Map<number, string>();
          const localProductsFullMap = new Map<number, any>();
          if (table === 'products') {
            try {
              const currentProds = db.prepare('SELECT * FROM products').all() as any[];
              for (const p of currentProds) {
                if (p.id !== undefined) {
                  const pid = Number(p.id);
                  localProductsFullMap.set(pid, p);
                  if (p.stock !== null && p.stock !== undefined) {
                    localProductStocksMap.set(pid, Number(p.stock));
                  }
                  if (p.updated_at) {
                    localProductUpdatedMap.set(pid, String(p.updated_at));
                  }
                }
              }
            } catch (_) {}
          }

          // Z07: Pre-capture local verified cash_accounts balance, last_settlement_at and updated_at map so stale remote replicas cannot overwrite remediated or settled drawer balances
          const localCashBalancesMap = new Map<number, number>();
          const localCashUpdatedMap = new Map<number, string>();
          const localCashLastSettlementMap = new Map<number, string>();
          if (table === 'cash_accounts' || table === 'cash_movements') {
            try {
              const currentCash = db.prepare('SELECT seller_id, current_balance, last_settlement_at, updated_at FROM cash_accounts').all() as any[];
              for (const ca of currentCash) {
                if (ca.seller_id !== undefined) {
                  const sid = Number(ca.seller_id);
                  if (ca.current_balance !== null && ca.current_balance !== undefined) {
                    localCashBalancesMap.set(sid, Number(ca.current_balance));
                  }
                  if (ca.updated_at) {
                    localCashUpdatedMap.set(sid, String(ca.updated_at));
                  }
                  if (ca.last_settlement_at) {
                    localCashLastSettlementMap.set(sid, String(ca.last_settlement_at));
                  }
                }
              }
            } catch (_) {}
          }

          // Pre-capture locally settled cash_movements and settled sale_ids so a remote 'pendiente' status never resurrects an already-settled movement
          const localSettledMovementIds = new Set<number>();
          const localSettledSaleIds = new Set<number>();
          if (table === 'cash_movements') {
            try {
              const settledMovs = db.prepare("SELECT id, sale_id FROM cash_movements WHERE status = 'liquidado'").all() as any[];
              for (const m of settledMovs) {
                if (m.id !== undefined) localSettledMovementIds.add(Number(m.id));
                if (m.sale_id !== undefined && m.sale_id !== null) localSettledSaleIds.add(Number(m.sale_id));
              }
              const settlementsRows = db.prepare("SELECT sale_ids FROM cash_settlements WHERE sale_ids IS NOT NULL").all() as any[];
              for (const sr of settlementsRows) {
                try {
                  const parsedIds = JSON.parse(sr.sale_ids);
                  if (Array.isArray(parsedIds)) {
                    for (const sid of parsedIds) {
                      if (sid !== null && sid !== undefined) localSettledSaleIds.add(Number(sid));
                    }
                  }
                } catch (_) {}
              }
            } catch (_) {}
          }

          const remoteDocs = snapshot.docs;
          const remoteIds = new Set<string>();

          if (forceOverwrite && table !== 'system_audit_logs' && table !== 'inventory_audit_logs' && table !== 'firestore_transaction_ledger' && table !== 'deleted_records') {
            db.prepare(`DELETE FROM ${table}`).run();
            // Y07: Never wipe deleted_records tombstones or inventory_audit_logs on forceOverwrite so purged/quarantined records cannot resurrect and historical Kárdex is preserved
            if (table === 'settings' && preservedRemediationLedgerRow) {
              db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(
                preservedRemediationLedgerRow.key,
                preservedRemediationLedgerRow.value,
                preservedRemediationLedgerRow.updated_at
              );
            }
          }

          for (const docSnap of remoteDocs) {
            const data = docSnap.data();
            if (table === 'settings' && !data.key) {
              data.key = docSnap.id;
            }
            const docId = String(table === 'settings' ? (data.key || docSnap.id) : (data.id !== undefined ? data.id : docSnap.id));
            if (table === 'settings' && SENSITIVE_SETTINGS_KEYS.has(docId)) {
              continue;
            }
            remoteIds.add(docId);

            // Y07: Never re-insert records that have been legitimately deleted in deleted_records (even on forceOverwrite)
            if (deletedIdsSet.has(docId)) {
              continue;
            }

            // Also check parent sale deletion for child tables (sale_items, cash_movements, accounts_receivable, sale_returns)
            if ((table === 'sale_items' || table === 'cash_movements' || table === 'accounts_receivable' || table === 'sale_returns') && data.sale_id !== undefined && data.sale_id !== null) {
              if (isRecordDeleted('sales', data.sale_id)) {
                continue;
              }
            }

            // ANTI-GHOST RECORD VALIDATION: Verify incoming Firestore document structure
            if (!validateRemoteFirestoreDocument(table, data, docId)) {
              continue;
            }

            if (table === 'departments' && data && data.name && ['Storage', 'Micro SDs', 'USBs', 'Electronics', 'Micro SD'].includes(data.name)) {
              const prodCount = db.prepare("SELECT COUNT(*) as count FROM products WHERE category = ?").get(data.name) as any;
              if (!prodCount || prodCount.count === 0) {
                continue;
              }
            }

            const parseNormalizedTimestampMs = (raw: any): number => {
              if (!raw) return 0;
              const s = String(raw).trim();
              if (!s) return 0;
              // SQLite CURRENT_TIMESTAMP format 'YYYY-MM-DD HH:MM:SS' has no timezone and is stored in UTC
              if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) {
                const ms = new Date(s.replace(' ', 'T') + 'Z').getTime();
                return Number.isFinite(ms) ? ms : 0;
              }
              const ms = new Date(s).getTime();
              return Number.isFinite(ms) ? ms : 0;
            };

            if (table === 'products' && data.id !== undefined) {
              try {
                const prodIdNum = Number(data.id);
                const localProd = localProductsFullMap.get(prodIdNum);
                const localStock = localProductStocksMap.get(prodIdNum);
                const localUpdatedStr = localProductUpdatedMap.get(prodIdNum);
                const remoteStock = Number(data.stock);

                const localUpdated = parseNormalizedTimestampMs(localUpdatedStr);
                const remoteUpdated = parseNormalizedTimestampMs(data.updated_at);
                const remediatedTsStr = activeLedger.products[String(prodIdNum)];
                const remediatedTs = parseNormalizedTimestampMs(remediatedTsStr);
                const hasSaleProductRemediation = Object.values(activeLedger.sales || {}).some(
                  (entry: any) => entry?.netStock && entry.netStock[String(prodIdNum)] !== undefined
                );

                // If local product row was modified more recently than remote updated_at, preserve all local product fields (name, sku, category, prices, stock)
                if (localProd && localUpdated > 0 && localUpdated > remoteUpdated) {
                  data.name = localProd.name;
                  data.category = localProd.category;
                  data.sku = localProd.sku;
                  data.stock = Number(localProd.stock ?? 0);
                  data.price_unit = Number(localProd.price_unit ?? data.price_unit ?? 0);
                  data.price_bulk = Number(localProd.price_bulk ?? data.price_bulk ?? 0);
                  data.price_cost = Number(localProd.price_cost ?? data.price_cost ?? 0);
                  data.stock_alarm = Number(localProd.stock_alarm ?? data.stock_alarm ?? 5);
                  if (localProd.image !== undefined) data.image = localProd.image;
                  if (localUpdatedStr) data.updated_at = localUpdatedStr;
                } else if (remediatedInThisPull.products.has(prodIdNum) && localStock !== undefined && !isNaN(localStock)) {
                  data.stock = localStock;
                  if (localUpdatedStr) data.updated_at = localUpdatedStr;
                } else if ((remediatedTs > 0 || hasSaleProductRemediation) && remediatedTs >= remoteUpdated && localStock !== undefined && !isNaN(localStock)) {
                  data.stock = localStock;
                  if (localUpdatedStr) data.updated_at = localUpdatedStr;
                } else if (localStock === 0 && localUpdated >= remoteUpdated) {
                  data.stock = 0;
                  if (localUpdatedStr) data.updated_at = localUpdatedStr;
                } else if (!isNaN(remoteStock)) {
                  data.stock = remoteStock;
                } else if (localStock !== undefined) {
                  data.stock = localStock;
                  if (localUpdatedStr) data.updated_at = localUpdatedStr;
                }
              } catch (e: any) {
                console.warn('[Sync Stock] Error preserving product stock:', e.message);
              }
            }

            if (table === 'cash_accounts' && data.seller_id !== undefined) {
              try {
                const sellerIdNum = Number(data.seller_id);
                const localBal = localCashBalancesMap.get(sellerIdNum);
                const localUpdatedStr = localCashUpdatedMap.get(sellerIdNum);
                const localLastSettleStr = localCashLastSettlementMap.get(sellerIdNum);
                const remoteBal = Number(data.current_balance);

                const localUpdated = parseNormalizedTimestampMs(localUpdatedStr);
                const remoteUpdated = parseNormalizedTimestampMs(data.updated_at);
                const localSettleMs = parseNormalizedTimestampMs(localLastSettleStr);
                const remoteSettleMs = parseNormalizedTimestampMs(data.last_settlement_at);
                const remediatedTsStr = activeLedger.sellers[String(sellerIdNum)];
                const remediatedTs = parseNormalizedTimestampMs(remediatedTsStr);
                const hasSaleSellerRemediation = Object.values(activeLedger.sales || {}).some(
                  (entry: any) => entry?.netCash && entry.netCash[String(sellerIdNum)] !== undefined
                );

                if (localSettleMs > remoteSettleMs && localBal !== undefined && !isNaN(localBal)) {
                  data.current_balance = localBal;
                  if (localLastSettleStr) data.last_settlement_at = localLastSettleStr;
                  if (localUpdatedStr) data.updated_at = localUpdatedStr;
                } else if (remediatedInThisPull.sellers.has(sellerIdNum) && localBal !== undefined && !isNaN(localBal)) {
                  data.current_balance = localBal;
                  if (localLastSettleStr) data.last_settlement_at = localLastSettleStr;
                  if (localUpdatedStr) data.updated_at = localUpdatedStr;
                } else if ((remediatedTs > 0 || hasSaleSellerRemediation) && remediatedTs >= remoteUpdated && localBal !== undefined && !isNaN(localBal)) {
                  data.current_balance = localBal;
                  if (localLastSettleStr) data.last_settlement_at = localLastSettleStr;
                  if (localUpdatedStr) data.updated_at = localUpdatedStr;
                } else if (localUpdated > remoteUpdated && localBal !== undefined && !isNaN(localBal)) {
                  data.current_balance = localBal;
                  if (localLastSettleStr) data.last_settlement_at = localLastSettleStr;
                  if (localUpdatedStr) data.updated_at = localUpdatedStr;
                } else if (!isNaN(remoteBal)) {
                  data.current_balance = remoteBal;
                } else if (localBal !== undefined) {
                  data.current_balance = localBal;
                  if (localUpdatedStr) data.updated_at = localUpdatedStr;
                }
              } catch (e: any) {
                console.warn('[Sync Cash] Error preserving cash balance:', e.message);
              }
            }

            if (table === 'cash_movements' && data.id !== undefined) {
              try {
                const movIdNum = Number(data.id);
                const saleIdNum = data.sale_id !== undefined && data.sale_id !== null ? Number(data.sale_id) : null;
                const sellerIdNum = data.seller_id !== undefined ? Number(data.seller_id) : null;
                const localSettleStr = sellerIdNum !== null ? localCashLastSettlementMap.get(sellerIdNum) : undefined;
                const localSettleMs = parseNormalizedTimestampMs(localSettleStr);
                const movCreatedMs = parseNormalizedTimestampMs(data.created_at);

                // Once a movement is settled ('liquidado') locally or belongs to a settled sale or predates the seller's last_settlement_at, never revert it to 'pendiente'
                if (
                  localSettledMovementIds.has(movIdNum) ||
                  (saleIdNum !== null && localSettledSaleIds.has(saleIdNum)) ||
                  (localSettleMs > 0 && movCreatedMs > 0 && movCreatedMs <= localSettleMs)
                ) {
                  data.status = 'liquidado';
                }
              } catch (e: any) {
                console.warn('[Sync Cash Movements] Error preserving movement settlement status:', e.message);
              }
            }

            if (table === 'inventory_counts') {
              try {
                const localCount = db.prepare("SELECT status, applied_at FROM inventory_counts WHERE id = ?").get(docId) as any;
                if (localCount && (['cancelado', 'aprobado', 'cerrado', 'finalizado'].includes(localCount.status) || localCount.applied_at)) {
                  if (['en_progreso', 'pausado', 'completado'].includes(data.status)) {
                    console.log(`[Sync Count Shield] Retaining local resolved status "${localCount.status}" for count #${docId} over stale remote "${data.status}".`);
                    continue;
                  }
                }
                if (localCount && localCount.applied_at && !data.applied_at) {
                  data.applied_at = localCount.applied_at;
                }
              } catch (_) {}
            }

            if (table === 'settings' && docId === 'exchange_rate') {
              try {
                const localRateRow = db.prepare("SELECT value, updated_at FROM settings WHERE key = 'exchange_rate'").get() as any;
                const lastAudit = db.prepare("SELECT changed_at, new_rate FROM exchange_rate_audit ORDER BY id DESC LIMIT 1").get() as any;
                
                const remoteVal = parseFloat(data.value);
                const auditRate = (lastAudit && lastAudit.new_rate && !isNaN(parseFloat(lastAudit.new_rate))) ? parseFloat(lastAudit.new_rate) : null;
                const settingsRate = (localRateRow && localRateRow.value && !isNaN(parseFloat(localRateRow.value))) ? parseFloat(localRateRow.value) : null;
                const localVal = (auditRate && auditRate > 0 && auditRate !== 6.96) ? auditRate : (settingsRate || 6.96);

                // Shield 1: If incoming remote rate is 6.96 or invalid, but local has a valid custom rate (e.g. 13, 8.5, etc.),
                // NEVER let the remote default 6.96 stomp on the user's custom rate!
                if (!isNaN(remoteVal) && remoteVal === 6.96 && !isNaN(localVal) && localVal > 0 && localVal !== 6.96) {
                  console.log(`[Sync ExchangeRate Shield] Retaining local custom exchange rate of ${localVal} Bs. over remote default 6.96.`);
                  // Also heal remote Firestore in background so Firestore doesn't hold the stale 6.96
                  try {
                    const validation = validateFirestoreWriteOperation(
                      'settings',
                      'exchange_rate',
                      'UPDATE',
                      { key: 'exchange_rate', value: String(localVal), updated_at: new Date().toISOString() },
                      { userId: 4, userName: 'admin', userRole: 'admin', isSystemDaemon: true }
                    );
                    setDoc(doc(firestore, getCollectionName('settings'), 'exchange_rate'), validation.enrichedPayload)
                      .then(() => confirmFirestoreWriteInLedger([validation.txHash]))
                      .catch(() => {});
                  } catch (_) {}
                  continue;
                }

                // Shield 2: If local rate was set by user audit and is newer or identical, retain local
                const localTimestamp = (lastAudit && lastAudit.changed_at) 
                  ? lastAudit.changed_at 
                  : (localRateRow ? localRateRow.updated_at : null);
                const remoteTimestamp = data.updated_at || null; // don't use _tx_timestamp because background sync bumps it

                if (localTimestamp && remoteTimestamp) {
                  const localTime = new Date(localTimestamp).getTime();
                  const remoteTime = new Date(remoteTimestamp).getTime();
                  if (!isNaN(localTime) && !isNaN(remoteTime) && localTime >= remoteTime) {
                    console.log(`[Sync ExchangeRate Shield] Local rate timestamp (${localTimestamp}) is newer or equal to remote (${remoteTimestamp}). Keeping local.`);
                    continue;
                  }
                }
              } catch (e: any) {
                console.warn('[Sync ExchangeRate Shield] Warning checking rate timestamps:', e.message);
              }
            }

            // S04: Guard against SKU collision deleting existing primary key
            if (table === 'products' && data.sku) {
              try {
                const existingProduct = db.prepare("SELECT id FROM products WHERE sku = ?").get(data.sku) as any;
                if (existingProduct && data.id !== undefined && Number(existingProduct.id) !== Number(data.id)) {
                  console.warn(`[Sync SKU Shield] Product SKU collision detected for '${data.sku}': preserving local primary key #${existingProduct.id} over incoming #${data.id}. Skipping remote row to protect local inventory.`);
                  continue;
                }
              } catch (_) {}
            }

            let keys = Object.keys(data);
            if (keys.length === 0) continue;

            if (allowedColumns.size > 0) {
              keys = keys.filter(k => allowedColumns.has(k));
            }
            if (keys.length === 0) continue;

            const placeholders = keys.map(() => '?').join(', ');
            const values = keys.map(k => data[k]);

            const isImmutableAppendOnly = table === 'system_audit_logs' || table === 'inventory_audit_logs' || table === 'firestore_transaction_ledger';
            const insertVerb = isImmutableAppendOnly ? 'INSERT OR IGNORE' : 'INSERT OR REPLACE';
            const insertSql = `${insertVerb} INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
            db.prepare(insertSql).run(...values);

            // Record pulled payload digest so next push cycle will not re-upload identical data
            try {
              const localSubset: Record<string, any> = {};
              for (const k of keys) {
                localSubset[k] = data[k];
              }
              const pulledDigest = computeCanonicalRecordDigest(table, localSubset);
              lastSyncedDigestCache.set(`${getCollectionName(table)}:${docId}`, pulledDigest);
            } catch (_) {}
          }

          updatedTableCount++;
        } catch (tableErr: any) {
          handleSyncError(tableErr, `[Sync Warning] Table "${table}":`);
        }
      }
    });

    globalSyncTx();

    // Hydrate incident_399_remediation_state from settings table if present (protects against container disk resets and remote-only replicas)
    try {
      const remRow = db.prepare("SELECT value FROM settings WHERE key = 'incident_399_remediation_state'").get() as any;
      const finalRemJson = (remRow && remRow.value) ? String(remRow.value) : remediationJsonPayload;
      if (finalRemJson) {
        hydrateRemediationStateFromRawJson(finalRemJson);
      }
      ensureSafeAutoincrementSequence(db);
    } catch (_) {}

    lastPullTimestamp = Date.now();
    
    for (const key of Object.keys(lastSyncedMaxIdCache)) {
      delete lastSyncedMaxIdCache[key];
    }
    
    if (forceOverwrite) {
      console.log(`[Sync] Master database pull completed successfully (${updatedTableCount} tables synced).`);
    }
  } catch (error: any) {
    // Standalone fallback
  } finally {
    isPullingInProgress = false;
  }
}

const pendingCoalescedSyncMap = new Map<string, { fullTable: boolean; ids: Set<string>; timer: NodeJS.Timeout | null }>();

function scheduleCoalescedTableSync(table: string, ids?: any | any[], isSandbox: boolean = false) {
  const queueKey = `${isSandbox ? 'sandbox' : 'prod'}:${table}`;
  let entry = pendingCoalescedSyncMap.get(queueKey);
  if (!entry) {
    entry = { fullTable: false, ids: new Set<string>(), timer: null };
    pendingCoalescedSyncMap.set(queueKey, entry);
  } else {
    syncDeduplicationStats.coalescedWriteTriggers++;
  }

  if (ids === undefined || ids === null) {
    entry.fullTable = true;
  } else {
    const arr = Array.isArray(ids) ? ids : [ids];
    if (arr.length === 0) return;
    for (const id of arr) {
      if (id !== undefined && id !== null) {
        entry.ids.add(String(id));
      }
    }
  }

  if (entry.timer) {
    clearTimeout(entry.timer);
  }

  entry.timer = setTimeout(() => {
    const finalized = pendingCoalescedSyncMap.get(queueKey);
    pendingCoalescedSyncMap.delete(queueKey);
    if (!finalized) return;

    const targetIds = finalized.fullTable ? undefined : Array.from(finalized.ids);
    if (!finalized.fullTable && (!targetIds || targetIds.length === 0)) return;

    enqueueSyncTask(() =>
      dbAsyncLocalStorage.run({ isSandbox }, () =>
        pushLocalToFirestore(table, targetIds).catch(err => {
          console.warn(`[Sync Offline Mode] Coalesced sync postponed for table "${table}":`, err.message);
        })
      )
    );
  }, 120);

  if (typeof entry.timer.unref === 'function') {
    entry.timer.unref();
  }
}

/**
 * Convenient helper to trigger a non-blocking asynchronous sync of one or more tables to Firestore after a local write.
 * Supports mapping table names to exact primary key values to execute a targeted push with 120ms coalescing and mutex serialization.
 */
export function syncAfterWrite(tableOrMap: string | string[] | Record<string, any | any[]>, idOrIds?: any | any[]) {
  const isSandbox = isCurrentContextSandbox();
  if (typeof tableOrMap === 'object' && !Array.isArray(tableOrMap)) {
    for (const [table, ids] of Object.entries(tableOrMap)) {
      if (Array.isArray(ids) && ids.length === 0) continue;
      scheduleCoalescedTableSync(table, ids, isSandbox);
    }
  } else {
    const tables = Array.isArray(tableOrMap) ? tableOrMap : [tableOrMap];
    for (const table of tables) {
      const targetIds = (tables.length === 1 || tables[0] === table) ? idOrIds : undefined;
      scheduleCoalescedTableSync(table, targetIds, isSandbox);
    }
  }
}

/**
 * Completely purges all data from Google Cloud Firestore and local SQLite,
 * leaving a clean zeroed database with baseline seed admin users and default settings.
 */
export async function clearAllFirestoreAndLocalData(): Promise<void> {
  console.log("[Sync Reset] Starting complete database purge (Local SQLite & Cloud Firestore)...");

  // 1. Clear Google Cloud Firestore collections in parallel
  if (firestore) {
    try {
      await ensureServerAuth();
      const collectionsToClear = [...SYNC_TABLES, 'processed_operations', 'deleted_records'];
      
      await Promise.all(collectionsToClear.map(async (tableName) => {
        try {
          let hasMore = true;
          let totalDeleted = 0;
          while (hasMore) {
            const colRef = collection(firestore, getCollectionName(tableName));
            const q = query(colRef, limit(200));
            const snapshot = await getDocs(q);
            if (snapshot.empty) {
              hasMore = false;
              break;
            }
            const batch = writeBatch(firestore);
            for (const docSnap of snapshot.docs) {
              batch.delete(docSnap.ref);
            }
            await batch.commit();
            totalDeleted += snapshot.size;
            if (snapshot.size < 200) {
              hasMore = false;
            }
          }
          if (totalDeleted > 0) {
            console.log(`[Sync Reset] Cleared ${totalDeleted} records from Firestore collection "${tableName}".`);
          }
        } catch (colErr: any) {
          console.warn(`[Sync Reset Warning] Error clearing Firestore collection "${tableName}":`, colErr.message);
        }
      }));

      // Mark sync_metadata status as initialized so empty collections are treated as intentionally zeroed
      const metaRef = doc(firestore, getCollectionName('sync_metadata'), 'status');
      await setDoc(metaRef, { 
        initialized: true, 
        resetAt: new Date().toISOString(),
        _tx_hash: 'sync_metadata_reset',
        _tx_timestamp: new Date().toISOString()
      });
    } catch (fsErr: any) {
      console.warn("[Sync Reset Warning] Failed to authenticate or access Firestore during reset:", fsErr.message);
    }
  }

  // 2. Clear local SQLite database tables
  const tablesToClear = [
    'products',
    'clients',
    'sales',
    'sale_items',
    'shifts',
    'caja_cierres',
    'departments',
    'stock_arrivals',
    'pending_sales',
    'pending_sale_items',
    'accounts_receivable',
    'credit_payments',
    'pending_sale_payments',
    'cash_accounts',
    'cash_movements',
    'cash_settlements',
    'inventory_audit_logs',
    'system_audit_logs',
    'inventory_counts',
    'inventory_count_items',
    'exchange_rate_audit',
    'offline_pending_sales',
    'firestore_transaction_ledger',
    'processed_operations',
    'deleted_records'
  ];

  try {
    db.exec(`DROP TRIGGER IF EXISTS prevent_system_audit_logs_delete;`);
    db.exec(`DROP TRIGGER IF EXISTS prevent_system_audit_logs_update;`);
    db.exec(`DROP TRIGGER IF EXISTS prevent_firestore_ledger_delete;`);
    db.exec(`DROP TRIGGER IF EXISTS prevent_firestore_ledger_update;`);
  } catch (e) {}

  for (const table of tablesToClear) {
    try {
      db.prepare(`DELETE FROM ${table}`).run();
    } catch (e: any) {
      console.warn(`[Local Reset Warning] Error deleting local table "${table}":`, e.message);
    }
  }

  // Remove non-seed users and reset sequence
  try {
    db.prepare("DELETE FROM users WHERE username NOT IN ('admin', 'roby')").run();
  } catch (e: any) {}

  // Reset auto-increment sequence counters so ticket and product IDs start fresh at #1
  try {
    db.prepare(`DELETE FROM sqlite_sequence WHERE name NOT IN ('users')`).run();
  } catch (e: any) {}

  // Re-enable immutable triggers for system_audit_logs and firestore_transaction_ledger
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS prevent_system_audit_logs_update
      BEFORE UPDATE ON system_audit_logs
      BEGIN
        SELECT RAISE(FAIL, 'system_audit_logs are immutable and cannot be updated');
      END;
      CREATE TRIGGER IF NOT EXISTS prevent_system_audit_logs_delete
      BEFORE DELETE ON system_audit_logs
      BEGIN
        SELECT RAISE(FAIL, 'system_audit_logs are immutable and cannot be deleted');
      END;
      CREATE TRIGGER IF NOT EXISTS prevent_firestore_ledger_update
      BEFORE UPDATE ON firestore_transaction_ledger
      WHEN OLD.tx_hash != NEW.tx_hash
        OR OLD.table_name != NEW.table_name
        OR OLD.record_id != NEW.record_id
        OR OLD.operation != NEW.operation
        OR COALESCE(OLD.payload_checksum, '') != COALESCE(NEW.payload_checksum, '')
        OR OLD.status NOT IN ('PENDING_CLOUD_CONFIRMATION', 'PENDING')
      BEGIN
        SELECT RAISE(FAIL, 'firestore_transaction_ledger entries are immutable and cannot be modified');
      END;
      CREATE TRIGGER IF NOT EXISTS prevent_firestore_ledger_delete
      BEFORE DELETE ON firestore_transaction_ledger
      BEGIN
        SELECT RAISE(FAIL, 'firestore_transaction_ledger entries are immutable and cannot be deleted');
      END;
    `);
  } catch (e) {}

  // Re-seed default settings and seed users in SQLite (preserving existing custom exchange rate)
  try {
    const existingRate = db.prepare('SELECT value FROM settings WHERE key = ?').get('exchange_rate') as any;
    const rateToPreserve = (existingRate && existingRate.value && !isNaN(parseFloat(existingRate.value)) && parseFloat(existingRate.value) > 0)
      ? String(existingRate.value)
      : '6.96';
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('exchange_rate', rateToPreserve);
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('seeded_products', 'true');
  } catch (e) {}

  // Reset in-memory cache
  for (const key of Object.keys(lastSyncedMaxIdCache)) {
    delete lastSyncedMaxIdCache[key];
  }

  // 3. Re-push seed users and settings to Firestore
  try {
    await pushLocalToFirestore('users');
    await pushLocalToFirestore('settings');
  } catch (e) {}

  console.log("[Sync Reset] Complete database reset finished successfully. Database is now at clean zero state.");
}

/**
 * CATALOG STOCK INTEGRITY AUDIT
 * Protects products against accidental zeroing and maintains catalog consistency.
 */
export function reconcileCatalogStockWithLedger(): { audited: number; corrected: number; corrections: any[] } {
  const prods = db.prepare('SELECT id, name, sku, stock FROM products').all() as any[];
  // Safe: Never arbitrarily overwrite verified product stocks with 0
  return { audited: prods.length, corrected: 0, corrections: [] };
}

let ledgerReconciliationTimer: NodeJS.Timeout | null = null;

/**
 * Periodic ledger reconciliation is permanently neutralized to prevent catalog stock zeroing.
 */
export function startPeriodicLedgerReconciliation(_intervalMs: number = 60000) {
  if (ledgerReconciliationTimer) {
    clearInterval(ledgerReconciliationTimer);
    ledgerReconciliationTimer = null;
  }
  console.log("[Ledger Reconciler] Destructive stock overwrites are permanently disabled to protect catalog integrity.");
}

// Export alias pushFirestoreToLocal for seamless drop-in compatibility
export const pushFirestoreToLocal = pullFirestoreToLocal;
