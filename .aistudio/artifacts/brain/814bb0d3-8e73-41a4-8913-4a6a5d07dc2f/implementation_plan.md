# Plan de Corrección Definitiva: Persistencia de Ventas/Inventario y Reseteo de Caja Acumulada

## 1. Diagnóstico de Causas Raíz Identificadas

1. **Desvío global a `sandbox` en `src/main.tsx` (Causa de registros invisibles y fallos en vista previa)**:
   - Aunque `AppContext.tsx` y `server.ts` se configuraron en modo `production`, el interceptor global `patchedFetch` en `src/main.tsx` (líneas 97–105) forzaba `headersObj['x-app-environment'] = 'sandbox'` siempre que `window.location.hostname` contenía `ais-dev` o `localhost`.
   - Esto desviaba las peticiones del navegador hacia `gtr_pos_sandbox.db` y las colecciones `sandbox_*` en lugar de la base productiva `gtr_pos.db` y las colecciones reales de Firestore.

2. **Fallo al resetear la Caja Acumulada y resurrección de saldos (`CajasView.tsx`, `server.ts`, `firebaseSync.ts`)**:
   - **Bloqueo en interfaz (`CajasView.tsx`)**: El modal de arqueo abría por defecto en "Modo Ciego" (`isBlindCashSettlement = true`) con el monto vacío y ocultando los botones de autocompletar, impidiendo resetear la caja directamente a cero sin digitar manualmente el monto. Además, `getHeaders()` en `CajasView.tsx` no incluía explícitamente el token `Authorization`.
   - **Condición de carrera en sincronización (`firebaseSync.ts` y `selfHealCashAccounts`)**: Al liquidar una caja (`UPDATE cash_movements SET status = 'liquidado'`), `pullFirestoreToLocal()` carecía de un escudo de estado para `cash_movements`. Si ocurría una lectura de Firestore antes de completarse la subida del lote de movimientos liquidados, `pullFirestoreToLocal()` sobrescribía los movimientos de vuelta a `'pendiente'` y `selfHealCashAccounts()` volvía a sumar esos tickets y revivía el saldo acumulado de la caja.

3. **Cambios de inventario y registros locales no reflejados en Firestore (`Inventory.tsx`, `server.ts`, `firebaseSync.ts`)**:
   - En `server.ts` (`PUT /api/products/:id`, línea 3686), `const safeStock = Number(oldProd.stock || 0)` ignoraba `req.body.stock` incluso cuando un administrador enviaba un ajuste explícito de stock, y en `Inventory.tsx` el campo de stock estaba bloqueado al editar un producto.
   - En `firebaseSync.ts` (`pullFirestoreToLocal`), cuando un producto local tenía fecha `updated_at` más reciente que Firestore (`localUpdated > remoteUpdated`), solo se preservaba `stock`, sobrescribiendo cambios locales de precios, costos, nombre o categoría con datos antiguos de Firestore.
   - Al iniciar el servidor (`server.ts`), solo se ejecutaba `pullFirestoreToLocal()` sin invocar posteriormente `pushAllLocalToFirestore()`, dejando sin subir los registros creados localmente mientras la conexión estuvo interrumpida.

---

## 2. Cambios Propuestos

### A. Unificación del Entorno de Producción en el Interceptor HTTP (`src/main.tsx`)
- Eliminar la detección por nombre de host (`ais-dev` / `localhost`) en `patchedFetch` dentro de `src/main.tsx`.
- Enviar siempre `headersObj['x-app-environment'] = 'production'` por defecto, cambiando a `'sandbox'` únicamente si `localStorage.getItem('gtr_sandbox_mode') === 'true'`.

### B. Reseteo Directo a Cero de Caja Acumulada y Blindaje Anti-Resurrección (`src/views/CajasView.tsx`, `server.ts`, `firebaseSync.ts`)
- **Reseteo directo autocompletando el saldo actual (`src/views/CajasView.tsx`)**:
  - Cambiar `isBlindCashSettlement` a `false` por defecto y autocompletar automáticamente `deliveredAmount` con el saldo acumulado actual (`selectedAccount.current_balance.toFixed(2)`) al abrir el modal de liquidación.
  - Añadir un botón de acción directa **"Resetear a Cero"** en la tarjeta de cada caja acumulada y en el modal de detalle para que el administrador/propietario liquide y ponga en `0.00 Bs` la caja de inmediato con un solo clic, archivando los movimientos pendientes en el historial de liquidaciones.
  - Incluir `Authorization: Bearer ${token}` y `x-app-environment` en `getHeaders()` de `CajasView.tsx`.
- **Blindaje de movimientos liquidados (`firebaseSync.ts` y `server.ts`)**:
  - En `POST /api/cash-accounts/:sellerId/settle` (`server.ts`): registrar `last_settlement_at` y `updated_at` con timestamp ISO (`getBoliviaISOString()`), permitir enviar `delivered_amount` opcional (tomando por defecto `sellerAcc.current_balance` para reseteo exacto a cero), y sincronizar inmediatamente a Firestore `cash_accounts`, `cash_movements` y `cash_settlements`.
  - En `pullFirestoreToLocal` (`firebaseSync.ts`): agregar un escudo de estado para `cash_movements` de modo que si un movimiento local ya tiene `status === 'liquidado'` (o su `sale_id` ya figura en una liquidación de `cash_settlements`), jamás sea revertido a `'pendiente'` por un documento remoto desactualizado.
  - En `selfHealCashAccounts` (`server.ts`): impedir que se recreen como `'pendiente'` movimientos de ventas ocurridas en o antes de `last_settlement_at` o ya incluidas en `cash_settlements`.

### C. Persistencia de Ventas e Inventario con Cero Duplicados (`src/views/Inventory.tsx`, `server.ts`, `firebaseSync.ts`)
- **Edición de productos y existencias (`src/views/Inventory.tsx` y `server.ts`)**:
  - En `Inventory.tsx`: habilitar la edición de stock dentro del modal de edición de producto para administradores/propietarios (o usuarios con permiso `inventory_adjustments`), enviando `payload.stock` e `inventoryAdjustmentReason` únicamente cuando el usuario haya modificado el valor de stock respecto al original.
  - En `PUT /api/products/:id` (`server.ts`): conservar `oldProd.stock` cuando `req.body.stock` sea `undefined` (protegiendo ediciones de solo precio/nombre), pero aplicar el nuevo stock y generar su registro de Kárdex en `inventory_audit_logs` cuando `req.body.stock` sea enviado explícitamente por un usuario autorizado.
- **Protección integral de cambios locales y sincronización sin duplicados (`firebaseSync.ts` y `server.ts`)**:
  - En `pullFirestoreToLocal` (`firebaseSync.ts`): cuando un producto local tenga `localUpdated > remoteUpdated`, preservar todos sus campos actualizados localmente (`name`, `category`, `sku`, `stock`, `price_unit`, `price_bulk`, `price_cost`, `stock_alarm`, `image`, `updated_at`) sin pisarlos con valores antiguos de Firestore.
  - En el arranque de `server.ts` y en `/api/sync`: ejecutar `pushAllLocalToFirestore()` inmediatamente después de `pullFirestoreToLocal()` para asegurar que toda venta, ingreso de stock (`stock_arrivals`), producto o liquidación pendiente en SQLite quede respaldada en Firestore.
  - Mantener el candado de idempotencia (`client_operation_id` en `processed_operations` y `lastSyncedDigestCache` SHA-256) para impedir cualquier duplicación de ventas, movimientos de caja o ajustes de stock.

---

## 3. Verificación
- Compilar la aplicación (`compile_applet`) verificando cero errores de TypeScript.
- Verificar en la base de datos de producción (`gtr_pos.db` y Firestore) que:
  1. Las ventas e inventario reales se cargan y persisten en modo `production`.
  2. La liquidación/reseteo de caja acumulada pone `current_balance = 0.00 Bs`, cambia todos los `cash_movements` a `'liquidado'`, persiste el cierre en `cash_settlements` y no revive el saldo tras ejecutar ciclos de sincronización con Firestore.
  3. El registro de ventas y cambios de inventario guarda y sincroniza en Firestore con cero registros duplicados.
