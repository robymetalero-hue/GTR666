import { safeDispatchEvent } from "./events";

// Offline storage utility for GTR POS
// Manages offline sales queueing in IndexedDB with fallback to LocalStorage

const DB_NAME = 'gtr_pos_offline_db';
const STORE_NAME = 'offline_sales';
const ACTIONS_STORE_NAME = 'offline_actions';
const STATE_CACHE_STORE = 'app_state_cache';
const DB_VERSION = 3; // Incremented database version to support state persistence cache store

export interface OfflineSale {
    id: string; // Unique temporary ID
    salePayload: any;
    clientName?: string;
    clientPhone?: string;
    ownerUserId?: number | string;
    ownerUsername?: string;
    createdAt: string;
}

export interface OfflineAction {
    id: string; // Unique temporary ID
    type: string; // e.g., 'create_client', 'create_pending_sale', 'adjust_points', 'add_department'
    url: string;
    method: 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    payload: any;
    metadata?: any;
    ownerUserId?: number | string;
    ownerUsername?: string;
    createdAt: string;
}

// Memory fallback queue in case both IndexedDB and LocalStorage are inaccessible
let memoryQueue: OfflineSale[] = [];
let memoryActionsQueue: OfflineAction[] = [];
const memoryStateCache: Record<string, any> = {};

/**
 * Safely opens IndexedDB
 */
function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        if (!window.indexedDB) {
            reject(new Error('IndexedDB not supported'));
            return;
        }

        try {
            const request = window.indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = () => {
                reject(request.error || new Error('Database open failed'));
            };

            request.onsuccess = () => {
                resolve(request.result);
            };

            request.onupgradeneeded = (event: any) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(ACTIONS_STORE_NAME)) {
                    db.createObjectStore(ACTIONS_STORE_NAME, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(STATE_CACHE_STORE)) {
                    db.createObjectStore(STATE_CACHE_STORE, { keyPath: 'key' });
                }
            };
        } catch (err) {
            reject(err);
        }
    });
}

const COMPLETED_OPS_STORAGE_KEY = 'gtr_completed_operation_ids';
const MAX_COMPLETED_OPS = 250;
let memoryCompletedOps = new Set<string>();

export function getCompletedOperations(): Set<string> {
    const result = new Set<string>(memoryCompletedOps);
    if (typeof window !== 'undefined' && window.localStorage) {
        try {
            const raw = localStorage.getItem(COMPLETED_OPS_STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    for (const item of parsed) {
                        if (typeof item === 'string' && item) result.add(item);
                    }
                }
            }
        } catch {}
    }
    return result;
}

export function markOperationCompleted(opId?: string | null, offlineId?: string | null): void {
    const idsToAdd = [opId, offlineId].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    if (idsToAdd.length === 0) return;

    idsToAdd.forEach(id => memoryCompletedOps.add(id));

    if (typeof window !== 'undefined' && window.localStorage) {
        try {
            const current = Array.from(getCompletedOperations());
            for (const id of idsToAdd) {
                if (!current.includes(id)) current.push(id);
            }
            const trimmed = current.slice(-MAX_COMPLETED_OPS);
            localStorage.setItem(COMPLETED_OPS_STORAGE_KEY, JSON.stringify(trimmed));
        } catch {}
    }
}

export function isOperationCompleted(opId?: string | null, offlineId?: string | null): boolean {
    const completed = getCompletedOperations();
    if (opId && completed.has(opId)) return true;
    if (offlineId && completed.has(offlineId)) return true;
    return false;
}

/**
 * LocalStorage Fallback functions
 */
function getLocalStorageQueue(): OfflineSale[] {
    try {
        const stored = localStorage.getItem('gtr_offline_sales_queue');
        return stored ? JSON.parse(stored) : [];
    } catch (e) {
        console.warn('LocalStorage fallback failed:', e);
        return memoryQueue;
    }
}

function saveLocalStorageQueue(queue: OfflineSale[]): void {
    try {
        if (queue.length === 0) {
            localStorage.removeItem('gtr_offline_sales_queue');
        } else {
            localStorage.setItem('gtr_offline_sales_queue', JSON.stringify(queue));
        }
        memoryQueue = queue;
    } catch (e) {
        console.warn('Saving to LocalStorage failed:', e);
        memoryQueue = queue;
    }
}

/**
 * Saves a sale to the offline queue (with idempotency deduplication by clientOperationId)
 */
export async function saveOfflineSale(salePayload: any, clientName?: string, clientPhone?: string): Promise<OfflineSale> {
    // Ensure payload has a unique idempotency clientOperationId
    const opId = salePayload?.clientOperationId || salePayload?.client_operation_id || `offline_op_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const safePayload = {
        ...salePayload,
        clientOperationId: opId
    };

    let currentUserId: number | string | undefined = salePayload?.user_id;
    let currentUsername: string | undefined = salePayload?.user_name || salePayload?.username;
    if ((!currentUserId || !currentUsername) && typeof window !== 'undefined') {
        try {
            const rawUser = localStorage.getItem('user');
            if (rawUser) {
                const parsed = JSON.parse(rawUser);
                if (!currentUserId) currentUserId = parsed.id;
                if (!currentUsername) currentUsername = parsed.username;
            }
        } catch (_) {}
    }

    if (currentUserId && !safePayload.user_id) {
        safePayload.user_id = currentUserId;
    }
    if (currentUsername && !safePayload.user_name) {
        safePayload.user_name = currentUsername;
    }

    const offlineSale: OfflineSale = {
        id: `offline_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        salePayload: safePayload,
        clientName,
        clientPhone,
        ownerUserId: currentUserId,
        ownerUsername: currentUsername,
        createdAt: new Date().toISOString()
    };

    // Guard 1: If this operation was already completed online or synced, do not queue it again
    if (isOperationCompleted(opId)) {
        console.log('[Offline DB] Skipping saveOfflineSale because operation is already marked completed:', opId);
        return offlineSale;
    }

    // Guard 2: Check if an offline sale with the exact same clientOperationId is already queued
    try {
        const existingSales = await getOfflineSales();
        const duplicate = existingSales.find(s => {
            const sOpId = s.salePayload?.clientOperationId || s.salePayload?.client_operation_id;
            return sOpId && sOpId === opId;
        });
        if (duplicate) {
            console.log('[Offline DB] Sale with clientOperationId already exists in queue, returning existing:', duplicate.id);
            return duplicate;
        }
    } catch (_) {}

    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.put(offlineSale);

            request.onsuccess = () => {
                db.close();
                console.log('[Offline DB] Sale saved successfully to IndexedDB:', offlineSale.id);
                safeDispatchEvent('offline_queue_changed', { detail: { action: 'add_sale', sale: offlineSale } });
                resolve(offlineSale);
            };

            request.onerror = () => {
                db.close();
                reject(request.error || new Error('Failed to save to IndexedDB'));
            };
        });
    } catch (err) {
        console.warn('[Offline DB] IndexedDB unavailable, falling back to LocalStorage:', err);
        const queue = getLocalStorageQueue();
        const existsInLs = queue.find(s => (s.salePayload?.clientOperationId || s.salePayload?.client_operation_id) === opId);
        if (!existsInLs) {
            queue.push(offlineSale);
            saveLocalStorageQueue(queue);
        }
        safeDispatchEvent('offline_queue_changed', { detail: { action: 'add_sale', sale: offlineSale } });
        return existsInLs || offlineSale;
    }
}

/**
 * Retrieves all offline sales from the queue, filtering out completed/resurrected operations and deduplicating by clientOperationId
 */
export async function getOfflineSales(): Promise<OfflineSale[]> {
    let rawList: OfflineSale[] = [];
    try {
        const db = await openDB();
        rawList = await new Promise<OfflineSale[]>((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.getAll();

            request.onsuccess = () => {
                db.close();
                resolve(request.result || []);
            };

            request.onerror = () => {
                db.close();
                reject(request.error || new Error('Failed to fetch from IndexedDB'));
            };
        });
    } catch (err) {
        console.warn('[Offline DB] IndexedDB fetch failed, using fallback:', err);
        rawList = getLocalStorageQueue();
    }

    const completed = getCompletedOperations();
    const seenOpIds = new Set<string>();
    const cleanList: OfflineSale[] = [];
    const staleIdsToDelete: string[] = [];

    for (const item of rawList) {
        if (!item || !item.id) continue;
        const opId = item.salePayload?.clientOperationId || item.salePayload?.client_operation_id;
        if (completed.has(item.id) || (opId && completed.has(opId))) {
            staleIdsToDelete.push(item.id);
            continue;
        }
        if (opId) {
            if (seenOpIds.has(opId)) {
                staleIdsToDelete.push(item.id);
                continue;
            }
            seenOpIds.add(opId);
        }
        cleanList.push(item);
    }

    // Background cleanup of any stale/duplicate items found in IndexedDB or LocalStorage
    if (staleIdsToDelete.length > 0) {
        openDB().then(db => {
            try {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                staleIdsToDelete.forEach(id => {
                    try { store.delete(id); } catch {}
                });
                tx.oncomplete = () => db.close();
                tx.onerror = () => db.close();
            } catch {
                db.close();
            }
        }).catch(() => {});

        try {
            const lsQueue = getLocalStorageQueue();
            if (lsQueue.length > 0) {
                const filteredLs = lsQueue.filter(s => !staleIdsToDelete.includes(s.id) && !completed.has(s.id));
                saveLocalStorageQueue(filteredLs);
            }
        } catch {}
    }

    return cleanList;
}

/**
 * Deletes a sale from ALL offline queues (IndexedDB, LocalStorage, and memory) and records it in completed operations so it can never resurrect
 */
export async function deleteOfflineSale(id: string, clientOperationId?: string): Promise<void> {
    let resolvedOpId = clientOperationId;

    // Also purge from LocalStorage and memoryQueue unconditionally to prevent resurrection
    try {
        const lsQueue = getLocalStorageQueue();
        const foundInLs = lsQueue.find(item => item.id === id);
        if (!resolvedOpId && foundInLs) {
            resolvedOpId = foundInLs.salePayload?.clientOperationId || foundInLs.salePayload?.client_operation_id;
        }
        const filtered = lsQueue.filter(item => {
            if (item.id === id) return false;
            const itemOpId = item.salePayload?.clientOperationId || item.salePayload?.client_operation_id;
            if (resolvedOpId && itemOpId === resolvedOpId) return false;
            return true;
        });
        saveLocalStorageQueue(filtered);
    } catch (e) {
        console.warn('[Offline DB] Error cleaning LocalStorage queue during delete:', e);
    }

    try {
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const getReq = store.get(id);

            getReq.onsuccess = () => {
                const record = getReq.result as OfflineSale | undefined;
                if (!resolvedOpId && record) {
                    resolvedOpId = record.salePayload?.clientOperationId || record.salePayload?.client_operation_id;
                }
                markOperationCompleted(resolvedOpId, id);
                store.delete(id);
            };
            getReq.onerror = () => {
                markOperationCompleted(resolvedOpId, id);
                store.delete(id);
            };

            transaction.oncomplete = () => {
                db.close();
                console.log('[Offline DB] Sale deleted from IndexedDB & LocalStorage:', id);
                safeDispatchEvent('offline_queue_changed', { detail: { action: 'delete_sale', id } });
                resolve();
            };

            transaction.onerror = () => {
                db.close();
                reject(transaction.error || new Error('Failed to delete from IndexedDB'));
            };
        });
    } catch (err) {
        markOperationCompleted(resolvedOpId, id);
        console.warn('[Offline DB] IndexedDB delete fallback completed:', err);
        safeDispatchEvent('offline_queue_changed', { detail: { action: 'delete_sale', id } });
    }
}

/**
 * Checks if there are pending offline sales in queue
 */
export async function hasOfflineSales(): Promise<boolean> {
    const list = await getOfflineSales();
    return list.length > 0;
}

/**
 * LocalStorage Fallback functions for actions
 */
function getLocalStorageActionsQueue(): OfflineAction[] {
    try {
        const stored = localStorage.getItem('gtr_offline_actions_queue');
        return stored ? JSON.parse(stored) : [];
    } catch (e) {
        console.warn('LocalStorage fallback failed for actions:', e);
        return memoryActionsQueue;
    }
}

function saveLocalStorageActionsQueue(queue: OfflineAction[]): void {
    try {
        if (queue.length === 0) {
            localStorage.removeItem('gtr_offline_actions_queue');
        } else {
            localStorage.setItem('gtr_offline_actions_queue', JSON.stringify(queue));
        }
        memoryActionsQueue = queue;
    } catch (e) {
        console.warn('Saving actions to LocalStorage failed:', e);
        memoryActionsQueue = queue;
    }
}

/**
 * Saves a POS action to the offline action queue
 */
export async function saveOfflineAction(
    type: string, 
    url: string, 
    method: 'POST' | 'PUT' | 'DELETE' | 'PATCH', 
    payload: any, 
    metadata?: any
): Promise<OfflineAction> {
    let currentUserId: number | string | undefined = metadata?.ownerUserId || payload?.user_id;
    let currentUsername: string | undefined = metadata?.ownerUsername || payload?.user_name || payload?.username;
    if ((!currentUserId || !currentUsername) && typeof window !== 'undefined') {
        try {
            const rawUser = localStorage.getItem('user');
            if (rawUser) {
                const parsed = JSON.parse(rawUser);
                if (!currentUserId) currentUserId = parsed.id;
                if (!currentUsername) currentUsername = parsed.username;
            }
        } catch (_) {}
    }

    const opId = payload?.clientOperationId || payload?.client_operation_id;
    if (opId && isOperationCompleted(opId)) {
        return {
            id: `action_${Date.now()}`,
            type,
            url,
            method,
            payload,
            metadata,
            ownerUserId: currentUserId,
            ownerUsername: currentUsername,
            createdAt: new Date().toISOString()
        };
    }

    const offlineAction: OfflineAction = {
        id: `action_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type,
        url,
        method,
        payload,
        metadata,
        ownerUserId: currentUserId,
        ownerUsername: currentUsername,
        createdAt: new Date().toISOString()
    };

    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(ACTIONS_STORE_NAME, 'readwrite');
            const store = transaction.objectStore(ACTIONS_STORE_NAME);
            const request = store.put(offlineAction);

            request.onsuccess = () => {
                db.close();
                console.log('[Offline DB] Action saved successfully to IndexedDB:', offlineAction.id, `(${type})`);
                safeDispatchEvent('offline_queue_changed', { detail: { action: 'add_action', item: offlineAction } });
                resolve(offlineAction);
            };

            request.onerror = () => {
                db.close();
                reject(request.error || new Error('Failed to save action to IndexedDB'));
            };
        });
    } catch (err) {
        console.warn('[Offline DB] IndexedDB action save failed, falling back to LocalStorage:', err);
        const queue = getLocalStorageActionsQueue();
        queue.push(offlineAction);
        saveLocalStorageActionsQueue(queue);
        safeDispatchEvent('offline_queue_changed', { detail: { action: 'add_action', item: offlineAction } });
        return offlineAction;
    }
}

/**
 * Retrieves all offline actions from the queue
 */
export async function getOfflineActions(): Promise<OfflineAction[]> {
    let rawActions: OfflineAction[] = [];
    try {
        const db = await openDB();
        rawActions = await new Promise<OfflineAction[]>((resolve, reject) => {
            const transaction = db.transaction(ACTIONS_STORE_NAME, 'readonly');
            const store = transaction.objectStore(ACTIONS_STORE_NAME);
            const request = store.getAll();

            request.onsuccess = () => {
                db.close();
                resolve(request.result || []);
            };

            request.onerror = () => {
                db.close();
                reject(request.error || new Error('Failed to fetch actions from IndexedDB'));
            };
        });
    } catch (err) {
        console.warn('[Offline DB] IndexedDB action fetch failed, using fallback:', err);
        rawActions = getLocalStorageActionsQueue();
    }

    const completed = getCompletedOperations();
    return rawActions.filter(a => a && a.id && !completed.has(a.id));
}

/**
 * Deletes an action from ALL offline action queues (IndexedDB, LocalStorage, and memory)
 */
export async function deleteOfflineAction(id: string): Promise<void> {
    markOperationCompleted(id, id);

    try {
        const queue = getLocalStorageActionsQueue();
        const filtered = queue.filter(item => item.id !== id);
        saveLocalStorageActionsQueue(filtered);
    } catch {}

    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(ACTIONS_STORE_NAME, 'readwrite');
            const store = transaction.objectStore(ACTIONS_STORE_NAME);
            const request = store.delete(id);

            request.onsuccess = () => {
                db.close();
                console.log('[Offline DB] Action deleted from IndexedDB & LocalStorage:', id);
                safeDispatchEvent('offline_queue_changed', { detail: { action: 'delete_action', id } });
                resolve();
            };

            request.onerror = () => {
                db.close();
                reject(request.error || new Error('Failed to delete action from IndexedDB'));
            };
        });
    } catch (err) {
        console.warn('[Offline DB] IndexedDB action delete fallback completed:', err);
        safeDispatchEvent('offline_queue_changed', { detail: { action: 'delete_action', id } });
    }
}

/**
 * Checks if there are pending offline actions in queue
 */
export async function hasOfflineActions(): Promise<boolean> {
    const list = await getOfflineActions();
    return list.length > 0;
}

export interface OfflineStats {
    salesCount: number;
    actionsCount: number;
    totalAmountBob: number;
    totalAmountUsd: number;
    oldestPendingDate: string | null;
}

/**
 * Computes live statistics for all items waiting in offline queues
 */
export async function getOfflineStats(): Promise<OfflineStats> {
    const [sales, actions] = await Promise.all([
        getOfflineSales(),
        getOfflineActions()
    ]);

    let totalBob = 0;
    let totalUsd = 0;
    let oldestDate: string | null = null;

    for (const sale of sales) {
        const payload = sale.salePayload || {};
        const currency = payload.currency || 'BOB';
        const total = Number(payload.total) || 0;

        if (currency === 'USD') {
            totalUsd += total;
        } else {
            totalBob += total;
        }

        if (sale.createdAt) {
            if (!oldestDate || new Date(sale.createdAt) < new Date(oldestDate)) {
                oldestDate = sale.createdAt;
            }
        }
    }

    for (const action of actions) {
        if (action.createdAt) {
            if (!oldestDate || new Date(action.createdAt) < new Date(oldestDate)) {
                oldestDate = action.createdAt;
            }
        }
    }

    return {
        salesCount: sales.length,
        actionsCount: actions.length,
        totalAmountBob: totalBob,
        totalAmountUsd: totalUsd,
        oldestPendingDate: oldestDate
    };
}

/**
 * Generates a full emergency export JSON payload containing all offline records
 */
export async function exportOfflineBackupJSON(): Promise<string> {
    const [sales, actions] = await Promise.all([
        getOfflineSales(),
        getOfflineActions()
    ]);

    const backup = {
        format: 'GTR_POS_OFFLINE_BACKUP_v2',
        generatedAt: new Date().toISOString(),
        deviceInfo: {
            userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
            platform: typeof navigator !== 'undefined' ? navigator.platform : ''
        },
        summary: {
            salesCount: sales.length,
            actionsCount: actions.length
        },
        offlineSales: sales,
        offlineActions: actions
    };

    return JSON.stringify(backup, null, 2);
}

/**
 * Triggers a direct browser download of the emergency offline backup file
 */
export async function downloadOfflineBackupFile(): Promise<void> {
    const jsonStr = await exportOfflineBackupJSON();
    const now = new Date();
    const dateStr = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `GTR_POS_Respaldo_Offline_${dateStr}.json`;

    const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

/**
 * Persists generic app state (products, clients, settings, departments, cart) into IndexedDB
 */
export async function cacheAppState(key: string, data: any): Promise<void> {
    if (data === undefined || data === null) return;
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STATE_CACHE_STORE, 'readwrite');
            const store = transaction.objectStore(STATE_CACHE_STORE);
            const record = { key, data, updatedAt: new Date().toISOString() };
            const request = store.put(record);

            request.onsuccess = () => {
                db.close();
                resolve();
            };

            request.onerror = () => {
                db.close();
                reject(request.error || new Error('Failed to cache state in IndexedDB'));
            };
        });
    } catch (err) {
        console.warn(`[IndexedDB Cache] Failed to put key "${key}", falling back to LocalStorage:`, err);
        try {
            localStorage.setItem(`idxdb_fallback_${key}`, JSON.stringify(data));
        } catch (lsErr) {
            memoryStateCache[key] = data;
        }
    }
}

/**
 * Retrieves cached app state from IndexedDB
 */
export async function getCachedAppState<T>(key: string): Promise<T | null> {
    try {
        const db = await openDB();
        return new Promise((resolve) => {
            const transaction = db.transaction(STATE_CACHE_STORE, 'readonly');
            const store = transaction.objectStore(STATE_CACHE_STORE);
            const request = store.get(key);

            request.onsuccess = () => {
                db.close();
                if (request.result && request.result.data !== undefined) {
                    resolve(request.result.data as T);
                } else {
                    // Try LocalStorage fallback
                    const fallback = localStorage.getItem(`idxdb_fallback_${key}`);
                    if (fallback) {
                        try {
                            resolve(JSON.parse(fallback));
                        } catch {
                            resolve(null);
                        }
                    } else {
                        resolve(memoryStateCache[key] ?? null);
                    }
                }
            };

            request.onerror = () => {
                db.close();
                const fallback = localStorage.getItem(`idxdb_fallback_${key}`);
                if (fallback) {
                    try { resolve(JSON.parse(fallback)); } catch { resolve(null); }
                } else {
                    resolve(memoryStateCache[key] ?? null);
                }
            };
        });
    } catch (err) {
        console.warn(`[IndexedDB Cache] IndexedDB open error for "${key}", using fallback:`, err);
        const fallback = localStorage.getItem(`idxdb_fallback_${key}`);
        if (fallback) {
            try { return JSON.parse(fallback); } catch { return null; }
        }
        return memoryStateCache[key] ?? null;
    }
}

/**
 * Clears cached app state from IndexedDB
 */
export async function clearCachedAppState(key: string): Promise<void> {
    try {
        const db = await openDB();
        return new Promise((resolve) => {
            const transaction = db.transaction(STATE_CACHE_STORE, 'readwrite');
            const store = transaction.objectStore(STATE_CACHE_STORE);
            const request = store.delete(key);

            request.onsuccess = () => { db.close(); resolve(); };
            request.onerror = () => { db.close(); resolve(); };
        });
    } catch (err) {
        localStorage.removeItem(`idxdb_fallback_${key}`);
        delete memoryStateCache[key];
    }
}

/**
 * Purges ALL offline queues, offline sales, offline actions, and cached app state from IndexedDB and LocalStorage
 */
export async function clearAllOfflineStorage(): Promise<void> {
    memoryQueue = [];
    memoryActionsQueue = [];
    Object.keys(memoryStateCache).forEach(k => delete memoryStateCache[k]);

    try {
        localStorage.clear();
    } catch (e) {}

    try {
        const db = await openDB();
        const stores = [STORE_NAME, ACTIONS_STORE_NAME, STATE_CACHE_STORE];
        const tx = db.transaction(stores, 'readwrite');
        stores.forEach(s => {
            try { tx.objectStore(s).clear(); } catch (e) {}
        });
        await new Promise<void>((res) => {
            tx.oncomplete = () => { db.close(); res(); };
            tx.onerror = () => { db.close(); res(); };
        });
    } catch (e) {
        console.warn("Failed to clear IndexedDB stores:", e);
    }
}

