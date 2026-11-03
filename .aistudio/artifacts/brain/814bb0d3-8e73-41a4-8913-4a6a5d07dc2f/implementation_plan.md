# Plan de Reconexión Instantánea y Eliminación de Demoras al Entrar o Despertar Dispositivo

## 1. Causa Raíz del Problema Observado en el Video
1. **El botón `"Reintentar Conexión con el Servidor"` (`src/App.tsx`) no desbloqueaba la pantalla al recibir `200 OK` de `/api/health`:**
   - Aunque `/api/health` responde en milisegundos, `handleRetryOnlineConnection` no ejecutaba `setIsOffline(false)` inmediatamente, sino que dejaba el cartel bloqueado en `"VERIFICANDO SERVIDOR..."` esperando en serie a `checkAppVersion()`, `fetchProducts()`, `fetchClients()` y `fetchExchangeRate()`.
   - Además, cuando el usuario aún está en la pantalla de Login, `fetchClients()` no podía actualizar el estado porque requiere sesión activa, prolongando innecesariamente la espera.
2. **Falsos positivos de desconexión cuando la tablet entra en reposo (`src/context/AppContext.tsx`):**
   - En Android/iOS, cuando la pantalla se apaga o Chrome pasa a segundo plano (`document.visibilityState === 'hidden'`), el sistema operativo cancela las peticiones `fetch` en curso.
   - `checkHealth` interpretaba ese corte de segundo plano como caída del servidor al primer intento fallido y activaba `setIsOffline(true)`.
3. **Ausencia de reconexión automática inmediata al despertar la pantalla:**
   - Al volver a encender la pantalla o enfocar la pestaña (`visibilitychange` / `focus`), no se disparaba un ping inmediato a `/api/health`, y el intervalo de reintento mientras estaba bloqueado era de 8 segundos.

---

## 2. Solución Quirúrgica (Sin Alterar Ninguna Funcionalidad Existente)

### Mejora 1: Liberación Instantánea (`< 300ms`) en `handleRetryOnlineConnection` (`src/App.tsx` y `src/context/AppContext.tsx`)
- Exponer `setIsOffline` y `checkServerHealthNow` desde `AppContext`.
- En `handleRetryOnlineConnection` (`src/App.tsx`):
  - Consultar `/api/health?_t=...` con un `AbortController` de `3500ms` (para no quedar colgado en un socket TCP viejo de móvil y reintentar rápido si es necesario).
  - **En cuanto `/api/health` responda `res.ok` (`200 OK`), ejecutar inmediatamente `setIsOffline(false)` y `setRetryingConnection(false)`** para que el cartel desaparezca al instante (`< 300ms`).
  - Ejecutar la actualización de catálogo, tipo de cambio y versión (`checkAppVersion()`, `fetchProducts()`, `fetchExchangeRate()`, y `fetchClients()` solo si hay usuario autenticado) **en segundo plano sin bloquear la pantalla**.

### Mejora 2: Protección contra Falsos Bloqueos en Reposo y Reconexión Automática al Despertar (`src/context/AppContext.tsx`)
- **Ignorar cancelaciones cuando la pantalla está apagada (`document.visibilityState === 'hidden'`):** Si un ping falla mientras la pestaña está oculta o la tablet está en reposo, no marcar `isOffline = true` a menos que `navigator.onLine === false`.
- **Tolerancia anti-microcortes (2 fallos consecutivos):** Cuando la app está activa y `navigator.onLine === true`, requerir 2 fallos rápidos consecutivos antes de mostrar el modal de desconexión, evitando bloqueos por micro-transiciones de red Wi-Fi o arranque en frío.
- **Reconexión automática al despertar (`visibilitychange`, `focus`, `pageshow`, `online`) y sondeo rápido (`2.5s`) cuando está desconectado:**
  - Al encender la pantalla o volver a Chrome, disparar `checkHealth()` de forma inmediata.
  - Si el cartel `"Sin Conexión con el Servidor Principal"` está activo, verificar cada **2.5 segundos** (en vez de 8 segundos) para que se quite solo automáticamente apenas responda el servidor, incluso sin tocar el botón.

### Mejora 3: Lectura Rápida de Catálogo en Arranque en Frío (`server.ts`)
- En el middleware de `/api/*` (`server.ts`), reducir el tiempo máximo de espera de hidratación en peticiones `GET` de lectura (`GET /api/products`, `GET /api/clients`) a `1500ms` mientras la hidratación de Cloud Firestore continúa en segundo plano, garantizando que las peticiones de escritura (`POST`, `PUT`, `DELETE`) sigan esperando la hidratación completa (`6000ms` + `syncSpecificProductsFromCloud`).

---

## 3. Garantía de Cero Impacto en Otras Funciones
- **Se preserva al 100% el modo 100% Online**, el bloqueo real cuando no hay internet (`!navigator.onLine` o servidor inalcanzable), la protección del carrito en curso y el blindaje de inventario en Cloud Firestore.
