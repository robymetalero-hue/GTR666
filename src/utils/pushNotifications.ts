import { isMainAdmin } from './permissions';

export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function isOwnerOrAdminForPush(user: any): boolean {
  if (!user) return false;
  const role = String(user.role || '').toLowerCase().trim();
  return ['propietario', 'admin', 'administrador'].includes(role) || isMainAdmin(user);
}

export interface PushStatusSummary {
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  isSubscribed: boolean;
  subscribed: boolean;
  eligibleRole: boolean;
  adminSubscriptionsCount: number;
  serverCount: number;
  endpoint?: string | null;
}

export async function getSalesPushStatus(user?: any): Promise<PushStatusSummary> {
  const eligibleRole = user ? isOwnerOrAdminForPush(user) : true;
  const supported =
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;

  if (!supported) {
    return {
      supported: false,
      permission: 'unsupported',
      isSubscribed: false,
      subscribed: false,
      eligibleRole,
      adminSubscriptionsCount: 0,
      serverCount: 0,
      endpoint: null
    };
  }

  let isSubscribed = false;
  let endpoint: string | null = null;
  let adminSubscriptionsCount = 0;

  try {
    const reg = (window as any).__pwaServiceWorkerReg || (await navigator.serviceWorker.getRegistration('/sw.js')) || (await navigator.serviceWorker.ready);
    if (reg && reg.pushManager) {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        isSubscribed = true;
        endpoint = sub.endpoint;
      }
    }
  } catch (e) {
    console.warn('[Push] Error checking local pushManager subscription:', e);
  }

  try {
    const res = await fetch('/api/push/status');
    if (res.ok) {
      const data = await res.json();
      adminSubscriptionsCount = Number(data.adminSubscriptionsCount ?? data.serverCount ?? 0);
    }
  } catch {}

  return {
    supported: true,
    permission: Notification.permission,
    isSubscribed,
    subscribed: isSubscribed,
    eligibleRole,
    adminSubscriptionsCount,
    serverCount: adminSubscriptionsCount,
    endpoint
  };
}

export async function subscribeToSalesPush(_user?: any): Promise<{
  success: boolean;
  ok: boolean;
  message: string;
  adminSubscriptionsCount?: number;
  serverCount?: number;
}> {
  if (
    typeof window === 'undefined' ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !('Notification' in window)
  ) {
    return {
      success: false,
      ok: false,
      message: 'Este navegador o dispositivo no soporta notificaciones Web Push.'
    };
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return {
      success: false,
      ok: false,
      message: 'Permiso de notificaciones denegado. Habilita las notificaciones en la configuración del navegador o PWA.'
    };
  }

  // Ensure /sw.js is registered and ready
  let reg = (window as any).__pwaServiceWorkerReg || (await navigator.serviceWorker.getRegistration('/sw.js'));
  if (!reg) {
    reg = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    (window as any).__pwaServiceWorkerReg = reg;
  }
  await navigator.serviceWorker.ready;

  // Fetch server VAPID public key
  const keyRes = await fetch('/api/push/vapid-public-key');
  if (!keyRes.ok) {
    throw new Error('No se pudo obtener la llave pública VAPID del servidor.');
  }
  const { publicKey } = await keyRes.json();
  if (!publicKey) {
    throw new Error('Llave VAPID no disponible en el servidor.');
  }

  const convertedVapidKey = urlBase64ToUint8Array(publicKey);

  let subscription = await reg.pushManager.getSubscription();
  if (!subscription) {
    subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: convertedVapidKey
    });
  }

  const subRes = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: subscription.toJSON() })
  });

  const subData = await subRes.json().catch(() => ({}));
  if (!subRes.ok) {
    throw new Error(subData.error || 'Error al registrar la suscripción Push en el servidor.');
  }

  try {
    localStorage.setItem('pwa_push_subscribed', 'true');
  } catch {}

  const count = Number(subData.adminSubscriptionsCount ?? subData.serverCount ?? 1);
  return {
    success: true,
    ok: true,
    message: subData.message || 'Notificaciones Push de ventas activadas en este dispositivo.',
    adminSubscriptionsCount: count,
    serverCount: count
  };
}

export async function unsubscribeFromSalesPush(): Promise<{
  success: boolean;
  ok: boolean;
  message: string;
  adminSubscriptionsCount?: number;
  serverCount?: number;
}> {
  let endpoint: string | null = null;
  try {
    if ('serviceWorker' in navigator) {
      const reg = (window as any).__pwaServiceWorkerReg || (await navigator.serviceWorker.getRegistration('/sw.js'));
      if (reg && reg.pushManager) {
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          endpoint = sub.endpoint;
          await sub.unsubscribe();
        }
      }
    }
  } catch (e) {
    console.warn('[Push] Error unsubscribing local pushManager:', e);
  }

  const res = await fetch('/api/push/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      success: false,
      ok: false,
      message: data.error || 'No se pudo desactivar la suscripción Push en el servidor.'
    };
  }

  try {
    localStorage.setItem('pwa_push_subscribed', 'false');
  } catch {}

  const count = Number(data.adminSubscriptionsCount ?? data.serverCount ?? 0);
  return {
    success: true,
    ok: true,
    message: data.message || 'Notificaciones Push desactivadas en este dispositivo.',
    adminSubscriptionsCount: count,
    serverCount: count
  };
}

export async function syncAdminPushSubscriptionIfGranted(user: any): Promise<void> {
  if (!isOwnerOrAdminForPush(user)) return;
  if (
    typeof window === 'undefined' ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !('Notification' in window)
  ) {
    return;
  }

  // Only auto-sync if the admin has not explicitly disabled push on this device
  const explicitPref = localStorage.getItem('pwa_push_subscribed');
  if (explicitPref === 'false') return;

  if (Notification.permission === 'granted') {
    try {
      await subscribeToSalesPush(user);
    } catch (e) {
      console.warn('[Push] Background subscription sync skipped:', e);
    }
  }
}

export async function triggerTestSalesPush(): Promise<{
  success: boolean;
  ok: boolean;
  message: string;
  sentCount?: number;
  totalTargets?: number;
}> {
  const res = await fetch('/api/push/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'No se pudo enviar la notificación Push de prueba.');
  }
  return {
    success: true,
    ok: true,
    message: data.message || 'Notificación de prueba enviada.',
    sentCount: data.sentCount,
    totalTargets: data.totalTargets
  };
}
