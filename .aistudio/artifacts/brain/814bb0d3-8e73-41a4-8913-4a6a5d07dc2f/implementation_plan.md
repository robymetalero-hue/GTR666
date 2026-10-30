# Actualización Instantánea Estilo AI Studio + Blindaje Definitivo Anti-Duplicados de Ventas y Cola Offline

Solución integral de ingeniería para resolver de raíz dos problemas críticos de operación en producción:
1. **Actualizaciones que se aplican sí o sí sin problemas de caché y sin interrumpir ventas**, mediante una barra superior compacta estilo Google AI Studio con guardado y restauración automática (*Hot-Swap*) del carrito activo.
2. **Eliminación definitiva de la doble sincronización de ventas Offline y del doble registro de ventas** causados por parpadeos de red, reintentos o residuos de caché entre `IndexedDB` y `localStorage`.

---

## Decisiones Confirmadas por el Usuario

> [!IMPORTANT]
> Este plan implementa exactamente las reglas de negocio que seleccionaste:

1. **Actualización con Venta en Curso**: **Actualizar de inmediato guardando y restaurando el carrito automáticamente** (sin perder ni un artículo, pestaña ni cliente seleccionado).
2. **Diseño Visual de Aviso de Nueva Versión**: **Barra superior compacta estilo AI Studio que no bloquea la caja**, eliminando el modal de pantalla completa que congelaba la terminal.
3. **Datos Blindados al Limpiar Caché**:
   - **Carrito activo, pestañas de venta en espera y cliente seleccionado**.
   - **Sesión iniciada del usuario, modo Kiosco y suscripción de notificaciones Push**.
   - **Ventas y acciones pendientes en cola Offline** (únicamente las genuinamente pendientes, nunca las ya procesadas).
4. **Manejo de Fallos/Parpadeos de Red al Cobrar**: **Candado de ID único (`clientOperationId`) y huella en servidor**: registrar la venta **1 sola vez** y descartar duplicados automáticamente.
5. **Reconciliación de Cola Offline vs. Ventas Online**: **Si una venta en cola Offline ya había entrado al servidor en línea, descartar el duplicado automáticamente y mantener solo la venta original ya registrada**.

---

## 1. Diagnóstico de Causa Raíz y Solución Definitiva Anti-Duplicados

### ¿Por qué ocurrían las ventas dobles y la doble sincronización Offline?

1. **Causa 1 — Parpadeo de red al cobrar (`POS.tsx`)**:
   - Cuando el cajero presionaba cobrar con internet lento o inestable, la petición `POST /api/sales` llegaba al servidor y registraba la venta, pero si la respuesta tardaba o se cortaba la conexión antes de recibir el `200 OK`, el navegador entraba al bloque `catch` y ejecutaba `saveOffline()`, guardando la misma venta en la cola Offline.
   - **Solución**: Cada intento de cobro utiliza un `clientOperationId` único vinculado al carrito activo. Si la venta ya entró en `sales` y luego el cliente intenta enviarla por `/api/offline-sales/submit`, el servidor detecta que ya existe en `sales` (por `client_operation_id` o por huella comercial), responde `already_approved` y el navegador la borra silenciosamente de la cola Offline sin duplicarla.

2. **Causa 2 — Resurrección de ventas borradas entre `IndexedDB` y `localStorage` (`offlineStorage.ts` y `appRefresh.ts`)**:
   - Cuando `deleteOfflineSale(id)` borraba una venta ya sincronizada de `IndexedDB`, no limpiaba la clave de respaldo `gtr_offline_sales_queue` en `localStorage`. Al actualizar la versión o reiniciar la app, si `localStorage` tenía una copia vieja, la venta "revivía" y volvía a enviarse.
   - **Solución**: `deleteOfflineSale` y `deleteOfflineAction` purgarán el registro **simultáneamente** en `IndexedDB`, en `localStorage` (`gtr_offline_sales_queue`) y en memoria, y registrarán el `clientOperationId` en una lista local de operaciones consumadas (`gtr_completed_operation_ids`) que bloquea cualquier intento de volver a encolar o re-enviar esa operación.

3. **Causa 3 — Falta de candado cruzado en el servidor al aprobar o reintentar (`server.ts`)**:
   - El endpoint `POST /api/offline-sales/:id/approve` insertaba la venta en `sales` sin verificar dentro de la transacción SQLite si ese `client_operation_id` ya había sido insertado previamente en `sales`. Además, si un cajero enviaba dos veces la misma venta con distinto ID por un recargado de caché, no había validación de huella comercial.
   - **Solución**:
     - En `POST /api/sales`: Candado transaccional por `client_operation_id` **más** detector de **Huella Comercial Reciente** (mismo vendedor, mismo cliente, mismo total, mismo método de pago y mismos productos/cantidades dentro de una ventana de seguridad de 90 segundos). Si coincide, devuelve la venta ya existente (`isDuplicate: true`) sin descontar stock ni sumar caja por segunda vez.
     - En `POST /api/offline-sales/submit`: Verifica tanto por `client_operation_id` como por Huella Comercial contra la tabla `sales`. Si la venta ya fue registrada en línea, la descarta automáticamente devolviendo `status: 'already_approved'` para que el navegador limpie su cola local al instante.
     - En `POST /api/offline-sales/:id/approve`: Dentro de `db.transaction`, verifica atómicamente que la venta no exista ya en `sales` y que `status === 'pending'`. Si ya existía en `sales`, marca el registro offline como resuelto sin crear otra venta.

4. **Causa 4 — Sincronización concurrente (`AppContext.tsx`)**:
   - El monitor de salud cada 15s y el evento `online` podían invocar `syncOfflineSales` al mismo tiempo.
   - **Solución**: Se añade un registro en memoria de ventas en tránsito (`inFlightSaleIdsRef`) que garantiza que cada ID de venta offline solo pueda enviarse una vez, incluso si hay múltiples eventos de reconexión o clics manuales.

---

## 2. Arquitectura de Actualización Instantánea Estilo AI Studio (Cero Problemas de Caché)

1. **Detección Infalible (Versión Semántica + `buildTime`)**:
   - El cliente compara tanto el número de versión (`vX.Y.Z`) como la marca de tiempo de compilación (`buildTime`) devueltos por `/api/app-version` (sin caché) y por WebSocket (`/alerts`). Así, cualquier cambio o nueva versión se detecta al 100%.
2. **Barra Superior Compacta No Bloqueante (Estilo AI Studio)**:
   - Se elimina el modal de pantalla completa (`showUpdateWarning`) que bloqueaba la caja.
   - En su lugar, se muestra una barra superior compacta con cuenta regresiva automática de 3 segundos y botón **"Actualizar ahora"**.
3. **Resguardo "Hot-Swap" y Purga Quirúrgica de Caché**:
   - Antes de recargar, guarda una instantánea exacta del carrito (`cart`), pestañas (`tabs`), cliente (`clientName`, `clientPhone`), descuentos, método de pago y vista actual en `localStorage` e `IndexedDB`.
   - Limpia todos los cachés de código (`window.caches`), envía `CLEAR_CACHES` y `SKIP_WAITING` al Service Worker, fuerza la recarga de red del documento raíz con `fetch('/', { cache: 'reload' })` y recarga la página restaurando el carrito intacto con un aviso de confirmación.

---

## 3. Diagrama de Flujo Completo (Ventas + Sincronización + Actualización)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        COBRO DE VENTA EN POS.TSX                             │
│  • Genera clientOperationId único vinculado al carrito activo                │
│  • Envía POST /api/sales con clientOperationId                               │
└───────────────────┬──────────────────────────────────────┬───────────────────┘
                    │ Éxito en línea                       │ Corte/Timeout de red
                    ▼                                      ▼
┌───────────────────────────────────────┐  ┌───────────────────────────────────┐
│ SERVIDOR: POST /api/sales             │  │ COLA LOCAL: saveOfflineSale()     │
│ • Verifica clientOperationId + Huella │  │ • Guarda con el MISMO             │
│   Comercial (90s) en transacción      │  │   clientOperationId               │
│ • Registra 1 sola vez                 │  │ • Blinda contra doble encolado    │
└───────────────────────────────────────┘  └─────────────────┬─────────────────┘
                                                             │ Al volver internet
                                                             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                RECONCILIACIÓN AUTOMÁTICA: syncOfflineSales()                 │
│  • Candado inFlightSaleIdsRef evita envíos paralelos                         │
│  • Servidor (/api/offline-sales/submit) verifica si ya entró en `sales`      │
│  • Si ya existía en línea -> Descarta duplicado automáticamente y limpia     │
│    IndexedDB + localStorage + memoria para que jamás reviva                  │
└──────────────────────────────────────────────────────────────────────────────┘
```
