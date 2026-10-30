/**
 * Utility function to perform a controlled hard refresh of the application
 * when a version discrepancy or stale asset issue is detected.
 *
 * Iterates through `window.caches.keys()`, deletes all named caches,
 * clears `localStorage` and `indexedDB` in a controlled manner
 * (preserving critical user authentication and offline transaction queues),
 * and executes `window.location.reload(true)`.
 */

const CRITICAL_LOCAL_STORAGE_KEYS = [
    'user',
    'auth_token',
    'gtr_offline_sales_queue',
    'gtr_offline_actions_queue',
    'gtr_completed_operation_ids',
    'gtr_hardware_config',
    'cached_sales_tabs',
    'cached_active_tab_id',
    'gtr_pos_active_cart_backup',
    'gtr_pos_last_cleared_cart',
    'active_pos_cart',
    'cached_current_view',
    'kioskMode',
    'pwa_installed',
    'pwa_app_version',
    'pwa_acknowledged_server_version',
    'pwa_build_timestamp',
    'pwa_push_subscribed',
    'terminal_id',
    'active_store_id',
    'last_auto_version_reload',
    'auto_version_reload_count',
    'darkMode',
    'theme',
    'rgb_theme_settings',
    'gtr_sidebar_collapsed',
    'pos_ui_favorites',
    'pos_view_layout_mode',
    'cached_exchange_rate',
    'gtr_hot_update_restored'
];

export interface HotUpdateSnapshotInput {
    cart?: any[];
    tabs?: any[];
    activeTabId?: number;
    clientName?: string;
    clientPhone?: string;
    discount?: number;
    discountType?: 'monto' | 'porcentaje';
    paymentMethod?: string;
    view?: string;
    targetVersion?: string;
}

/**
 * Synchronously snapshots the cashier's live cart, held sale tabs, selected client,
 * and active view into LocalStorage so a Hot-Swap version update never loses a single item.
 */
export function saveHotUpdateSnapshot(snapshot?: HotUpdateSnapshotInput): void {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
        if (snapshot) {
            if (snapshot.view) {
                localStorage.setItem('cached_current_view', snapshot.view);
            }
            if (snapshot.activeTabId !== undefined) {
                localStorage.setItem('cached_active_tab_id', String(snapshot.activeTabId));
            }
            if (Array.isArray(snapshot.tabs) && snapshot.tabs.length > 0) {
                const updatedTabs = snapshot.tabs.map((t: any) => {
                    if (snapshot.activeTabId !== undefined && t.id === snapshot.activeTabId) {
                        return {
                            ...t,
                            cart: snapshot.cart !== undefined ? snapshot.cart : t.cart,
                            clientName: snapshot.clientName !== undefined ? snapshot.clientName : t.clientName,
                            clientPhone: snapshot.clientPhone !== undefined ? snapshot.clientPhone : t.clientPhone,
                            discount: snapshot.discount !== undefined ? snapshot.discount : t.discount,
                            discountType: snapshot.discountType !== undefined ? snapshot.discountType : t.discountType,
                            paymentMethod: snapshot.paymentMethod !== undefined ? snapshot.paymentMethod : t.paymentMethod
                        };
                    }
                    return t;
                });
                localStorage.setItem('cached_sales_tabs', JSON.stringify(updatedTabs));
            }
            if (Array.isArray(snapshot.cart) && snapshot.cart.length > 0) {
                localStorage.setItem('gtr_pos_active_cart_backup', JSON.stringify({
                    cart: snapshot.cart,
                    clientName: snapshot.clientName || '',
                    clientPhone: snapshot.clientPhone || '',
                    discount: snapshot.discount || 0,
                    discountType: snapshot.discountType || 'monto',
                    paymentMethod: snapshot.paymentMethod || 'Efectivo',
                    activeTabId: snapshot.activeTabId || 1,
                    timestamp: new Date().toISOString()
                }));
            }
        }

        const rawBackup = localStorage.getItem('gtr_pos_active_cart_backup');
        let hadActiveCart = false;
        if (rawBackup) {
            try {
                const parsed = JSON.parse(rawBackup);
                if (Array.isArray(parsed?.cart) && parsed.cart.length > 0) {
                    hadActiveCart = true;
                }
            } catch {}
        }

        localStorage.setItem('gtr_hot_update_restored', JSON.stringify({
            version: snapshot?.targetVersion || localStorage.getItem('pwa_app_version') || '',
            hadActiveCart,
            timestamp: Date.now()
        }));
    } catch (err) {
        console.warn('[saveHotUpdateSnapshot] Failed to write snapshot:', err);
    }
}

export async function hardRefreshApp(): Promise<void> {
    console.warn("[hardRefreshApp] Version mismatch detected. Initiating controlled Hot-Swap refresh...");
    (window as any).__pwaIsHandlingRefresh = true;

    // Ensure hot-update marker is recorded before cache purge
    if (!localStorage.getItem('gtr_hot_update_restored')) {
        saveHotUpdateSnapshot();
    }

    // 1. Instruct Service Worker to skip waiting and flush caches immediately (maintaining offline readiness)
    if ('serviceWorker' in navigator) {
        try {
            const registrations = await navigator.serviceWorker.getRegistrations();
            for (const registration of registrations) {
                if (registration.waiting) {
                    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
                    registration.waiting.postMessage('SKIP_WAITING');
                }
                if (registration.active) {
                    registration.active.postMessage({ type: 'CLEAR_CACHES' });
                    registration.active.postMessage({ type: 'SKIP_WAITING' });
                }
                registration.update().catch(() => {});
            }
            if (navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_CACHES' });
                navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
            }
        } catch (swErr) {
            console.warn("[hardRefreshApp] Warning signaling service workers:", swErr);
        }
    }

    // 2. Iterate through window.caches.keys() and delete all named caches
    if ('caches' in window && window.caches) {
        try {
            const cacheNames = await window.caches.keys();
            await Promise.all(
                cacheNames.map((cacheName) => {
                    console.log(`[hardRefreshApp] Deleting cache: ${cacheName}`);
                    return window.caches.delete(cacheName);
                })
            );
        } catch (cacheErr) {
            console.warn("[hardRefreshApp] Error clearing named window caches:", cacheErr);
        }
    }

    // 3. Controlled LocalStorage Clear (preserving session, cart, tabs, push, kiosk, and offline queues)
    try {
        const preservedItems: Record<string, string> = {};

        // Backup explicit critical keys
        CRITICAL_LOCAL_STORAGE_KEYS.forEach((key) => {
            const val = localStorage.getItem(key);
            if (val !== null) {
                preservedItems[key] = val;
            }
        });

        // Also backup dynamic per-tab cart operation IDs and per-user favorites
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && (k.startsWith('gtr_active_cart_op_id_') || k.startsWith('pos_favorites_') || k.startsWith('idxdb_fallback_cached_sales_tabs'))) {
                const v = localStorage.getItem(k);
                if (v !== null) preservedItems[k] = v;
            }
        }

        // Clear localStorage
        localStorage.clear();

        // Restore critical keys
        Object.entries(preservedItems).forEach(([key, val]) => {
            localStorage.setItem(key, val);
        });
    } catch (lsErr) {
        console.warn("[hardRefreshApp] Error clearing localStorage selectively:", lsErr);
    }

    // 4. Controlled IndexedDB Clear (preserving offline_sales, offline_actions, and cached_sales_tabs)
    if ('indexedDB' in window && window.indexedDB) {
        try {
            await new Promise<void>((resolve) => {
                const req = window.indexedDB.open('gtr_pos_offline_db');
                req.onsuccess = () => {
                    const db = req.result;
                    if (db.objectStoreNames.contains('app_state_cache')) {
                        try {
                            const tx = db.transaction('app_state_cache', 'readwrite');
                            const store = tx.objectStore('app_state_cache');
                            // Only delete stale catalog caches; keep cached_sales_tabs and cached_exchange_rate intact
                            ['cached_products', 'cached_clients', 'cached_departments'].forEach(staleKey => {
                                try { store.delete(staleKey); } catch {}
                            });
                            tx.oncomplete = () => {
                                db.close();
                                resolve();
                            };
                            tx.onerror = () => {
                                db.close();
                                resolve();
                            };
                        } catch {
                            db.close();
                            resolve();
                        }
                    } else {
                        db.close();
                        resolve();
                    }
                };
                req.onerror = () => resolve();
            });

            // Delete non-critical third-party or temporary IndexedDB databases if listed
            if (typeof window.indexedDB.databases === 'function') {
                const dbs = await window.indexedDB.databases();
                for (const dbInfo of dbs) {
                    if (dbInfo.name && dbInfo.name !== 'gtr_pos_offline_db' && !dbInfo.name.includes('offline') && !dbInfo.name.includes('localforage')) {
                        window.indexedDB.deleteDatabase(dbInfo.name);
                    }
                }
            }
        } catch (idbErr) {
            console.warn("[hardRefreshApp] Error clearing IndexedDB stores:", idbErr);
        }
    }

    // 5. Clear SessionStorage (preserving active cart operation IDs if any)
    try {
        sessionStorage.clear();
    } catch (ssErr) {
        console.warn("[hardRefreshApp] Error clearing sessionStorage:", ssErr);
    }

    // 6. Bust browser HTTP cache for index.html before reloading so the latest Vite bundle hashes are loaded immediately
    if (typeof navigator !== 'undefined' && navigator.onLine) {
        try {
            await fetch(window.location.pathname || '/', {
                cache: 'reload',
                headers: {
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0'
                }
            });
        } catch {}
    }

    // 7. Force reload
    try {
        (window.location as any).reload(true);
    } catch {
        window.location.reload();
    }
}
