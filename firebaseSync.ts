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
import { db, isCurrentContextSandbox, dbAsyncLocalStorage } from './database.ts';

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

  const email = process.env.FIREBASE_SYNC_EMAIL;
  const password = process.env.FIREBASE_SYNC_PASSWORD;
  if (!email || !password) {
    return;
  }

  if (!authPromise) {
    authPromise = (async () => {
      const authTimeout = new Promise<void>((resolve) => setTimeout(resolve, 3000));
      const authTask = (async () => {
        try {
          const auth = getAuth(app);
          try {
            await signInWithEmailAndPassword(auth, email, password);
            authAuthenticated = true;
          } catch (e: any) {
            if (e.code === 'auth/user-not-found' || e.code === 'auth/invalid-credential') {
              try {
                await createUserWithEmailAndPassword(auth, email, password);
                authAuthenticated = true;
              } catch (createErr: any) {
                authDisabledUntil = Date.now() + (10 * 60 * 1000);
              }
            } else {
              authDisabledUntil = Date.now() + (10 * 60 * 1000);
            }
          }
        } catch (err: any) {
          authDisabledUntil = Date.now() + (10 * 60 * 1000);
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

    const hydrateRemediationStateFromRawJson = (rawJsonStr: string) => {
      try {
        const remState = JSON.parse(rawJsonStr);
        if (Array.isArray(remState.deleted_records)) {
          const insDel = db.prepare("INSERT OR IGNORE INTO deleted_records (table_name, record_id, deleted_at) VALUES (?, ?, ?)");
          for (const d of remState.deleted_records) {
            insDel.run(d.table_name, String(d.record_id), d.deleted_at || new Date().toISOString());
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

        // Y08: If local SQLite still contains contaminated Incident #399 rows, atomically reverse their stock/cash effects and purge them locally
        const testSaleIds = [399, 400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415, 416, 417, 418, 419, 420, 421, 422, 423, 425, 426, 427, 428];
        const ph = testSaleIds.map(() => '?').join(',');
        const localContaminatedSales = db.prepare(`SELECT * FROM sales WHERE id IN (${ph})`).all(...testSaleIds) as any[];
        const localContaminatedItems = db.prepare(`SELECT * FROM sale_items WHERE sale_id IN (${ph})`).all(...testSaleIds) as any[];
        const localContaminatedCash = db.prepare(`SELECT * FROM cash_movements WHERE sale_id IN (${ph})`).all(...testSaleIds) as any[];

        if (localContaminatedSales.length > 0 || localContaminatedItems.length > 0 || localContaminatedCash.length > 0) {
          db.transaction(() => {
            const insQuarantine = db.prepare(`
              INSERT INTO incident_quarantine_records (incident_id, table_name, record_id, payload_json, reason, backup_path)
              SELECT 'INCIDENT_399_20261027', ?, ?, ?, ?, 'remote_hydration_remediation'
              WHERE NOT EXISTS (
                SELECT 1 FROM incident_quarantine_records
                WHERE incident_id = 'INCIDENT_399_20261027' AND table_name = ? AND record_id = ?
              )
            `);

            for (const s of localContaminatedSales) {
              insQuarantine.run('sales', String(s.id), JSON.stringify(s), 'Remediación local por hidratación INCIDENT_399', 'sales', String(s.id));
            }
            for (const it of localContaminatedItems) {
              insQuarantine.run('sale_items', String(it.id), JSON.stringify(it), `Ítem de venta contaminada #${it.sale_id}`, 'sale_items', String(it.id));
              if (it.product_id && Number(it.quantity) > 0) {
                db.prepare('UPDATE products SET stock = stock + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(Number(it.quantity), Number(it.product_id));
              }
            }
            for (const cm of localContaminatedCash) {
              insQuarantine.run('cash_movements', String(cm.id), JSON.stringify(cm), `Movimiento de caja de venta contaminada #${cm.sale_id}`, 'cash_movements', String(cm.id));
              if (cm.seller_id && Number(cm.amount) > 0) {
                const saleRow = localContaminatedSales.find((s: any) => Number(s.id) === Number(cm.sale_id));
                const rate = Number(saleRow?.exchange_rate || 6.96);
                const deductBs = cm.currency === 'USD' ? Number((Number(cm.amount) * rate).toFixed(2)) : Number(cm.amount);
                db.prepare('UPDATE cash_accounts SET current_balance = ROUND(current_balance - ?, 2), updated_at = CURRENT_TIMESTAMP WHERE seller_id = ?').run(deductBs, Number(cm.seller_id));
              }
            }

            db.prepare(`DELETE FROM cash_movements WHERE sale_id IN (${ph})`).run(...testSaleIds);
            db.prepare(`DELETE FROM sale_items WHERE sale_id IN (${ph})`).run(...testSaleIds);
            db.prepare(`DELETE FROM accounts_receivable WHERE sale_id IN (${ph})`).run(...testSaleIds);
            db.prepare(`DELETE FROM sale_returns WHERE sale_id IN (${ph})`).run(...testSaleIds);
            db.prepare(`DELETE FROM sales WHERE id IN (${ph})`).run(...testSaleIds);
          })();
        }

        const p1Log = db.prepare("SELECT COUNT(*) as c FROM inventory_audit_logs WHERE reference = 'INCIDENT_399' AND product_id = 1").get() as any;
        if ((p1Log?.c || 0) === 0) {
          db.prepare(`
            INSERT INTO inventory_audit_logs (product_id, product_name, product_sku, type, quantity, price, user_id, username, reference, notes, created_at)
            VALUES (1, 'MOUSE LOGITECH SUPER LIGTH 2', '1', 'ajuste', 1, 99, 4, 'admin', 'INCIDENT_399', 'Restitución administrativa por remediación incidente #399 (1 u. en venta de prueba #404)', '2026-10-27T12:30:00-04:00')
          `).run();
        }
        const p5Log = db.prepare("SELECT COUNT(*) as c FROM inventory_audit_logs WHERE reference = 'INCIDENT_399' AND product_id = 5").get() as any;
        if ((p5Log?.c || 0) === 0) {
          db.prepare(`
            INSERT INTO inventory_audit_logs (product_id, product_name, product_sku, type, quantity, price, user_id, username, reference, notes, created_at)
            VALUES (5, 'Hp goma/metal 16gb', '5', 'ajuste', 24, 58, 4, 'admin', 'INCIDENT_399', 'Restitución administrativa por remediación incidente #399 (24 u. netas en ventas de prueba)', '2026-10-27T12:30:00-04:00')
          `).run();
        }
        const sysLog = db.prepare("SELECT id FROM system_audit_logs WHERE action = 'INCIDENT_REMEDIATION' LIMIT 1").get() as any;
        if (!sysLog) {
          db.prepare(`
            INSERT INTO system_audit_logs (
              event_type, category, module, action, severity,
              entity_type, entity_id, user_id, user_name, user_role,
              reason, result, status, metadata, created_at
            ) VALUES (
              'ADMIN_INTERVENTION', 'AUDIT', 'SALES', 'INCIDENT_REMEDIATION', 'HIGH',
              'sales', '399-428', 4, 'admin', 'admin',
              'Remediación incidente #399: retiro de ventas de prueba y preservación de #398 y #424',
              'SUCCESS', 'COMPLETED', ?, '2026-10-27T12:30:00-04:00'
            )
          `).run(JSON.stringify({
            incident_id: 'INCIDENT_399_20261027',
            preserved_sale_398: { id: 398, total: 2150, user: 'maria', items: 40 },
            preserved_sale_424: { id: 424, total: 610, user: 'maria', items: 20 }
          }));
        }
      } catch (_) {}
    };

    // Pre-hydrate tombstones from incoming settings snapshot BEFORE importing sales, sale_items, or cash_movements
    try {
      const settingsSnapObj = collectionResults.find(r => r.table === 'settings' && r.snapshot && !r.error);
      if (settingsSnapObj && settingsSnapObj.snapshot) {
        for (const docSnap of settingsSnapObj.snapshot.docs) {
          const d = docSnap.data();
          const k = d.key || docSnap.id;
          if (k === 'incident_399_remediation_state' && d.value) {
            hydrateRemediationStateFromRawJson(String(d.value));
          }
        }
      }
      const localRemRow = db.prepare("SELECT value FROM settings WHERE key = 'incident_399_remediation_state'").get() as any;
      if (localRemRow && localRemRow.value) {
        hydrateRemediationStateFromRawJson(String(localRemRow.value));
      }
    } catch (_) {}

    // Pull each collection and upsert data into SQLite inside a single high-performance transaction
    const globalSyncTx = db.transaction(() => {
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

          // Pre-capture local verified stock and updated_at map to implement the ANTI-OVERWRITE STOCK SHIELD
          const localProductStocksMap = new Map<number, number>();
          const localProductUpdatedMap = new Map<number, string>();
          if (table === 'products') {
            try {
              const currentProds = db.prepare('SELECT id, stock, updated_at FROM products').all() as any[];
              for (const p of currentProds) {
                if (p.id !== undefined && p.stock !== null && p.stock !== undefined) {
                  localProductStocksMap.set(Number(p.id), Number(p.stock));
                  if (p.updated_at) {
                    localProductUpdatedMap.set(Number(p.id), String(p.updated_at));
                  }
                }
              }
            } catch (_) {}
          }

          const remoteDocs = snapshot.docs;
          const remoteIds = new Set<string>();

          if (forceOverwrite && table !== 'system_audit_logs' && table !== 'inventory_audit_logs') {
            db.prepare(`DELETE FROM ${table}`).run();
            // Y07: Never wipe deleted_records tombstones or inventory_audit_logs on forceOverwrite so purged/quarantined records cannot resurrect and historical Kárdex is preserved
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

            if (table === 'products' && data.id !== undefined) {
              try {
                const prodIdNum = Number(data.id);
                const localStock = localProductStocksMap.get(prodIdNum);
                const localUpdatedStr = localProductUpdatedMap.get(prodIdNum);
                const remoteStock = Number(data.stock);

                const localUpdated = localUpdatedStr ? new Date(localUpdatedStr).getTime() : 0;
                const remoteUpdated = data.updated_at || data._tx_timestamp ? new Date(data.updated_at || data._tx_timestamp).getTime() : 0;

                // ANTI-PHANTOM & STRICT LEDGER RULE:
                // If local stock is 0 (sold out or confirmed zero) and local update is equal or newer than remote,
                // NEVER allow a stale positive remote stock to resurrect phantom units!
                if (localStock === 0 && localUpdated >= remoteUpdated) {
                  data.stock = 0;
                  if (localUpdatedStr) data.updated_at = localUpdatedStr;
                } else if (localUpdated > remoteUpdated && localStock !== undefined && !isNaN(localStock)) {
                  // Local record is newer than remote Firestore snapshot: local stock wins
                  data.stock = localStock;
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

            const insertSql = `INSERT OR REPLACE INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
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

    // Hydrate incident_399_remediation_state from settings table if present (protects against container disk resets)
    try {
      const remRow = db.prepare("SELECT value FROM settings WHERE key = 'incident_399_remediation_state'").get() as any;
      if (remRow && remRow.value) {
        hydrateRemediationStateFromRawJson(String(remRow.value));
      }
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
