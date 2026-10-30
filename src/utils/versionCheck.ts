/**
 * Version Checking and Comparison Utilities for GTR POS
 * 
 * Ensures the running client is synchronized with the latest server build upon login
 * and during active operations, triggering cache purges or update prompts if outdated
 * without causing infinite reload loops between server settings and compiled bundles.
 */

import { hardRefreshApp } from './appRefresh';

declare const __APP_VERSION__: string | undefined;
declare const __APP_BUILD_TIME__: number | undefined;

export const CLIENT_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : "2.4.2";
export const CLIENT_BUILD_TIME: number = typeof __APP_BUILD_TIME__ !== 'undefined' ? Number(__APP_BUILD_TIME__) : 1771466000000;

export interface VersionComparisonResult {
    clientVersion: string;
    serverVersion: string;
    isOutdated: boolean;
    isNewer: boolean;
    isEqual: boolean;
    difference: 'major' | 'minor' | 'patch' | 'none';
    message: string;
}

export interface ValidateLoginVersionOptions {
    autoForceRefresh?: boolean;
    onVersionMismatch?: (result: VersionComparisonResult) => void;
    clientVersionOverride?: string;
}

/**
 * Normalizes a version string into an array of integers [major, minor, patch]
 * Strips leading 'v', extra spaces, or non-numeric metadata.
 */
export function parseVersion(versionStr?: string | null): number[] {
    if (!versionStr || typeof versionStr !== 'string') {
        return [0, 0, 0];
    }
    const clean = versionStr.trim().replace(/^v/i, '');
    const parts = clean.split('.').map(p => {
        const parsed = parseInt(p, 10);
        return isNaN(parsed) ? 0 : parsed;
    });

    while (parts.length < 3) {
        parts.push(0);
    }
    return parts.slice(0, 3);
}

/**
 * Compares two semantic version strings (v1 vs v2).
 * Returns:
 *   -1 if v1 < v2 (v1 is older)
 *    0 if v1 === v2 (equal)
 *    1 if v1 > v2 (v1 is newer)
 */
export function compareVersions(v1: string, v2: string): number {
    const p1 = parseVersion(v1);
    const p2 = parseVersion(v2);

    for (let i = 0; i < 3; i++) {
        if (p1[i] < p2[i]) return -1;
        if (p1[i] > p2[i]) return 1;
    }
    return 0;
}

/**
 * Returns the effective client version by taking the highest semantic version among:
 * 1. The compiled bundle CLIENT_VERSION
 * 2. localStorage 'pwa_acknowledged_server_version' (set when a terminal applies an update)
 * 3. localStorage 'pwa_app_version'
 */
export function getEffectiveClientVersion(baseClientVer: string = CLIENT_VERSION): string {
    let effective = (baseClientVer || CLIENT_VERSION).trim().replace(/^v/i, '');
    if (typeof window !== 'undefined' && window.localStorage) {
        try {
            const ackVer = localStorage.getItem('pwa_acknowledged_server_version');
            if (ackVer && compareVersions(ackVer, effective) > 0) {
                effective = ackVer.trim().replace(/^v/i, '');
            }
            const storedAppVer = localStorage.getItem('pwa_app_version');
            if (storedAppVer && compareVersions(storedAppVer, effective) > 0) {
                effective = storedAppVer.trim().replace(/^v/i, '');
            }
        } catch {}
    }
    return effective;
}

/**
 * Records that the client has acknowledged and applied the specified server version
 * so it will not loop infinitely after reloading.
 */
export function acknowledgeServerVersion(serverVersion?: string | null, buildTime?: number): void {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
        const cleanVer = (serverVersion || CLIENT_VERSION).trim().replace(/^v/i, '');
        if (cleanVer) {
            localStorage.setItem('pwa_acknowledged_server_version', cleanVer);
            localStorage.setItem('pwa_app_version', cleanVer);
        }
        if (buildTime && Number.isFinite(buildTime)) {
            localStorage.setItem('pwa_build_timestamp', String(buildTime));
        }
    } catch {}
}

/**
 * Returns the effective client build timestamp by taking the highest timestamp between
 * CLIENT_BUILD_TIME and localStorage 'pwa_build_timestamp'.
 */
export function getEffectiveClientBuildTime(baseBuildTime: number = CLIENT_BUILD_TIME): number {
    let effective = Number.isFinite(baseBuildTime) ? baseBuildTime : CLIENT_BUILD_TIME;
    if (typeof window !== 'undefined' && window.localStorage) {
        try {
            const stored = localStorage.getItem('pwa_build_timestamp');
            if (stored) {
                const parsed = parseInt(stored, 10);
                if (Number.isFinite(parsed) && parsed > effective) {
                    effective = parsed;
                }
            }
        } catch {}
    }
    return effective;
}

/**
 * Compares the active client version (and optional build timestamp) with a server version.
 */
export function compareClientWithServerVersion(
    serverVersion?: string | null,
    clientVer: string = CLIENT_VERSION,
    serverBuildTime?: number
): VersionComparisonResult {
    const safeClientVer = getEffectiveClientVersion(clientVer);
    const safeServerVer = (serverVersion && typeof serverVersion === 'string' && serverVersion.trim())
        ? serverVersion.trim().replace(/^v/i, '')
        : safeClientVer;

    const cmp = compareVersions(safeClientVer, safeServerVer);
    const effectiveClientBuild = getEffectiveClientBuildTime(CLIENT_BUILD_TIME);
    const isBuildNewer = Boolean(
        cmp === 0 &&
        serverBuildTime &&
        Number.isFinite(serverBuildTime) &&
        serverBuildTime > effectiveClientBuild + 5000
    );

    const isOutdated = cmp < 0 || isBuildNewer;
    const isNewer = cmp > 0;
    const isEqual = cmp === 0 && !isBuildNewer;

    const pClient = parseVersion(safeClientVer);
    const pServer = parseVersion(safeServerVer);

    let difference: 'major' | 'minor' | 'patch' | 'none' = 'none';
    if (pClient[0] !== pServer[0]) {
        difference = 'major';
    } else if (pClient[1] !== pServer[1]) {
        difference = 'minor';
    } else if (pClient[2] !== pServer[2] || isBuildNewer) {
        difference = 'patch';
    }

    let message = `GTR POS v${safeClientVer} está al día con el servidor.`;
    if (isOutdated) {
        message = `Nueva compilación detectada: Cliente v${safeClientVer} vs Servidor v${safeServerVer}. Se aplicará actualización.`;
    } else if (isNewer) {
        message = `Cliente v${safeClientVer} es más reciente que el servidor v${safeServerVer}.`;
    }

    return {
        clientVersion: safeClientVer,
        serverVersion: safeServerVer,
        isOutdated,
        isNewer,
        isEqual,
        difference,
        message
    };
}

/**
 * Fetches the current application version from the backend or static version manifest.
 * Guarantees zero-cache headers so the response is never stale.
 */
export async function fetchCurrentServerVersion(): Promise<{ version: string; releaseNotes?: string; buildTime?: number } | null> {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
        return null;
    }

    try {
        const res = await fetch(`/api/app-version?_t=${Date.now()}`, {
            cache: 'no-store',
            headers: {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            }
        });
        if (res.ok) {
            const data = await res.json();
            if (data?.version) {
                return {
                    version: String(data.version),
                    releaseNotes: data.release_notes || '',
                    buildTime: data.buildTime ? Number(data.buildTime) : undefined
                };
            }
        }
    } catch (e) {
        console.warn("[versionCheck] /api/app-version check failed, trying /version.json fallback:", e);
    }

    // Fallback: Query static version.json
    try {
        const staticRes = await fetch(`/version.json?_t=${Date.now()}`, {
            cache: 'no-store',
            headers: {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            }
        });
        if (staticRes.ok) {
            const staticData = await staticRes.json();
            if (staticData?.version) {
                return {
                    version: String(staticData.version),
                    releaseNotes: staticData.releaseName || '',
                    buildTime: staticData.buildTime ? Number(staticData.buildTime) : undefined
                };
            }
        }
    } catch (e) {
        console.warn("[versionCheck] /version.json fallback check failed:", e);
    }

    return null;
}

/**
 * Validates the application version upon user login.
 * Compares effective client version with the version payload returned by /api/auth/login.
 */
export async function validateVersionOnLogin(
    loginPayload?: any,
    options: ValidateLoginVersionOptions = {}
): Promise<VersionComparisonResult> {
    const { 
        autoForceRefresh = false, 
        onVersionMismatch, 
        clientVersionOverride = CLIENT_VERSION 
    } = options;

    let reportedServerVersion = loginPayload?.app_version 
        || loginPayload?.server_version 
        || loginPayload?.version;

    // Fallback: If not present in login payload, query server version helper
    if (!reportedServerVersion && navigator.onLine) {
        const fetched = await fetchCurrentServerVersion();
        if (fetched?.version) {
            reportedServerVersion = fetched.version;
        }
    }

    const result = compareClientWithServerVersion(reportedServerVersion, clientVersionOverride);

    if (result.isOutdated) {
        console.warn(`[validateVersionOnLogin] ${result.message}`);
        
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('app-update-available', {
                detail: {
                    version: result.serverVersion,
                    clientVersion: result.clientVersion,
                    source: 'login_validation'
                }
            }));
        }

        if (onVersionMismatch) {
            onVersionMismatch(result);
        }

        if (autoForceRefresh) {
            console.info("[validateVersionOnLogin] Auto-forcing application refresh for outdated client...");
            acknowledgeServerVersion(result.serverVersion);
            await hardRefreshApp();
        }
    }

    return result;
}
