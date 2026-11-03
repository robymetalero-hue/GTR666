import { safeDispatchEvent } from "../utils/events";
import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { User, CartItem, Product, Client, ReceiptTemplate, Department, SaleTab, RgbThemeSettings } from '../types';
import { normalizePermissions } from '../utils/permissions';
import { initializeApp, getApps, getApp } from 'firebase/app';
import { initializeFirestore, getFirestore, doc, setDoc, onSnapshot, getDocFromServer, setLogLevel } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { 
    getOfflineSales, 
    deleteOfflineSale, 
    getOfflineActions, 
    deleteOfflineAction, 
    saveOfflineAction, 
    hasOfflineActions, 
    hasOfflineSales, 
    cacheAppState, 
    getCachedAppState,
    getOfflineStats,
    markOperationCompleted,
    isOperationCompleted,
    purgeStaleOfflineQueuesAndCaches,
    getBoliviaDateString,
    performDailyDeepDeviceWipe
} from '../utils/offlineStorage';
import { saveHotUpdateSnapshot, hardRefreshApp } from '../utils/appRefresh';
import {
    getCachedUserProfile,
    setCachedUserProfile,
    getCachedMinimalProducts,
    setCachedMinimalProducts,
    purgeCostFieldsFromLocalCache
} from '../utils/localForageCache';
import {
    CLIENT_VERSION,
    CLIENT_BUILD_TIME,
    compareVersions,
    getEffectiveClientVersion,
    acknowledgeServerVersion
} from '../utils/versionCheck';
import {
    syncAdminPushSubscriptionIfGranted,
    isOwnerOrAdminForPush
} from '../utils/pushNotifications';

// Initialize Client-Side Firebase SDK with auto-detect long polling to prevent stream timeouts
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const dbId = (firebaseConfig as any).firestoreDatabaseId || '(default)';

let firestoreInstance;
try {
  firestoreInstance = initializeFirestore(app, {
    experimentalAutoDetectLongPolling: true,
  }, dbId);
} catch (e) {
  firestoreInstance = dbId && dbId !== '(default)' ? getFirestore(app, dbId) : getFirestore(app);
}

export const firestoreDb = firestoreInstance;

// Silence internal Firestore SDK connection logs (warnings/info)
try {
  setLogLevel('silent');
} catch (e) {}

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errMessage = error instanceof Error ? error.message : String(error);
  const errInfo: FirestoreErrorInfo = {
    error: errMessage,
    authInfo: {
      userId: null,
      email: null,
      emailVerified: null,
      isAnonymous: null,
      tenantId: null
    },
    operationType,
    path
  };
  
  const isPermissionError = errMessage.toLowerCase().includes('permission') || 
                            errMessage.toLowerCase().includes('insufficient') || 
                            errMessage.toLowerCase().includes('denied');

  if (isPermissionError) {
    console.error('Firestore Error: ', JSON.stringify(errInfo));
    throw new Error(JSON.stringify(errInfo));
  } else {
    // Standard connection or availability limitations are logged as console warnings to prevent blocking diagnostic error tracking
    console.warn(`[Sync Offline Mode] Standard local database operates standalone. Remote cloud sync is bypassed due to connectivity/offline status: ${errMessage}`);
  }
}

// Validate Connection to Firestore and warn if client is offline
async function testConnection() {
  try {
    await getDocFromServer(doc(firestoreDb, 'test', 'connection'));
  } catch (error: any) {
    // Safely catch any connectivity error without throwing or raising console errors
    console.log(`[Sync Connection Test] Note: Cloud backend connection is not active currently (${error?.message || error}). POS local SQLite is fully interactive.`);
  }
}
testConnection();

export type ViewType = 'inicio' | 'pos' | 'ventas_pendientes' | 'historial_ventas' | 'productos' | 'departamentos' | 'inventario' | 'auditoria' | 'devoluciones' | 'reportes' | 'analisis' | 'usuarios' | 'configuraciones' | 'cajas';

interface AppContextType {
    isInitializing: boolean;
    kioskMode: boolean;
    setKioskMode: (k: boolean) => void;
    isKioskLocked: boolean;
    requestSupervisorAuth: (actionLabel: string, onAuthorized: () => void) => void;
    isSupervisorUnlocked: boolean;
    setIsSupervisorUnlocked: (val: boolean) => void;
    supervisorInfo: { id: number; username: string; role: string } | null;
    setSupervisorInfo: (info: { id: number; username: string; role: string } | null) => void;
    relockKiosk: () => void;
    isFullscreen: boolean;
    toggleFullscreen: () => void;
    user: User | null;
    setUser: (u: User | null) => void;
    darkMode: boolean;
    setDarkMode: (d: boolean) => void;
    cart: CartItem[];
    addToCart: (product: Product, quantity?: number) => void;
    updateCartItemQuantity: (productId: number, qty: number) => void;
    removeFromCart: (productId: number) => void;
    clearCart: (isCompletedSale?: boolean) => void;
    lastClearedCart: CartItem[] | null;
    lastClearedMeta: any;
    cartBackup: CartItem[] | null;
    cartBackupMeta: any;
    restoreLastClearedCart: () => boolean;
    restoreCartBackup: () => boolean;
    discardCartBackup: () => void;
    updateCartItemPrice: (productId: number, priceType: 'unit' | 'bulk' | 'custom', customPrice?: number, customPriceBs?: number) => void;
    products: Product[];
    clients: Client[];
    fetchProducts: (searchQuery?: string) => Promise<void>;
    fetchClients: () => Promise<void>;
    hasMoreProducts: boolean;
    totalProducts: number;
    loadMoreProducts: (searchQuery?: string) => Promise<void>;
    view: ViewType;
    setView: (v: ViewType) => void;
    exchangeRate: number;
    setExchangeRate: (r: number) => void;
    fetchExchangeRate: () => Promise<void>;
    roundBs: (num: number) => number;
    isOffline: boolean;
    setIsOffline: React.Dispatch<React.SetStateAction<boolean>>;
    receiptTemplate: ReceiptTemplate;
    updateReceiptTemplate: (tpl: ReceiptTemplate) => Promise<void>;
    fetchReceiptTemplate: () => Promise<void>;
    departments: Department[];
    fetchDepartments: () => Promise<void>;
    tabs: SaleTab[];
    setTabs: React.Dispatch<React.SetStateAction<SaleTab[]>>;
    activeTabId: number;
    setActiveTabId: React.Dispatch<React.SetStateAction<number>>;
    clientName: string;
    setClientName: React.Dispatch<React.SetStateAction<string>>;
    clientPhone: string;
    setClientPhone: React.Dispatch<React.SetStateAction<string>>;
    discount: number;
    setDiscount: React.Dispatch<React.SetStateAction<number>>;
    discountType: 'monto' | 'porcentaje';
    setDiscountType: React.Dispatch<React.SetStateAction<'monto' | 'porcentaje'>>;
    paymentMethod: 'Efectivo' | 'Tarjeta' | 'Transferencia' | 'Crédito' | 'Mixto';
    setPaymentMethod: React.Dispatch<React.SetStateAction<'Efectivo' | 'Tarjeta' | 'Transferencia' | 'Crédito' | 'Mixto'>>;
    theme: string;
    setTheme: React.Dispatch<React.SetStateAction<string>>;
    rgbSettings: RgbThemeSettings;
    setRgbSettings: React.Dispatch<React.SetStateAction<RgbThemeSettings>>;
    isSyncing: boolean;
    triggerOnlineSync: () => Promise<void>;
    syncError: string | null;
    setSyncError: React.Dispatch<React.SetStateAction<string | null>>;
    
    // Offline & Sync Engine
    networkLatency: number | null;
    networkQuality: 'online' | 'offline' | 'unstable';
    pendingSalesCount: number;
    pendingActionsCount: number;
    isOfflineModalOpen: boolean;
    setIsOfflineModalOpen: (b: boolean) => void;
    deductLocalProductStock: (items: Array<{ product_id: number; quantity: number }>) => void;
    registerLocalClient: (client: { id: string | number; name: string; phone?: string }) => void;

    // S.I.T.A. Autonomous QA Testing Systems
    isAutonomousTesting: boolean;
    setIsAutonomousTesting: (b: boolean) => void;
    autonomousStep: number;
    setAutonomousStep: (n: number) => void;
    autonomousLogs: string[];
    setAutonomousLogs: React.Dispatch<React.SetStateAction<string[]>>;
    apiPingResults: any;
    setApiPingResults: (results: any) => void;

    // PWA Install & Bulletproof Update Properties
    pwaPrompt: any;
    setPwaPrompt: (prompt: any) => void;
    installPWA: () => Promise<void>;
    isPwaInstalled: boolean;
    setIsPwaInstalled: (b: boolean) => void;
    isPwaInstallModalOpen: boolean;
    setIsPwaInstallModalOpen: (b: boolean) => void;
    hasPwaUpdate: boolean;
    isUpdatingPwa: boolean;
    pwaUpdateStepMessage: string;
    pwaVersionInfo: { currentVersion: string; latestVersion: string; buildTime: number };
    checkForPwaUpdates: () => Promise<boolean>;
    applyPwaUpdate: () => Promise<void>;
    handlePwaPrimaryAction: () => Promise<void>;
    showNotification?: (message: string, type?: 'success' | 'error' | 'warn' | 'info') => void;
    inventoryLock: { isLocked: boolean; activeCount: any | null; pendingApproval?: boolean; diffCount?: number };
    fetchInventoryLockStatus: () => Promise<void>;
}

/**
 * Fail-safe wrapper around localStorage.setItem.
 * Prevents QuotaExceededError or DOMException from breaking application execution
 * when storing large payloads (e.g. products catalogue). Large datasets are safely
 * preserved in IndexedDB via cacheAppState.
 */
export function safeLocalStorageSetItem(key: string, value: string): boolean {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (e: any) {
        console.warn(`[Storage Warning] localStorage quota exceeded or restricted for key "${key}". Relying on IndexedDB storage.`, e?.message || e);
        return false;
    }
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [isInitializing, setIsInitializing] = useState(false);
    const [kioskMode, setKioskMode] = useState(() => localStorage.getItem('kioskMode') === 'true');
    const [isSupervisorUnlocked, setIsSupervisorUnlocked] = useState(false);
    const [supervisorInfo, setSupervisorInfo] = useState<{ id: number; username: string; role: string } | null>(null);
    const [isFullscreen, setIsFullscreen] = useState<boolean>(() => typeof document !== 'undefined' ? !!document.fullscreenElement : false);
    const [inventoryLock, setInventoryLock] = useState<{ isLocked: boolean; activeCount: any | null }>({ isLocked: false, activeCount: null });

    useEffect(() => {
        const handleFullscreenChange = () => {
            setIsFullscreen(typeof document !== 'undefined' ? !!document.fullscreenElement : false);
        };
        document.addEventListener('fullscreenchange', handleFullscreenChange);
        document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
        return () => {
            document.removeEventListener('fullscreenchange', handleFullscreenChange);
            document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
        };
    }, []);

    const toggleFullscreen = useCallback(() => {
        try {
            if (!document.fullscreenElement) {
                if (document.documentElement.requestFullscreen) {
                    document.documentElement.requestFullscreen().catch(() => {});
                } else if ((document.documentElement as any).webkitRequestFullscreen) {
                    (document.documentElement as any).webkitRequestFullscreen();
                }
            } else {
                if (document.exitFullscreen) {
                    document.exitFullscreen().catch(() => {});
                } else if ((document as any).webkitExitFullscreen) {
                    (document as any).webkitExitFullscreen();
                }
            }
        } catch (err) {
            console.warn("Fullscreen toggle error:", err);
        }
    }, []);

    const relockKiosk = useCallback(() => {
        setIsSupervisorUnlocked(false);
        setSupervisorInfo(null);
    }, []);

    const requestSupervisorAuth = useCallback((actionLabel: string, onAuthorized: () => void) => {
        if (isSupervisorUnlocked) {
            onAuthorized();
            return;
        }
        window.dispatchEvent(new CustomEvent('gtr-request-supervisor-auth', {
            detail: { actionLabel, onAuthorized }
        }));
    }, [isSupervisorUnlocked]);

    // Kiosk V2 Security: Auto-relock kiosk after 5 minutes of inactivity when supervisor is unlocked
    useEffect(() => {
        if (!isSupervisorUnlocked) return;

        let timeoutId: any;
        const resetTimer = () => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => {
                console.log("[Kiosk Security V2] Supervisor session expired due to inactivity. Relocking kiosk.");
                relockKiosk();
            }, 5 * 60 * 1000); // 5 minutes inactivity timeout
        };

        resetTimer();
        const activityEvents = ['mousedown', 'keydown', 'touchstart', 'scroll'];
        const handleActivity = () => resetTimer();
        activityEvents.forEach(evt => window.addEventListener(evt, handleActivity, { passive: true }));

        return () => {
            clearTimeout(timeoutId);
            activityEvents.forEach(evt => window.removeEventListener(evt, handleActivity));
        };
    }, [isSupervisorUnlocked, relockKiosk]);

    const [isOffline, setIsOffline] = useState(false);
    const [isSyncing, setIsSyncing] = useState(false);
    const syncRunningRef = useRef(false);
    const inFlightSaleIdsRef = useRef<Set<string>>(new Set());
    const inFlightActionIdsRef = useRef<Set<string>>(new Set());
    const [syncError, setSyncError] = useState<string | null>(null);

    // Offline & Sync Engine States
    const [networkLatency, setNetworkLatency] = useState<number | null>(null);
    const [networkQuality, setNetworkQuality] = useState<'online' | 'offline' | 'unstable'>('online');
    const [pendingSalesCount, setPendingSalesCount] = useState<number>(0);
    const [pendingActionsCount, setPendingActionsCount] = useState<number>(0);
    const [isOfflineModalOpen, setIsOfflineModalOpen] = useState<boolean>(false);

    // PWA & Bulletproof Update Lifecycle States
    const [pwaPrompt, setPwaPrompt] = useState<any>(null);
    const [isPwaInstallModalOpen, setIsPwaInstallModalOpen] = useState<boolean>(false);
    const [isPwaInstalled, setIsPwaInstalled] = useState<boolean>(() => {
        const standalone = window.matchMedia('(display-mode: standalone)').matches || (window.navigator as any).standalone === true;
        const localFlag = localStorage.getItem('pwa_installed') === 'true';
        return standalone || localFlag;
    });
    const [hasPwaUpdate, setHasPwaUpdate] = useState<boolean>(false);
    const [isUpdatingPwa, setIsUpdatingPwa] = useState<boolean>(false);
    const [pwaUpdateStepMessage, setPwaUpdateStepMessage] = useState<string>('Iniciando...');
    const [pwaVersionInfo, setPwaVersionInfo] = useState<{ currentVersion: string; latestVersion: string; buildTime: number }>(() => {
        const storedBuild = localStorage.getItem('pwa_build_timestamp');
        const effectiveVer = getEffectiveClientVersion(CLIENT_VERSION);
        return {
            currentVersion: effectiveVer,
            latestVersion: effectiveVer,
            buildTime: storedBuild ? parseInt(storedBuild, 10) : CLIENT_BUILD_TIME
        };
    });

    // Check for updates against both the Service Worker and the version.json manifest
    const checkForPwaUpdates = async (): Promise<boolean> => {
        let updateFound = false;
        try {
            const effectiveCurrent = getEffectiveClientVersion(pwaVersionInfo.currentVersion);

            // 1. Service Worker update check
            if ('serviceWorker' in navigator && (window as any).__pwaServiceWorkerReg) {
                const reg = (window as any).__pwaServiceWorkerReg;
                await reg.update().catch(() => {});
                if (reg.waiting) {
                    setHasPwaUpdate(true);
                    updateFound = true;
                }
            }

            // 2. HTTP Version and API manifest ping
            if (navigator.onLine) {
                // Check static version.json
                const res = await fetch(`/version.json?t=${Date.now()}`, {
                    cache: 'no-store',
                    headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
                }).catch(() => null);

                if (res && res.ok) {
                    const data = await res.json().catch(() => null);
                    if (data && data.version) {
                        if (compareVersions(String(data.version), effectiveCurrent) > 0) {
                            setPwaVersionInfo(prev => ({
                                ...prev,
                                latestVersion: String(data.version),
                                buildTime: Number(data.buildTime || prev.buildTime)
                            }));
                            setHasPwaUpdate(true);
                            updateFound = true;
                        }
                    }
                }

                // Also check /api/app-version endpoint
                const apiRes = await fetch(`/api/app-version?t=${Date.now()}`, {
                    cache: 'no-store',
                    headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
                }).catch(() => null);
                if (apiRes && apiRes.ok) {
                    const apiData = await apiRes.json().catch(() => null);
                    if (apiData && apiData.version && compareVersions(String(apiData.version), effectiveCurrent) > 0) {
                        setPwaVersionInfo(prev => ({
                            ...prev,
                            latestVersion: String(apiData.version),
                            buildTime: Number(apiData.buildTime || prev.buildTime)
                        }));
                        setHasPwaUpdate(true);
                        updateFound = true;
                    }
                }
            }
        } catch (err) {
            console.warn('[PWA] Update check bypassed (offline/unreachable):', err);
        }
        return updateFound;
    };

    // Apply PWA update cleanly with Hot-Swap snapshot, purging old assets while preserving active cart, tabs, session, push & offline queues
    const applyPwaUpdate = async () => {
        setIsUpdatingPwa(true);
        setPwaUpdateStepMessage('Respaldando carrito y sesión...');
        if (showNotification) {
            showNotification('Actualizando a la última versión conservando tu carrito y sesión...', 'info');
        }

        try {
            saveHotUpdateSnapshot({
                cart,
                tabs,
                activeTabId,
                clientName,
                clientPhone,
                discount,
                discountType,
                paymentMethod,
                view,
                targetVersion: pwaVersionInfo.latestVersion
            });
            acknowledgeServerVersion(pwaVersionInfo.latestVersion, pwaVersionInfo.buildTime);
            await hardRefreshApp();
        } catch (e) {
            console.error('[PWA] Error applying update:', e);
            acknowledgeServerVersion(pwaVersionInfo.latestVersion, pwaVersionInfo.buildTime);
            setPwaUpdateStepMessage('Recargando terminal...');
            window.location.reload();
        }
    };

    // Unified single button action handler (No new buttons added to screens)
    const handlePwaPrimaryAction = async () => {
        if (hasPwaUpdate) {
            // If there's an update, this button forces the update directly
            await applyPwaUpdate();
        } else if (!isPwaInstalled) {
            // If not installed, this button triggers install / installation modal
            await installPWA();
        } else {
            // If already installed and up to date, check for new updates
            const found = await checkForPwaUpdates();
            if (!found) {
                if (showNotification) {
                    showNotification('GTR POS está al día con la última versión disponible.', 'success');
                } else {
                    setIsPwaInstallModalOpen(true);
                }
            }
        }
    };

    useEffect(() => {
        const handleBeforeInstall = (e: any) => {
            e.preventDefault();
            setPwaPrompt(e);
        };
        window.addEventListener('beforeinstallprompt', handleBeforeInstall);

        const handleAppInstalled = () => {
            setIsPwaInstalled(true);
            localStorage.setItem('pwa_installed', 'true');
            setPwaPrompt(null);
        };
        window.addEventListener('appinstalled', handleAppInstalled);

        // Listen for PWA update available events
        const handleUpdateAvailable = () => {
            console.log('[PWA] Evento pwa-update-available recibido. Activando botón de actualización.');
            setHasPwaUpdate(true);
        };
        window.addEventListener('pwa-update-available', handleUpdateAvailable);

        // Automatic update checker on window focus and periodic interval
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible' && navigator.onLine) {
                checkForPwaUpdates();
            }
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);

        // Periodic background check every 3 minutes
        const updateInterval = setInterval(() => {
            if (navigator.onLine) {
                checkForPwaUpdates();
            }
        }, 180000);

        // Initial check
        checkForPwaUpdates();

        return () => {
            window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
            window.removeEventListener('appinstalled', handleAppInstalled);
            window.removeEventListener('pwa-update-available', handleUpdateAvailable);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            clearInterval(updateInterval);
        };
    }, []);

    const installPWA = async () => {
        if (pwaPrompt) {
            try {
                pwaPrompt.prompt();
                const { outcome } = await pwaPrompt.userChoice;
                if (outcome === 'accepted') {
                    setPwaPrompt(null);
                    setIsPwaInstalled(true);
                    localStorage.setItem('pwa_installed', 'true');
                    return;
                }
            } catch (e) {
                console.error("Error during pwaPrompt.prompt():", e);
            }
        }
        // Always open the dedicated PWA modal for complete guidance and alternative options
        setIsPwaInstallModalOpen(true);
    };

    // S.I.T.A. Autonomous active variables
    const [isAutonomousTesting, setIsAutonomousTesting] = useState(false);
    const [autonomousStep, setAutonomousStep] = useState(0);
    const [autonomousLogs, setAutonomousLogs] = useState<string[]>([]);
    const [apiPingResults, setApiPingResults] = useState<any>(null);

    const offlineGraceStartRef = useRef<number | null>(null);

    useEffect(() => {
        const handleOnline = () => {
            offlineGraceStartRef.current = null;
            setIsOffline(false);
            console.log("[Sync] Device returned online. Fetching latest remote database state...");
            fetchProducts();
            fetchClients();
            fetchExchangeRate();
        };
        const handleOffline = () => {
            // Silent Grace Mode (45s): Do NOT lock the screen immediately on transient Wi-Fi/mobile antenna switches.
            // Start the 45-second silent grace clock; checkHealth will poll every 2s and only lock if still offline after 45s.
            if (offlineGraceStartRef.current === null) {
                offlineGraceStartRef.current = Date.now();
            }
        };
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
        return () => {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
        };
    }, []);

    const fetchWithRetry = async (url: string, options?: RequestInit, retries = 2, delay = 500): Promise<Response> => {
        let timeoutId: any;
        try {
            let signal = options?.signal;
            if (!signal && typeof AbortController !== 'undefined') {
                const controller = new AbortController();
                timeoutId = setTimeout(() => controller.abort(), 15000);
                signal = controller.signal;
            }

            // Automatically inject Authorization token if available in local storage
            const token = typeof localStorage !== 'undefined' ? localStorage.getItem('auth_token') : null;
            const finalHeaders: Record<string, string> = {};
            if (options?.headers) {
                if (options.headers instanceof Headers) {
                    options.headers.forEach((val, key) => { finalHeaders[key] = val; });
                } else if (Array.isArray(options.headers)) {
                    options.headers.forEach(([key, val]) => { finalHeaders[key] = val; });
                } else {
                    Object.assign(finalHeaders, options.headers);
                }
            }
            if (token && !finalHeaders['Authorization'] && !finalHeaders['authorization']) {
                finalHeaders['Authorization'] = `Bearer ${token}`;
            }

            if (typeof window !== 'undefined' && !finalHeaders['x-app-environment']) {
                const isSandbox = localStorage.getItem('gtr_sandbox_mode') === 'true';
                finalHeaders['x-app-environment'] = isSandbox ? 'sandbox' : 'production';
            }

            const response = await fetch(url, { ...options, headers: finalHeaders, signal });
            if (timeoutId) clearTimeout(timeoutId);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response;
        } catch (error) {
            if (timeoutId) clearTimeout(timeoutId);
            if (retries > 0) {
                console.warn(`[Sync Retry] Fetch to ${url} failed. Retrying in ${delay}ms... (${retries} retries left)`);
                await new Promise((resolve) => setTimeout(resolve, delay));
                return fetchWithRetry(url, options, retries - 1, delay * 1.5);
            }
            throw error;
        }
    };

    // Daily Mandatory Login Check: Only restore user session if gtr_session_date matches today's calendar date in Bolivia
    const [user, setUserState] = useState<User | null>(() => {
        try {
            const sessionDate = localStorage.getItem('gtr_session_date');
            const todayBolivia = getBoliviaDateString();
            if (!sessionDate || sessionDate !== todayBolivia) {
                localStorage.removeItem('user');
                localStorage.removeItem('auth_token');
                localStorage.removeItem('gtr_session_date');
                return null;
            }
            const u = localStorage.getItem('user');
            if (u) {
                const parsed = JSON.parse(u);
                if (parsed && parsed.username !== 'none' && parsed.role !== 'none') {
                    if (parsed.permissions) {
                        parsed.permissions = normalizePermissions(parsed.permissions);
                    }
                    return parsed; 
                }
            }
        } catch {
            return null;
        }
        return null;
    });

    // Real-time synchronization is managed locally for each independent terminal session.
    // We do not subscribe to a single global active_session document to prevent cross-logout conflicts.

    const setUser = (u: User | null) => {
        const normalizedUser = u ? {
            ...u,
            permissions: normalizePermissions(u.permissions)
        } as User : null;
        
        setUserState(normalizedUser);
        try {
            if (normalizedUser) {
                localStorage.setItem('user', JSON.stringify(normalizedUser));
                // Security Patch: Purge cost fields from local cache & state if user is non-admin without cost permissions
                const perms = (normalizedUser.permissions || {}) as Record<string, any>;
                const roleStr = String(normalizedUser.role || '').toLowerCase();
                const isNonAdminWithoutCost = roleStr !== 'admin' && !perms.view_costs && !perms.view_purchase_prices;
                if (isNonAdminWithoutCost) {
                    purgeCostFieldsFromLocalCache().catch(() => {});
                    setProducts(prev => prev.map(p => ({ ...p, price_cost: undefined })));
                }
            } else {
                localStorage.removeItem('user');
                localStorage.removeItem('auth_token');
                localStorage.removeItem('gtr_session_date');
                setIsSupervisorUnlocked(false);
                setSupervisorInfo(null);
            }
            setCachedUserProfile(normalizedUser).catch(() => {});
        } catch (err) {
            console.error("Failed to save local user session state:", err);
        }
    };

    // Real-time synchronization of user permissions & role with the server database state
    useEffect(() => {
        if (!user) return;

        const syncUserSession = async () => {
            // Guard: Avoid wasteful continuous network errors when the client is disconnected
            if (navigator.onLine === false) return;

            try {
                const authToken = localStorage.getItem('auth_token');
                const res = await fetch('/api/auth/me', {
                    headers: {
                        'x-user-id': String(user.id),
                        'x-user-role': user.role || '',
                        ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {})
                    }
                });
                if (res.ok) {
                    const freshUser = await res.json();
                    
                    const localPerms = JSON.stringify(normalizePermissions(user.permissions));
                    const remotePerms = JSON.stringify(normalizePermissions(freshUser.permissions));
                    
                    if (
                        user.role !== freshUser.role || 
                        user.username !== freshUser.username || 
                        user.email !== freshUser.email || 
                        localPerms !== remotePerms
                    ) {
                        console.log("[Sync] User role/permissions updated on server, synchronizing session...", freshUser);
                        setUser(freshUser);
                    }
                } else if (res.status === 401) {
                    console.warn("[Sync] Session expired or invalidated on server (401). Executing deep wipe and requiring login.");
                    await performDailyDeepDeviceWipe(false);
                    sessionStorage.setItem('gtr_login_last_error', 'Tu sesión diaria ha finalizado. Por favor, ingresa tu usuario y contraseña para continuar.');
                    setUser(null);
                }
            } catch (err) {
                console.warn("[Sync] Background session sync failed:", err);
            }
        };

        const checkDailyMidnightExpiration = async () => {
            const sessionDate = localStorage.getItem('gtr_session_date');
            const todayBolivia = getBoliviaDateString();
            if (!sessionDate || sessionDate !== todayBolivia) {
                console.warn(`[Daily Auth] New calendar day detected (${sessionDate} -> ${todayBolivia}). Wiping device caches and requiring daily login.`);
                await performDailyDeepDeviceWipe(false);
                sessionStorage.setItem('gtr_login_last_error', 'Nuevo día de operación: Se limpiaron todos los registros temporales del dispositivo. Ingrese su usuario y contraseña.');
                setUser(null);
                return true;
            }
            return false;
        };

        // Run immediately on mount or user change
        checkDailyMidnightExpiration().then((expired) => {
            if (!expired) syncUserSession();
        });

        const handleVis = () => {
            if (document.visibilityState === 'visible') {
                checkDailyMidnightExpiration().then((expired) => {
                    if (!expired && navigator.onLine) {
                        syncUserSession();
                        fetchProducts(undefined, true);
                    }
                });
            }
        };
        document.addEventListener('visibilitychange', handleVis);

        // Check for updates and midnight expiration every 10 seconds
        const intervalId = setInterval(async () => {
            const expired = await checkDailyMidnightExpiration();
            if (!expired) {
                syncUserSession();
            }
        }, 10000);
        return () => {
            document.removeEventListener('visibilitychange', handleVis);
            clearInterval(intervalId);
        };
    }, [user?.id]);

    const [darkMode, setDarkMode] = useState(() => {
        return localStorage.getItem('darkMode') === 'true';
    });

    const [theme, setTheme] = useState(() => {
        return localStorage.getItem('theme') || 'emerald';
    });

    const [rgbSettings, setRgbSettings] = useState<RgbThemeSettings>(() => {
        try {
            const saved = localStorage.getItem('rgb_theme_settings');
            if (saved) {
                const parsed = JSON.parse(saved);
                if (!parsed.animationStyle) parsed.animationStyle = 'smooth';
                return parsed;
            }
        } catch (e) {
            console.error("Failed to parse rgb settings", e);
        }
        return {
            effectType: 'aiStudio',
            speed: 14,
            glowIntensity: 'normal',
            angle: 135,
            customColors: ['#4285F4', '#8B5CF6', '#EC4899', '#06B6D4', '#3B82F6'],
            animationStyle: 'smooth'
        };
    });

    const [view, setViewInternal] = useState<ViewType>(() => {
        try {
            const saved = localStorage.getItem('cached_current_view');
            return (saved as ViewType) || 'pos';
        } catch {
            return 'pos';
        }
    });

    const setView = (v: ViewType) => {
        setViewInternal(v);
        try {
            localStorage.setItem('cached_current_view', v);
        } catch (e) {
            console.error("Failed to cache current view:", e);
        }
    };

    // State for multi-comanda tabs
    const [tabs, setTabs] = useState<SaleTab[]>(() => {
        try {
            const cached = localStorage.getItem('cached_sales_tabs');
            return cached ? JSON.parse(cached) : [
                { id: 1, name: "Venta 1", cart: [], clientName: "", clientPhone: "", discount: 0, discountType: 'monto', paymentMethod: 'Efectivo' }
            ];
        } catch {
            return [
                { id: 1, name: "Venta 1", cart: [], clientName: "", clientPhone: "", discount: 0, discountType: 'monto', paymentMethod: 'Efectivo' }
            ];
        }
    });
    const [activeTabId, setActiveTabId] = useState<number>(() => {
        try {
            const cached = localStorage.getItem('cached_active_tab_id');
            return cached ? parseInt(cached) : 1;
        } catch {
            return 1;
        }
    });

    const getInitialTab = () => {
        // Find saved tab or default to first
        const found = tabs.find(t => t.id === activeTabId) || tabs[0];
        return found || { id: 1, name: "Venta 1", cart: [], clientName: "", clientPhone: "", discount: 0, discountType: 'monto', paymentMethod: 'Efectivo' };
    };

    const initialTab = getInitialTab();

    const [clientName, setClientName] = useState(() => initialTab.clientName || "");
    const [clientPhone, setClientPhone] = useState(() => initialTab.clientPhone || "");
    const [discount, setDiscount] = useState(() => initialTab.discount || 0);
    const [discountType, setDiscountType] = useState<'monto' | 'porcentaje'>(() => initialTab.discountType || 'monto');
    const [paymentMethod, setPaymentMethod] = useState<'Efectivo' | 'Tarjeta' | 'Transferencia' | 'Crédito' | 'Mixto'>(() => initialTab.paymentMethod || 'Efectivo');
    const [cart, setCart] = useState<CartItem[]>(() => initialTab.cart || []);

    // Safety recall & recovery buffer states
    const [lastClearedCart, setLastClearedCart] = useState<CartItem[] | null>(() => {
        try {
            const saved = localStorage.getItem('gtr_pos_last_cleared_cart');
            if (saved) {
                const parsed = JSON.parse(saved);
                if (Array.isArray(parsed.cart) && parsed.cart.length > 0) return parsed.cart;
            }
        } catch {}
        return null;
    });

    const [lastClearedMeta, setLastClearedMeta] = useState<any>(() => {
        try {
            const saved = localStorage.getItem('gtr_pos_last_cleared_cart');
            if (saved) {
                const parsed = JSON.parse(saved);
                return {
                    clientName: parsed.clientName,
                    clientPhone: parsed.clientPhone,
                    discount: parsed.discount,
                    discountType: parsed.discountType,
                    paymentMethod: parsed.paymentMethod,
                    timestamp: parsed.timestamp
                };
            }
        } catch {}
        return null;
    });

    const [cartBackup, setCartBackup] = useState<CartItem[] | null>(() => {
        try {
            const saved = localStorage.getItem('gtr_pos_active_cart_backup');
            if (saved) {
                const parsed = JSON.parse(saved);
                if (Array.isArray(parsed.cart) && parsed.cart.length > 0) return parsed.cart;
            }
        } catch {}
        return null;
    });

    const [cartBackupMeta, setCartBackupMeta] = useState<any>(() => {
        try {
            const saved = localStorage.getItem('gtr_pos_active_cart_backup');
            if (saved) {
                const parsed = JSON.parse(saved);
                return {
                    clientName: parsed.clientName,
                    clientPhone: parsed.clientPhone,
                    discount: parsed.discount,
                    discountType: parsed.discountType,
                    paymentMethod: parsed.paymentMethod,
                    timestamp: parsed.timestamp
                };
            }
        } catch {}
        return null;
    });

    // Auto-save rolling backup whenever active cart has items
    useEffect(() => {
        if (cart.length > 0) {
            try {
                const payload = {
                    cart,
                    clientName,
                    clientPhone,
                    discount,
                    discountType,
                    paymentMethod,
                    activeTabId,
                    timestamp: new Date().toISOString()
                };
                localStorage.setItem('gtr_pos_active_cart_backup', JSON.stringify(payload));
            } catch (e) {
                console.error("Failed saving active cart safety backup:", e);
            }
        } else {
            // When cart is empty, ensure active cart backup is cleanly removed
            try {
                localStorage.removeItem('gtr_pos_active_cart_backup');
            } catch (e) {}
        }
    }, [cart, clientName, clientPhone, discount, discountType, paymentMethod, activeTabId]);

    // Sync tabs list and active ID to localStorage and IndexedDB
    useEffect(() => {
        localStorage.setItem('cached_sales_tabs', JSON.stringify(tabs));
        cacheAppState('cached_sales_tabs', tabs);
    }, [tabs]);

    useEffect(() => {
        localStorage.setItem('cached_active_tab_id', String(activeTabId));
    }, [activeTabId]);

    // Sync active tab state to local variables when activeTabId changes
    useEffect(() => {
        const activeTab = tabs.find(t => t.id === activeTabId);
        if (activeTab) {
            setCart(activeTab.cart || []);
            setClientName(activeTab.clientName || "");
            setClientPhone(activeTab.clientPhone || "");
            setDiscount(activeTab.discount || 0);
            setDiscountType(activeTab.discountType || 'monto');
            setPaymentMethod(activeTab.paymentMethod || 'Efectivo');
        }
    }, [activeTabId]);

    // Sync state variables back to the tabs list
    useEffect(() => {
        setTabs(prev => prev.map(t => {
            if (t.id === activeTabId) {
                return {
                    ...t,
                    cart,
                    clientName,
                    clientPhone,
                    discount,
                    discountType,
                    paymentMethod
                };
            }
            return t;
        }));
    }, [cart, clientName, clientPhone, discount, discountType, paymentMethod, activeTabId]);
    const [products, setProducts] = useState<Product[]>([]);
    const [hasMoreProducts, setHasMoreProducts] = useState(false);
    const [totalProducts, setTotalProducts] = useState(0);
    const [productsOffset, setProductsOffset] = useState(0);
    const [clients, setClients] = useState<Client[]>([]);
    const [exchangeRate, setExchangeRateInternal] = useState<number>(() => {
        try {
            const cached = localStorage.getItem('cached_exchange_rate');
            if (cached) {
                const parsed = parseFloat(cached);
                return (isNaN(parsed) || parsed <= 0) ? 6.96 : parsed;
            }
            return 6.96;
        } catch {
            return 6.96;
        }
    });

    const setExchangeRate = (rate: any) => {
        try {
            const val = typeof rate === 'function' ? rate(exchangeRate) : rate;
            const parsed = parseFloat(val);
            const safe = (isNaN(parsed) || parsed <= 0) ? 6.96 : parsed;
            setExchangeRateInternal(safe);
            localStorage.setItem('cached_exchange_rate', String(safe));
            cacheAppState('cached_exchange_rate', safe).catch(() => {});
        } catch {
            setExchangeRateInternal(6.96);
        }
    };

    const defaultReceiptTemplate: ReceiptTemplate = {
        logoText: "GTR POS TERMINAL",
        showLogo: true,
        headerText: "Cochabamba - Bolivia\nTelf: 444-XXXXX\nNIT: 382910023",
        footerText: "¡Gracias por su preferencia!\nConserve su recibo para cualquier reclamo.",
        showDate: true,
        showCashier: true,
        showClientInfo: true,
        showHeaderDivider: true,
        showFooterDivider: true,
        showItemSKU: false,
        showPaymentMethod: true,
        fontFamily: 'Helvetica',
        fontSizeHeader: 14,
        fontSizeBody: 8,
        ticketWidth: 80,
        logoImage: null
    };

    const [receiptTemplate, setReceiptTemplate] = useState<ReceiptTemplate>(() => {
        try {
            const cached = localStorage.getItem('cached_receipt_template');
            return cached ? JSON.parse(cached) : defaultReceiptTemplate;
        } catch {
            return defaultReceiptTemplate;
        }
    });

    const [departments, setDepartments] = useState<Department[]>([]);

    const roundBs = (amount: number): number => {
        if (isNaN(amount) || amount === null || amount === undefined) return 0;
        return Math.round((Number(amount) + Number.EPSILON) * 100) / 100;
    };

    const fetchExchangeRate = async () => {
        try {
            const res = await fetchWithRetry('/api/settings/exchange-rate');
            const data = await res.json();
            const rawRate = data ? data.exchange_rate : null;
            if (rawRate !== undefined && rawRate !== null) {
                const rate = parseFloat(rawRate);
                if (!isNaN(rate) && rate > 0) {
                    setExchangeRate(rate);
                }
            }
            setIsOffline(false);
        } catch (e) {
            console.warn("Failed to fetch exchange rate, using cached value:", e);
            const cached = localStorage.getItem('cached_exchange_rate');
            if (cached) {
                const parsed = parseFloat(cached);
                if (!isNaN(parsed) && parsed > 0) {
                    setExchangeRate(parsed);
                }
            }
        }
    };

    useEffect(() => {
        localStorage.setItem('darkMode', String(darkMode));
        if (darkMode) {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
    }, [darkMode]);

    useEffect(() => {
        localStorage.setItem('theme', theme);
        const classes = document.documentElement.classList;
        const themesToRemove: string[] = [];
        for (let i = 0; i < classes.length; i++) {
            const c = classes.item(i);
            if (c && c.startsWith('theme-')) {
                themesToRemove.push(c);
            }
        }
        themesToRemove.forEach(c => classes.remove(c));
        classes.add(`theme-${theme}`);
        // Ensure gamer-rgb-glow is never attached to the root <html> element
        classes.remove('gamer-rgb-glow');
    }, [theme]);

    useEffect(() => {
        localStorage.setItem('rgb_theme_settings', JSON.stringify(rgbSettings));
        
        let colors: string[] = [];
        switch (rgbSettings.effectType) {
            case 'aiStudio':
                colors = ['#4285F4', '#8B5CF6', '#EC4899', '#06B6D4', '#3B82F6', '#4285F4'];
                break;
            case 'neon':
                colors = ['#4285F4', '#8B5CF6', '#D946EF', '#06B6D4', '#6366F1', '#4285F4'];
                break;
            case 'rainbow':
                colors = ['#3B82F6', '#8B5CF6', '#EC4899', '#F43F5E', '#F59E0B', '#10B981', '#06B6D4', '#3B82F6'];
                break;
            case 'fireIce':
                colors = ['#F43F5E', '#FB923C', '#38BDF8', '#6366F1', '#F43F5E'];
                break;
            case 'aurora':
                colors = ['#06B6D4', '#10B981', '#3B82F6', '#8B5CF6', '#06B6D4'];
                break;
            case 'cyberpunk':
                colors = ['#F43F5E', '#A855F7', '#3B82F6', '#06B6D4', '#EC4899', '#F43F5E'];
                break;
            case 'oceanic':
                colors = ['#2563EB', '#0EA5E9', '#06B6D4', '#14B8A6', '#6366F1', '#2563EB'];
                break;
            case 'sunset':
                colors = ['#F43F5E', '#F97316', '#EC4899', '#8B5CF6', '#F43F5E'];
                break;
            case 'pastel':
                colors = ['#818CF8', '#C084FC', '#F472B6', '#38BDF8', '#34D399', '#818CF8'];
                break;
            case 'custom':
                colors = rgbSettings.customColors && rgbSettings.customColors.length > 0
                    ? [...rgbSettings.customColors, rgbSettings.customColors[0]]
                    : ['#4285F4', '#8B5CF6', '#EC4899', '#06B6D4', '#4285F4'];
                break;
            default:
                colors = ['#4285F4', '#8B5CF6', '#EC4899', '#06B6D4', '#3B82F6', '#4285F4'];
        }

        const angleStr = `${rgbSettings.angle}deg`;
        const gradient = `linear-gradient(${angleStr}, ${colors.join(', ')})`;
        
        let glowRadius = '14px';
        let glowColor = 'rgba(99, 102, 241, 0.28)';
        let glowHoverRadius = '22px';
        let glowHoverColor = 'rgba(139, 92, 246, 0.48)';

        switch (rgbSettings.glowIntensity) {
            case 'none':
                glowRadius = '0px';
                glowColor = 'rgba(0,0,0,0)';
                glowHoverRadius = '0px';
                glowHoverColor = 'rgba(0,0,0,0)';
                break;
            case 'subtle':
                glowRadius = '8px';
                glowColor = 'rgba(99, 102, 241, 0.16)';
                glowHoverRadius = '14px';
                glowHoverColor = 'rgba(139, 92, 246, 0.30)';
                break;
            case 'normal':
                glowRadius = '14px';
                glowColor = 'rgba(99, 102, 241, 0.28)';
                glowHoverRadius = '22px';
                glowHoverColor = 'rgba(139, 92, 246, 0.48)';
                break;
            case 'intense':
                glowRadius = '24px';
                glowColor = 'rgba(139, 92, 246, 0.45)';
                glowHoverRadius = '34px';
                glowHoverColor = 'rgba(6, 182, 212, 0.65)';
                break;
        }

        // Animation timing easing & direction
        let ease = 'ease-in-out';
        let direction = 'infinite';

        if (rgbSettings.animationStyle === 'linear') {
            ease = 'linear';
            direction = 'infinite';
        } else if (rgbSettings.animationStyle === 'smooth') {
            ease = 'cubic-bezier(0.4, 0, 0.2, 1)';
            direction = 'infinite';
        } else if (rgbSettings.animationStyle === 'cyclic') {
            ease = 'cubic-bezier(0.45, 0, 0.55, 1)';
            direction = 'infinite alternate';
        }

        const root = document.documentElement;
        root.style.setProperty('--rgb-gradient', gradient);
        root.style.setProperty('--rgb-speed', `${rgbSettings.speed}s`);
        root.style.setProperty('--rgb-glow-radius', glowRadius);
        root.style.setProperty('--rgb-glow-color', glowColor);
        root.style.setProperty('--rgb-glow-hover-radius', glowHoverRadius);
        root.style.setProperty('--rgb-glow-hover-color', glowHoverColor);
        root.style.setProperty('--rgb-ease', ease);
        root.style.setProperty('--rgb-direction', direction);
    }, [rgbSettings]);

    // Automatically purge stale offline queues and enforce daily deep device wipe on startup
    useEffect(() => {
        const initOnlineSession = async () => {
            try {
                const sessionDate = localStorage.getItem('gtr_session_date');
                const todayBolivia = getBoliviaDateString();
                if (!sessionDate || sessionDate !== todayBolivia) {
                    await performDailyDeepDeviceWipe(false);
                    setUserState(null);
                    return;
                }
                await purgeStaleOfflineQueuesAndCaches();
            } catch (err) {
                console.warn("[Online Init] Session init warning:", err);
            }
        };
        initOnlineSession();
    }, []);

    useEffect(() => {
        if (user && user.username && user.username !== 'none') {
            setIsInitializing(false);

            Promise.allSettled([
                fetchProducts(),
                fetchClients(),
                fetchExchangeRate(),
                fetchReceiptTemplate(),
                fetchDepartments(),
                fetchKioskMode()
            ]).finally(() => {
                setIsInitializing(false);
            });
        } else {
            fetchKioskMode().catch(() => {});
            setIsInitializing(false);
        }
    }, [user?.id, user?.username]);

    const fetchKioskMode = async () => {
        try {
            const res = await fetchWithRetry('/api/settings/kiosk');
            if (res.ok) {
                const data = await res.json();
                const serverKiosk = Boolean(data.kiosk_mode);
                setKioskMode(serverKiosk);
                localStorage.setItem('kioskMode', String(serverKiosk));
            }
        } catch (e) {
            console.warn("Failed to fetch kiosk mode:", e);
        }
    };

    // Enforce server-side Kiosk state periodically and protect unsynced data / active cart on tab close
    useEffect(() => {
        fetchKioskMode().catch(() => {});
        const kioskSyncTimer = setInterval(() => {
            if (navigator.onLine) {
                fetchKioskMode().catch(() => {});
            }
        }, 20000);
        return () => clearInterval(kioskSyncTimer);
    }, []);

    useEffect(() => {
        const hasActiveData = cart.length > 0 || pendingSalesCount > 0 || pendingActionsCount > 0;
        if (!hasActiveData) return;

        const handleBeforeUnload = (e: BeforeUnloadEvent) => {
            if ((window as any).__pwaIsHandlingRefresh) return;
            e.preventDefault();
            e.returnValue = 'Tienes ventas pendientes de sincronizar o un carrito activo. ¿Seguro que deseas salir?';
            return e.returnValue;
        };

        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    }, [cart.length, pendingSalesCount, pendingActionsCount]);

    const fetchReceiptTemplate = async () => {
        try {
            const res = await fetchWithRetry('/api/settings/receipt');
            const data = await res.json();
            setReceiptTemplate(data);
            localStorage.setItem('cached_receipt_template', JSON.stringify(data));
            cacheAppState('cached_receipt_template', data);
        } catch (e) {
            console.warn("Failed to fetch receipt template, using cached value:", e);
            const cachedIdx = await getCachedAppState<ReceiptTemplate>('cached_receipt_template');
            if (cachedIdx) {
                setReceiptTemplate(cachedIdx);
            } else {
                const cached = localStorage.getItem('cached_receipt_template');
                if (cached) {
                    try {
                        setReceiptTemplate(JSON.parse(cached));
                    } catch (parseErr) {
                        console.error("Failed to parse cached receipt template:", parseErr);
                    }
                }
            }
        }
    };

    const fetchInventoryLockStatus = async () => {
        try {
            const token = typeof localStorage !== 'undefined' ? localStorage.getItem('auth_token') : null;
            const headers: Record<string, string> = {};
            if (token) headers['Authorization'] = `Bearer ${token}`;
            const res = await fetch('/api/inventory-counts/lock-status', { headers });
            if (res.ok) {
                const data = await res.json();
                setInventoryLock({
                    isLocked: false,
                    activeCount: data.activeCount || null,
                    pendingApproval: !!data.pendingApproval,
                    diffCount: data.diffCount || 0
                });
            }
        } catch (_) {
            // fail-soft
        }
    };

    const fetchDepartments = async () => {
        try {
            const res = await fetchWithRetry(`/api/departments?_t=${Date.now()}`, { cache: 'no-store' });
            const data = await res.json();
            setDepartments(Array.isArray(data) ? data : []);
        } catch (e) {
            console.warn("Failed to fetch departments from server:", e);
        }
    };

    const updateReceiptTemplate = async (template: ReceiptTemplate) => {
        try {
            setReceiptTemplate(template);
            localStorage.setItem('cached_receipt_template', JSON.stringify(template));
            cacheAppState('cached_receipt_template', template);
            const res = await fetch('/api/settings/receipt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ template })
            });
            if (!res.ok) {
                throw new Error("No se pudo guardar la plantilla.");
            }
        } catch (e: any) {
            console.error("Failed to save receipt template:", e);
            throw e;
        }
    };

    const fetchProducts = async (searchQuery?: string, force?: boolean) => {
        try {
            // Phase 10: Lightweight version probe to prevent redundant full-catalog downloads
            if (!searchQuery && !force && products.length > 0) {
                try {
                    const verRes = await fetch(`/api/catalog/version?_t=${Date.now()}`);
                    if (verRes.ok) {
                        const verData = await verRes.json();
                        const localCat = sessionStorage.getItem('last_catalog_version');
                        const localInv = sessionStorage.getItem('last_inventory_version');
                        if (
                            localCat &&
                            localInv &&
                            localCat === String(verData.catalogVersion) &&
                            localInv === String(verData.inventoryVersion)
                        ) {
                            // Inventory and catalog are up-to-date, avoid redundant network download
                            return;
                        }
                    }
                } catch (_) {}
            }

            setProductsOffset(0);
            const cacheBuster = `_t=${Date.now()}`;
            const queryParam = searchQuery && searchQuery.trim() 
                ? `?search=${encodeURIComponent(searchQuery.trim())}&${cacheBuster}` 
                : `?${cacheBuster}`;
            const url = `/api/products${queryParam}`;
            const res = await fetchWithRetry(url);
            
            // Q01: Atomically capture catalog and inventory versions directly from response headers
            const catHeader = res.headers.get('X-Catalog-Version');
            const invHeader = res.headers.get('X-Inventory-Version');
            if (catHeader) sessionStorage.setItem('last_catalog_version', catHeader);
            if (invHeader) sessionStorage.setItem('last_inventory_version', invHeader);

            const data = await res.json();
            
            // Check if response has pagination wrapper or is a direct array
            let prods: Product[] = [];
            let total = 0;
            if (data && Array.isArray(data.products)) {
                prods = data.products;
                total = typeof data.total === 'number' ? data.total : prods.length;
            } else if (Array.isArray(data)) {
                prods = data;
                total = data.length;
            }
            
            setProducts(prods);
            setTotalProducts(total);
            setHasMoreProducts(false);
            setIsOffline(false);

            // Reconcile active cart and multi-comanda tabs with live server stock & catalog metadata upon reconnect/refresh
            if (!searchQuery && prods.length > 0) {
                const liveMap = new Map<number, Product>();
                for (const p of prods) {
                    if (p && p.id !== undefined) {
                        liveMap.set(Number(p.id), p);
                    }
                }
                setCart(prevCart => {
                    if (!prevCart || prevCart.length === 0) return prevCart;
                    let changed = false;
                    const updatedCart = prevCart.map(item => {
                        if (!item || item.id === undefined) return item;
                        const liveProd = liveMap.get(Number(item.id));
                        if (!liveProd) return item;
                        if (
                            item.stock !== liveProd.stock ||
                            item.price_unit !== liveProd.price_unit ||
                            item.price_bulk !== liveProd.price_bulk ||
                            item.name !== liveProd.name
                        ) {
                            changed = true;
                            return {
                                ...item,
                                stock: liveProd.stock,
                                price_unit: liveProd.price_unit,
                                price_bulk: liveProd.price_bulk,
                                name: liveProd.name,
                                sku: liveProd.sku
                            };
                        }
                        return item;
                    });
                    return changed ? updatedCart : prevCart;
                });
            }

            // Update local versions via fallback endpoint ONLY if response headers were omitted
            if (!catHeader || !invHeader) {
                try {
                    fetch(`/api/catalog/version?_t=${Date.now()}`, { cache: 'no-store' })
                        .then(r => r.json())
                        .then(v => {
                            if (v && v.catalogVersion && v.inventoryVersion) {
                                if (!catHeader) sessionStorage.setItem('last_catalog_version', String(v.catalogVersion));
                                if (!invHeader) sessionStorage.setItem('last_inventory_version', String(v.inventoryVersion));
                            }
                        })
                        .catch(() => {});
                } catch (_) {}
            }
        } catch (e) {
            console.warn("Failed to fetch live products from server (100% Online Mode):", e);
        }
    };

    const loadMoreProducts = async (_searchQuery?: string) => {
        // Full product catalog is always synchronized and retained in memory
        setHasMoreProducts(false);
    };

    // Eagerly preload complete product catalog immediately on mount and purge stale SW caches
    useEffect(() => {
        if ('caches' in window) {
            caches.open('api-cache').then(cache => {
                cache.keys().then(keys => {
                    for (const req of keys) {
                        if (req.url.includes('/api/products') || req.url.includes('/api/stock')) {
                            cache.delete(req);
                        }
                    }
                });
            }).catch(() => {});
        }
        fetchProducts().catch(() => {});
        fetchInventoryLockStatus().catch(() => {});

        const handleInvOp = () => {
            fetchInventoryLockStatus().catch(() => {});
        };
        window.addEventListener('inventory_operation', handleInvOp);

        const lockInterval = setInterval(() => {
            fetchInventoryLockStatus().catch(() => {});
        }, 10000);

        return () => {
            window.removeEventListener('inventory_operation', handleInvOp);
            clearInterval(lockInterval);
        };
    }, []);

    const fetchClients = async () => {
        try {
            const res = await fetchWithRetry(`/api/clients?_t=${Date.now()}`, { cache: 'no-store' });
            const data = await res.json();
            setClients(Array.isArray(data) ? data : []);
            setIsOffline(false);
        } catch (e) {
            console.warn("Failed to fetch live clients from server:", e);
        }
    };

    // Real-time immediate local stock reduction for offline POS autonomy
    const deductLocalProductStock = (items: Array<{ product_id: number; quantity: number }>) => {
        if (!items || items.length === 0) return;
        setProducts(prev => {
            const itemMap = new Map(items.map(i => [Number(i.product_id), Number(i.quantity)]));
            const updated = prev.map(p => {
                if (itemMap.has(p.id)) {
                    const qtyToDeduct = itemMap.get(p.id) || 0;
                    const newStock = Math.max(0, p.stock - qtyToDeduct);
                    return { ...p, stock: newStock };
                }
                return p;
            });
            try {
                safeLocalStorageSetItem('cached_products', JSON.stringify(updated));
                cacheAppState('cached_products', updated);
                setCachedMinimalProducts(updated).catch(() => {});
            } catch (err) {
                console.warn("Error caching updated products:", err);
            }
            return updated;
        });
    };

    // Instant local client registration for offline search and POS matching
    const registerLocalClient = (client: { id: string | number; name: string; phone?: string }) => {
        if (!client || !client.name) return;
        setClients(prev => {
            const nameMatch = client.name.trim().toLowerCase();
            const exists = prev.some(c => c.name.trim().toLowerCase() === nameMatch);
            if (exists) return prev;

            const newClient: Client = {
                id: typeof client.id === 'number' ? client.id : -Date.now(),
                name: client.name.trim(),
                phone: client.phone ? client.phone.trim() : '',
                points: 0
            };
            const updated = [newClient, ...prev];
            try {
                localStorage.setItem('cached_clients', JSON.stringify(updated));
                cacheAppState('cached_clients', updated);
            } catch (err) {
                console.warn("Error caching updated clients:", err);
            }
            return updated;
        });
    };

    // STRICT ITEM CONSOLIDATION & QUANTITY ADDITION RULE (WITH STOCK LEVEL LITERALLY BOUNDED BY AVAILABLE STOCK)
    const addToCart = (product: Product, quantity: number = 1) => {
        const availableStock = (product as any).stock_available !== undefined && (product as any).stock_available !== null
            ? Number((product as any).stock_available)
            : Number(product.stock || 0);
        setCart(prev => {
            const existing = prev.find(item => item.id === product.id);
            if (existing) {
                let newQuantity = existing.cartQuantity + quantity;
                if (newQuantity <= 0) {
                    return prev.filter(item => item.id !== product.id);
                }
                if (newQuantity > availableStock) {
                    newQuantity = availableStock;
                    setTimeout(() => {
                        safeDispatchEvent('stockLimitHit', { 
                            detail: { name: product.name, stock: availableStock } 
                        });
                    }, 0);
                }
                return prev.map(item => 
                    item.id === product.id 
                    ? { ...item, cartQuantity: newQuantity }
                    : item
                );
            }
            if (quantity <= 0) return prev;
            let finalQty = quantity;
            if (finalQty > availableStock) {
                finalQty = availableStock;
                setTimeout(() => {
                    safeDispatchEvent('stockLimitHit', { 
                        detail: { name: product.name, stock: availableStock } 
                    });
                }, 0);
            }
            if (finalQty <= 0) return prev;
            return [...prev, { ...product, cartQuantity: finalQty }];
        });
    };

    const updateCartItemQuantity = (productId: number, qty: number) => {
        setCart(prev => {
            return prev.map(item => {
                if (item.id === productId) {
                    const availableStock = (item as any).stock_available !== undefined && (item as any).stock_available !== null
                        ? Number((item as any).stock_available)
                        : Number(item.stock || 0);
                    let finalQty = isNaN(qty) ? 0 : Math.max(0, qty);
                    if (finalQty > availableStock) {
                        finalQty = availableStock;
                        setTimeout(() => {
                            safeDispatchEvent('stockLimitHit', { 
                                detail: { name: item.name, stock: availableStock } 
                            });
                        }, 0);
                    }
                    return { ...item, cartQuantity: finalQty };
                }
                return item;
            });
        });
    };

    const removeFromCart = (productId: number) => {
        setCart(prev => prev.filter(item => item.id !== productId));
    };

    const clearCart = (isCompletedSale = false) => {
        if (!isCompletedSale && cart.length > 0) {
            const payload = {
                cart: [...cart],
                clientName,
                clientPhone,
                discount,
                discountType,
                paymentMethod,
                timestamp: new Date().toISOString()
            };
            setLastClearedCart([...cart]);
            setLastClearedMeta(payload);
            try {
                localStorage.setItem('gtr_pos_last_cleared_cart', JSON.stringify(payload));
            } catch (e) {
                console.error("Failed saving last cleared cart:", e);
            }
        } else if (isCompletedSale) {
            setLastClearedCart(null);
            setLastClearedMeta(null);
            setCartBackup(null);
            setCartBackupMeta(null);
            try {
                localStorage.removeItem('gtr_pos_last_cleared_cart');
                localStorage.removeItem('gtr_pos_active_cart_backup');
            } catch (e) {}
            // Also synchronize active sale tab so tab switching/re-renders cannot resurrect old cart items
            setTabs(prev => prev.map(t => {
                if (t.id === activeTabId) {
                    return {
                        ...t,
                        cart: [],
                        clientName: "",
                        clientPhone: "",
                        discount: 0,
                        discountType: 'monto',
                        paymentMethod: 'Efectivo'
                    };
                }
                return t;
            }));
        }
        setCart([]);
    };

    const restoreLastClearedCart = (): boolean => {
        if (!lastClearedCart || lastClearedCart.length === 0) return false;
        setCart([...lastClearedCart]);
        if (lastClearedMeta) {
            if (lastClearedMeta.clientName) setClientName(lastClearedMeta.clientName);
            if (lastClearedMeta.clientPhone) setClientPhone(lastClearedMeta.clientPhone);
            if (lastClearedMeta.discount !== undefined) setDiscount(lastClearedMeta.discount);
            if (lastClearedMeta.discountType) setDiscountType(lastClearedMeta.discountType);
            if (lastClearedMeta.paymentMethod) setPaymentMethod(lastClearedMeta.paymentMethod);
        }
        setLastClearedCart(null);
        setLastClearedMeta(null);
        localStorage.removeItem('gtr_pos_last_cleared_cart');
        return true;
    };

    const restoreCartBackup = (): boolean => {
        if (!cartBackup || cartBackup.length === 0) return false;
        setCart([...cartBackup]);
        if (cartBackupMeta) {
            if (cartBackupMeta.clientName) setClientName(cartBackupMeta.clientName);
            if (cartBackupMeta.clientPhone) setClientPhone(cartBackupMeta.clientPhone);
            if (cartBackupMeta.discount !== undefined) setDiscount(cartBackupMeta.discount);
            if (cartBackupMeta.discountType) setDiscountType(cartBackupMeta.discountType);
            if (cartBackupMeta.paymentMethod) setPaymentMethod(cartBackupMeta.paymentMethod);
        }
        setCartBackup(null);
        setCartBackupMeta(null);
        localStorage.removeItem('gtr_pos_active_cart_backup');
        return true;
    };

    const discardCartBackup = () => {
        setLastClearedCart(null);
        setLastClearedMeta(null);
        setCartBackup(null);
        setCartBackupMeta(null);
        localStorage.removeItem('gtr_pos_last_cleared_cart');
        localStorage.removeItem('gtr_pos_active_cart_backup');
    };

    const updateCartItemPrice = (productId: number, priceType: 'unit' | 'bulk' | 'custom', customPrice?: number, customPriceBs?: number) => {
        setCart(prev => prev.map(item => {
            if (item.id === productId) {
                return {
                    ...item,
                    price_type: priceType,
                    custom_price: customPrice !== undefined ? customPrice : item.custom_price,
                    custom_price_bs: customPriceBs !== undefined ? customPriceBs : (priceType !== 'custom' ? undefined : item.custom_price_bs)
                };
            }
            return item;
        }));
    };

    const syncOfflineActions = async (tempIdMapping: { [key: string]: any } = {}) => {
        try {
            const offlineActions = await getOfflineActions();
            if (offlineActions.length === 0) return;

            console.log(`[Offline Sync] Found ${offlineActions.length} general offline actions to synchronize.`);
            let successCount = 0;

            // Sort actions by creation time to ensure they run in correct chronological order
            const sortedActions = [...offlineActions].sort((a, b) => 
                new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
            );

            for (const action of sortedActions) {
                if (!action || !action.id) continue;
                if (inFlightActionIdsRef.current.has(action.id)) continue;
                if (isOperationCompleted(action.id, action.id)) {
                    await deleteOfflineAction(action.id);
                    continue;
                }
                inFlightActionIdsRef.current.add(action.id);

                try {
                    // Replace temp IDs inside payload if needed
                    let payloadStr = JSON.stringify(action.payload);
                    Object.keys(tempIdMapping).forEach(tempId => {
                        payloadStr = payloadStr.replaceAll(tempId, String(tempIdMapping[tempId]));
                    });
                    const processedPayload = JSON.parse(payloadStr);

                    // Ensure action has stable client_operation_id for backend deduplication
                    if (!processedPayload.clientOperationId && !processedPayload.client_operation_id) {
                        processedPayload.client_operation_id = action.id;
                    }
                    const originalActionUserId = processedPayload.user_id || processedPayload.ownerUserId || action.ownerUserId || user?.id;
                    const originalActionUsername =
                        processedPayload.user_name ||
                        processedPayload.username ||
                        action.ownerUsername ||
                        (originalActionUserId && user?.id && String(originalActionUserId) === String(user.id) ? user.username : undefined);
                    if (originalActionUserId) {
                        processedPayload.user_id = originalActionUserId;
                        processedPayload.ownerUserId = originalActionUserId;
                    }
                    if (originalActionUsername && !processedPayload.user_name) {
                        processedPayload.user_name = originalActionUsername;
                    }

                    // Execute fetch call with authorization and original operator context
                    const authToken = localStorage.getItem('auth_token');
                    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
                    if (originalActionUserId) {
                        headers['x-user-id'] = String(originalActionUserId);
                    } else if (user) {
                        headers['x-user-id'] = String(user.id);
                    }
                    if (user?.role) {
                        headers['x-user-role'] = user.role;
                    }
                    if (originalActionUsername) {
                        headers['x-user-username'] = String(originalActionUsername);
                    } else if (user?.username) {
                        headers['x-user-username'] = user.username;
                    }

                    const res = await fetch(action.url, {
                        method: action.method,
                        headers,
                        body: JSON.stringify(processedPayload)
                    });

                    if (res.ok) {
                        const responseData = await res.json().catch(() => ({}));
                        
                        // If this was a client creation action, map the temp ID to the newly created DB ID
                        if (action.type === 'create_client' && action.metadata?.tempId && responseData.id) {
                            tempIdMapping[action.metadata.tempId] = responseData.id;
                            console.log(`[Offline Sync] Mapped temp ID ${action.metadata.tempId} to actual ID ${responseData.id}`);
                        }

                        await deleteOfflineAction(action.id);
                        successCount++;
                    } else {
                        const errText = await res.text();
                        console.error(`[Offline Sync] Server rejected action ${action.id} (Status ${res.status}):`, errText);
                        
                        // CRITICAL: NEVER delete actions on 401 (Unauthorized) or 403 (Forbidden)
                        // If token expired or session is refreshing, preserve them so user work is never lost.
                        if (res.status === 401 || res.status === 403) {
                            console.warn(`[Offline Sync] Preserving action ${action.id} in queue until session is revalidated.`);
                            break; // Stop loop until user re-authenticates
                        } else if (res.status === 409) {
                            // Idempotency conflict: action already accounted for on server
                            console.warn(`[Offline Sync] Action ${action.id} reported 409 Conflict. Removing duplicate from queue.`);
                            await deleteOfflineAction(action.id);
                        } else if (res.status === 400 || res.status === 404 || res.status === 422) {
                            // Retain problematic actions for operator review rather than silently dropping them
                            console.warn(`[Offline Sync] Action ${action.id} failed validation (${res.status}). Preserving for review.`);
                        }
                    }
                } catch (actionErr) {
                    console.error(`[Offline Sync] Network failed during sync of action ${action.id}:`, actionErr);
                    break; // Stop execution on connection loss
                } finally {
                    inFlightActionIdsRef.current.delete(action.id);
                }
            }

            if (successCount > 0) {
                safeDispatchEvent('triggerNotification', {
                    detail: {
                        message: `✓ Sincronización automática: Se procesaron ${successCount} acción(es) offline con éxito.`,
                        type: 'success'
                    }
                });
                await fetchProducts();
                await fetchClients();
                await fetchDepartments();
            }
        } catch (err) {
            console.error('[Offline Sync] Failed to process general offline actions queue:', err);
        }
    };

    const syncOfflineSales = async (tempIdMapping: { [key: string]: any } = {}) => {
        try {
            const offlineSales = await getOfflineSales();
            if (offlineSales.length === 0) return;

            console.log(`[Offline Sync] Found ${offlineSales.length} offline sales to synchronize.`);
            let newlyQueuedCount = 0;
            let reconciledDuplicateCount = 0;

            for (const sale of offlineSales) {
                if (!sale || !sale.id) continue;
                const opId = sale.salePayload?.clientOperationId || sale.salePayload?.client_operation_id || sale.id;

                // Prevent concurrent duplicate submission of the same offline sale
                if (inFlightSaleIdsRef.current.has(sale.id) || inFlightSaleIdsRef.current.has(opId)) {
                    continue;
                }

                // If already completed in local ledger, purge immediately without re-sending
                if (isOperationCompleted(opId, sale.id)) {
                    await deleteOfflineSale(sale.id, opId);
                    continue;
                }

                inFlightSaleIdsRef.current.add(sale.id);
                inFlightSaleIdsRef.current.add(opId);

                try {
                    let clientId = sale.salePayload.client_id;

                    // If clientId is a temp ID, map it to the actual ID
                    if (clientId && typeof clientId === 'string' && tempIdMapping[clientId]) {
                        clientId = tempIdMapping[clientId];
                        sale.salePayload.client_id = clientId;
                    }

                    // 1. If we have a client name but no client_id, let's try to register/find the client first
                    if (sale.clientName && sale.clientName.trim() && !clientId) {
                        try {
                            const authToken = localStorage.getItem('auth_token');
                            const clientHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
                            if (authToken) clientHeaders['Authorization'] = `Bearer ${authToken}`;
                            if (user) {
                                clientHeaders['x-user-id'] = String(user.id);
                                clientHeaders['x-user-role'] = user.role || '';
                                clientHeaders['x-user-username'] = user.username || '';
                            }

                            const clientRes = await fetch('/api/clients', {
                                method: 'POST',
                                headers: clientHeaders,
                                body: JSON.stringify({ name: sale.clientName, phone: sale.clientPhone })
                            });
                            if (clientRes.ok) {
                                const clientData = await clientRes.json();
                                clientId = clientData.id;
                                sale.salePayload.client_id = clientId;
                            }
                        } catch (clientErr) {
                            console.error('[Offline Sync] Failed to register client offline:', clientErr);
                        }
                    }

                    // 2. Submit to Offline Quarantine Queue for Administrator Authorization (preserving the original cashier who created the sale)
                    const originalSaleUserId = sale.salePayload?.user_id || sale.ownerUserId || user?.id || 1;
                    const originalSaleUsername =
                        sale.salePayload?.user_name ||
                        sale.salePayload?.username ||
                        sale.ownerUsername ||
                        (originalSaleUserId && user?.id && String(originalSaleUserId) === String(user.id) ? user.username : undefined) ||
                        'Vendedor';
                    const submitPayload = {
                        ...sale.salePayload,
                        id: sale.id,
                        clientOperationId: opId,
                        client_name: sale.clientName,
                        client_phone: sale.clientPhone,
                        user_id: originalSaleUserId,
                        user_name: originalSaleUsername
                    };

                    const token = localStorage.getItem('auth_token');
                    const saleHeaders: Record<string, string> = {
                        'Content-Type': 'application/json',
                        'x-user-id': String(originalSaleUserId),
                        'x-user-username': String(originalSaleUsername)
                    };
                    if (token) saleHeaders['Authorization'] = `Bearer ${token}`;

                    const saleRes = await fetch('/api/offline-sales/submit', {
                        method: 'POST',
                        headers: saleHeaders,
                        body: JSON.stringify(submitPayload)
                    });

                    if (saleRes.ok) {
                        const resData = await saleRes.json().catch(() => ({}));
                        markOperationCompleted(opId, sale.id);
                        await deleteOfflineSale(sale.id, opId);

                        if (resData.status === 'already_approved' || resData.status === 'already_queued' || resData.isDuplicate) {
                            reconciledDuplicateCount++;
                        } else {
                            newlyQueuedCount++;
                        }
                    } else {
                        const errText = await saleRes.text();
                        console.error(`[Offline Sync] Server rejected offline sale ${sale.id}:`, errText);
                    }
                } catch (saleErr) {
                    console.error(`[Offline Sync] Network failed during sync of sale ${sale.id}:`, saleErr);
                    break; // Stop syncing remaining if we are still offline or connection breaks
                } finally {
                    inFlightSaleIdsRef.current.delete(sale.id);
                    inFlightSaleIdsRef.current.delete(opId);
                }
            }

            if (newlyQueuedCount > 0 || reconciledDuplicateCount > 0) {
                if (newlyQueuedCount > 0) {
                    safeDispatchEvent('triggerNotification', {
                        detail: {
                            message: `✓ Contingencia Offline: ${newlyQueuedCount} venta(s) enviada(s) a la Bandeja de Autorización del Administrador.`,
                            type: 'info'
                        }
                    });
                } else if (reconciledDuplicateCount > 0) {
                    safeDispatchEvent('triggerNotification', {
                        detail: {
                            message: `✓ Sincronización inteligente: ${reconciledDuplicateCount} venta(s) en cola ya estaban registradas en línea y se descartó el duplicado automáticamente.`,
                            type: 'success'
                        }
                    });
                }
                // Refresh local lists with forced fresh fetch
                sessionStorage.removeItem('last_inventory_version');
                await fetchProducts(undefined, true);
                await fetchClients();
            }
        } catch (err) {
            console.error('[Offline Sync] Failed to process offline sales queue:', err);
        }
    };

    const triggerOnlineSync = async (forceFull = false) => {
        if (navigator.onLine === false) return;
        if (syncRunningRef.current) return;
        syncRunningRef.current = true;
        setIsSyncing(true);

        try {
            // 100% Online Architecture: Purge any legacy device offline queues so stale phones never overwrite the main DB
            await purgeStaleOfflineQueuesAndCaches();

            console.log("[PWA Sync] Syncing with Google Cloud Firestore in real-time...");
            const token = localStorage.getItem('auth_token');
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }
            const res = await fetch('/api/sync/trigger', { 
                method: 'POST', 
                headers,
                body: JSON.stringify({ full: forceFull })
            });
            if (res.ok) {
                const data = await res.json();
                console.log("[PWA Sync] Sync completed successfully:", data.status);
                // Concurrently fetch latest data in parallel
                await Promise.allSettled([
                    fetchProducts(undefined, forceFull),
                    fetchClients(),
                    fetchExchangeRate(),
                    fetchDepartments()
                ]);
                setSyncError(null);
            } else {
                const errData = await res.json().catch(() => ({}));
                const errMsg = errData.error || `HTTP ${res.status}`;
                console.warn("[PWA Sync] Sync completed with server-side error:", errMsg);
                setSyncError(errMsg);
            }
        } catch (error: any) {
            console.warn("[PWA Sync] Error triggering backend online synchronization:", error);
            setSyncError(error?.message || String(error));
        } finally {
            setIsSyncing(false);
            syncRunningRef.current = false;
        }
    };

    
    // Automatically sync Web Push subscription for Owner/Admin if permission was already granted
    // and handle navigation when clicking a native push notification
    useEffect(() => {
        if (user && isOwnerOrAdminForPush(user) && navigator.onLine) {
            syncAdminPushSubscriptionIfGranted(user).catch(() => {});
        }

        const handleNavigateFromPush = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail && detail.view) {
                setView(detail.view as ViewType);
            }
        };
        window.addEventListener('gtr-navigate-from-push', handleNavigateFromPush);
        return () => {
            window.removeEventListener('gtr-navigate-from-push', handleNavigateFromPush);
        };
    }, [user?.id, user?.role]);

    // Global WebSocket connection for settings/alerts
    useEffect(() => {
        if (!user || user.username === 'none') return;

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/alerts`;
        
        let socket: any = null;
        let reconnectTimeout: any = null;

        const connect = () => {
            const token = localStorage.getItem('auth_token');
            socket = token ? new WebSocket(wsUrl, ['access_token', token]) : new WebSocket(wsUrl);

            socket.onmessage = (event: any) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'kiosk_mode_changed') {
                        setKioskMode(data.kiosk_mode);
                        localStorage.setItem('kioskMode', String(data.kiosk_mode));
                        safeDispatchEvent('triggerNotification', {
                            detail: {
                                message: data.kiosk_mode
                                    ? "✓ Modo Quiosco ha sido activado por el administrador."
                                    : "✓ Modo Quiosco ha sido desactivado.",
                                type: 'info'
                            }
                        });
                    } else if (data.type === 'exchange_rate_updated' && data.new_rate) {
                        const newRateNum = Number(data.new_rate);
                        if (!isNaN(newRateNum) && newRateNum > 0) {
                            console.log(`[PWA Socket] Live exchange rate update received: $1 = ${newRateNum} Bs.`);
                            setExchangeRate(newRateNum);
                            localStorage.setItem('cached_exchange_rate', String(newRateNum));
                            safeDispatchEvent('exchange_rate_updated', { detail: newRateNum });
                        }
                    } else if (data.type === 'app_update' && data.version) {
                        window.dispatchEvent(new CustomEvent('app-update-pushed', { detail: data }));
                    } else if (data.type === 'catalog_updated' || data.type === 'inventory_reconciled' || data.type === 'low_stock_alert') {
                        sessionStorage.removeItem('last_catalog_version');
                        sessionStorage.removeItem('last_inventory_version');
                        fetchProducts(undefined, true);
                    } else if (data.type === 'sale_push_notification' && isOwnerOrAdminForPush(user)) {
                        safeDispatchEvent('triggerNotification', {
                            detail: {
                                message: `${data.title} — ${data.body}`,
                                type: 'success'
                            }
                        });
                        // Also refresh catalog and cash state immediately when a sale occurs
                        sessionStorage.removeItem('last_inventory_version');
                        fetchProducts(undefined, true);
                        // Also show OS/PWA notification if permission is granted and Service Worker push did not already show this tag
                        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                            setTimeout(async () => {
                                if ((window as any).__lastDisplayedPushTag === data.tag) return;
                                (window as any).__lastDisplayedPushTag = data.tag;
                                try {
                                    const reg = (window as any).__pwaServiceWorkerReg || (await navigator.serviceWorker?.getRegistration());
                                    if (reg && typeof reg.showNotification === 'function') {
                                        await reg.showNotification(data.title, {
                                            body: data.body,
                                            icon: data.icon || '/icon.svg',
                                            badge: data.badge || '/icon.svg',
                                            tag: data.tag,
                                            renotify: true,
                                            data: data.data
                                        } as any);
                                    }
                                } catch {}
                            }, 650);
                        }
                    }
                } catch (err) { }
            };

            socket.onclose = () => {
                reconnectTimeout = setTimeout(connect, 1500);
            };

            socket.onerror = () => {};
        };

        connect();

        const handleFastReconnect = () => {
            if (navigator.onLine && (!socket || socket.readyState > 1)) {
                if (reconnectTimeout) clearTimeout(reconnectTimeout);
                connect();
            }
        };
        window.addEventListener('online', handleFastReconnect);

        return () => {
            window.removeEventListener('online', handleFastReconnect);
            if (socket) socket.close();
            if (reconnectTimeout) clearTimeout(reconnectTimeout);
        };
    }, [user?.id, user?.username, user?.role]);


    // Global Offline Queue and Connectivity Monitoring
    const refreshOfflineStats = async () => {
        try {
            const s = await getOfflineStats();
            setPendingSalesCount(s.salesCount);
            setPendingActionsCount(s.actionsCount);
        } catch (e) {
            // Ignore if db is initializing
        }
    };

    useEffect(() => {
        refreshOfflineStats();
        const handleQueueChange = () => {
            refreshOfflineStats();
        };
        const handleOpenModal = () => {
            setIsOfflineModalOpen(true);
        };
        window.addEventListener('offline_queue_changed', handleQueueChange);
        window.addEventListener('open-offline-manager', handleOpenModal);
        return () => {
            window.removeEventListener('offline_queue_changed', handleQueueChange);
            window.removeEventListener('open-offline-manager', handleOpenModal);
        };
    }, []);

    // Periodic network health check with 45-second Silent Grace Mode, automatic 45s sync, and zero background consumption
    useEffect(() => {
        let timer: any = null;
        let fastGraceTimer: any = null;
        let graceEndTimer: any = null;
        let isCancelled = false;
        const SILENT_GRACE_PERIOD_MS = 45000; // 45 seconds of silent tolerance before showing any offline screen

        const stopFastGracePolling = () => {
            if (fastGraceTimer) {
                clearInterval(fastGraceTimer);
                fastGraceTimer = null;
            }
            if (graceEndTimer) {
                clearTimeout(graceEndTimer);
                graceEndTimer = null;
            }
        };

        const startFastGracePolling = () => {
            if (!fastGraceTimer && !isCancelled) {
                fastGraceTimer = setInterval(() => {
                    if (!isCancelled) checkHealth(true);
                }, 2000);
            }
            if (!graceEndTimer && !isCancelled && offlineGraceStartRef.current !== null) {
                const remainingMs = Math.max(500, SILENT_GRACE_PERIOD_MS - (Date.now() - offlineGraceStartRef.current));
                graceEndTimer = setTimeout(() => {
                    graceEndTimer = null;
                    if (!isCancelled) {
                        // At the exact end of the 45 seconds, automatically attempt live synchronization
                        checkHealth(true);
                    }
                }, remainingMs);
            }
        };

        const handleConnectionFailure = () => {
            if (isCancelled) return;
            // When screen is off or tab is in background, ignore aborted fetches completely (zero consumption)
            const isHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
            if (isHidden) {
                return;
            }

            if (offlineGraceStartRef.current === null) {
                offlineGraceStartRef.current = Date.now();
            }

            const elapsedMs = Date.now() - offlineGraceStartRef.current;
            if (elapsedMs >= SILENT_GRACE_PERIOD_MS) {
                setNetworkLatency(null);
                setNetworkQuality('offline');
                setIsOffline(true);
            } else {
                // Silent Grace Period active (< 45s): keep isOffline = false, show zero warnings, and poll every 2s
                startFastGracePolling();
            }
        };

        const checkHealth = async (isRecoveryAttempt = false) => {
            // Zero background consumption when screen is off or browser is minimized
            if (!isRecoveryAttempt && typeof document !== 'undefined' && document.visibilityState === 'hidden') {
                return;
            }

            if (typeof navigator !== 'undefined' && !navigator.onLine) {
                handleConnectionFailure();
                return;
            }

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3500);
            const startTime = performance.now();

            try {
                const res = await fetch(`/api/health?_t=${Date.now()}`, {
                    method: 'GET',
                    signal: controller.signal,
                    cache: 'no-store'
                });
                clearTimeout(timeoutId);
                const latency = Math.round(performance.now() - startTime);

                if (!isCancelled) {
                    if (res.ok) {
                        const wasRecoveringFromGrace = offlineGraceStartRef.current !== null || isOffline;
                        offlineGraceStartRef.current = null;
                        stopFastGracePolling();
                        setNetworkLatency(latency);
                        const quality = latency > 600 ? 'unstable' : 'online';
                        setNetworkQuality(quality);
                        setIsOffline(false);
                        if (wasRecoveringFromGrace) {
                            // Notify any active checkout waiting on the 45s grace window and refresh live catalog
                            window.dispatchEvent(new CustomEvent('gtr-grace-sync-now'));
                            fetchProducts().catch(() => {});
                            fetchExchangeRate().catch(() => {});
                        }
                    } else {
                        handleConnectionFailure();
                    }
                }
            } catch (err: any) {
                clearTimeout(timeoutId);
                handleConnectionFailure();
            }
        };

        const handleWakeUpOrFocus = () => {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            // Reset grace timer when device screen wakes up so Wi-Fi/4G has a fresh 45s silent window to reconnect
            if (!isOffline) {
                offlineGraceStartRef.current = null;
            }
            checkHealth(true);
        };

        checkHealth(true);
        // 30s interval when online to minimize server/network usage; 2s when recovering
        const intervalMs = isOffline ? 2000 : 30000;
        timer = setInterval(() => checkHealth(false), intervalMs);

        window.addEventListener('focus', handleWakeUpOrFocus);
        window.addEventListener('pageshow', handleWakeUpOrFocus);
        window.addEventListener('online', handleWakeUpOrFocus);
        document.addEventListener('visibilitychange', handleWakeUpOrFocus);

        return () => {
            isCancelled = true;
            if (timer) clearInterval(timer);
            stopFastGracePolling();
            window.removeEventListener('focus', handleWakeUpOrFocus);
            window.removeEventListener('pageshow', handleWakeUpOrFocus);
            window.removeEventListener('online', handleWakeUpOrFocus);
            document.removeEventListener('visibilitychange', handleWakeUpOrFocus);
        };
    }, [isOffline]);

    // Auto trigger sync when the system transitions to online
    useEffect(() => {
        if (!isOffline && navigator.onLine) {
            triggerOnlineSync();
        }
    }, [isOffline]);

    const showNotification = (message: string, type: 'success' | 'error' | 'warn' | 'info' = 'success') => {
        safeDispatchEvent('triggerNotification', {
            detail: { message, type }
        });
    };

    const isKioskLocked = !isSupervisorUnlocked && (
        kioskMode || (
            Boolean(user) &&
            user?.role === 'vendedor' &&
            !user?.permissions?.view_inventory &&
            !user?.permissions?.access_admin_panel &&
            user?.role !== 'admin' &&
            user?.role !== 'propietario'
        )
    );

    return (
        <AppContext.Provider value={{
            isInitializing,
            user,
            setUser,
            darkMode,
            setDarkMode,
            kioskMode,
            setKioskMode: async (k) => { 
                setKioskMode(k); 
                localStorage.setItem('kioskMode', String(k)); 
                if (k) {
                    setIsSupervisorUnlocked(false);
                    setSupervisorInfo(null);
                }
                try {
                    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('auth_token') : null;
                    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                    if (token) headers['Authorization'] = `Bearer ${token}`;
                    await fetch('/api/settings/kiosk', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ kiosk_mode: k })
                    });
                } catch (e) {
                    console.error("Error saving kiosk mode to server", e);
                }
            },
            isKioskLocked,
            requestSupervisorAuth,
            isSupervisorUnlocked,
            setIsSupervisorUnlocked,
            supervisorInfo,
            setSupervisorInfo,
            relockKiosk,
            isFullscreen,
            toggleFullscreen,
            cart,
            addToCart,
            updateCartItemQuantity,
            removeFromCart,
            clearCart,
            lastClearedCart,
            lastClearedMeta,
            cartBackup,
            cartBackupMeta,
            restoreLastClearedCart,
            restoreCartBackup,
            discardCartBackup,
            updateCartItemPrice,
            products,
            clients,
            fetchProducts,
            fetchClients,
            hasMoreProducts,
            totalProducts,
            loadMoreProducts,
            deductLocalProductStock,
            registerLocalClient,
            view,
            setView,
            exchangeRate,
            setExchangeRate,
            fetchExchangeRate,
            roundBs,
            isOffline,
            setIsOffline,
            networkLatency,
            networkQuality,
            pendingSalesCount,
            pendingActionsCount,
            isOfflineModalOpen,
            setIsOfflineModalOpen,
            receiptTemplate,
            updateReceiptTemplate,
            fetchReceiptTemplate,
            departments,
            fetchDepartments,
            tabs,
            setTabs,
            activeTabId,
            setActiveTabId,
            clientName,
            setClientName,
            clientPhone,
            setClientPhone,
            discount,
            setDiscount,
            discountType,
            setDiscountType,
            paymentMethod,
            setPaymentMethod,
            theme,
            setTheme,
            rgbSettings,
            setRgbSettings,
            isSyncing,
            triggerOnlineSync,
            syncError,
            setSyncError,
            isAutonomousTesting,
            setIsAutonomousTesting,
            autonomousStep,
            setAutonomousStep,
            autonomousLogs,
            setAutonomousLogs,
            apiPingResults,
            setApiPingResults,
            pwaPrompt,
            setPwaPrompt,
            installPWA,
            isPwaInstalled,
            setIsPwaInstalled,
            isPwaInstallModalOpen,
            setIsPwaInstallModalOpen,
            hasPwaUpdate,
            isUpdatingPwa,
            pwaUpdateStepMessage,
            pwaVersionInfo,
            checkForPwaUpdates,
            applyPwaUpdate,
            handlePwaPrimaryAction,
            showNotification,
            inventoryLock,
            fetchInventoryLockStatus
        }}>
            {children}
        </AppContext.Provider>
    );
};

export const useAppContext = () => {
    const ctx = useContext(AppContext);
    if (!ctx) throw new Error("AppContext must be used within an AppProvider.");
    return ctx;
};

export const useApp = useAppContext;
