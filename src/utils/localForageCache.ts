import { User, Product } from '../types';

/**
 * Zero-Cache Stateless Client Module (v2.6.0)
 * Mobile and desktop devices no longer persist product catalogs or cached user registries
 * in localForage/IndexedDB. The server database is the sole single source of truth.
 */

export async function initLocalForageCache(): Promise<void> {
    if (typeof window !== 'undefined' && 'indexedDB' in window && window.indexedDB) {
        try {
            window.indexedDB.deleteDatabase('GTR_POS_APP');
        } catch {}
    }
}

export async function getCachedUserProfile(): Promise<User | null> {
    try {
        const lsUser = localStorage.getItem('user');
        if (lsUser) {
            const parsed = JSON.parse(lsUser);
            if (parsed && parsed.username && parsed.username !== 'none') {
                return parsed;
            }
        }
        return null;
    } catch {
        return null;
    }
}

export async function setCachedUserProfile(user: User | null): Promise<void> {
    try {
        if (user && user.username !== 'none') {
            localStorage.setItem('user', JSON.stringify(user));
        } else {
            localStorage.removeItem('user');
        }
    } catch {}
}

export async function getCachedUserByUsername(_username: string): Promise<User | null> {
    return null;
}

export async function getCachedMinimalProducts(): Promise<Product[] | null> {
    return null;
}

export async function setCachedMinimalProducts(_products: Product[]): Promise<void> {
    try {
        localStorage.removeItem('cached_products');
    } catch {}
}

export async function getCachedAuthToken(): Promise<string | null> {
    try {
        return localStorage.getItem('auth_token');
    } catch {
        return null;
    }
}

export async function setCachedAuthToken(token: string | null): Promise<void> {
    try {
        if (token) {
            localStorage.setItem('auth_token', token);
        } else {
            localStorage.removeItem('auth_token');
        }
    } catch {}
}

export async function clearAuthCache(): Promise<void> {
    try {
        localStorage.removeItem('user');
        localStorage.removeItem('auth_token');
        localStorage.removeItem('gtr_session_date');
    } catch {}
}

export async function purgeCostFieldsFromLocalCache(): Promise<void> {
    try {
        localStorage.removeItem('cached_products');
        localStorage.removeItem('idxdb_fallback_cached_products');
    } catch {}
}
