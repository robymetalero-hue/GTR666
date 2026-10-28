# Plan de Implementación: Correcciones Prioritarias de Auditoría Técnica (GTR666)

Este plan integra todas las mejoras seleccionadas del informe de auditoría (`Revision_integral_GTR666_ff17b7d`) de forma **100% quirúrgica y retrocompatible**, sin alterar el flujo de trabajo actual ni romper la sincronización en tiempo real del cliente web.

---

## Bloque 1: Seguridad, Permisos, Aislamiento de Entorno e Integridad de Stock

### 1.1 Aislamiento Estricto de Entorno y Respaldos (`database.ts`, `server.ts`)
- **Prevención de salto a Producción desde Sandbox/Test (`server.ts`, `database.ts`)**:
  - En el middleware de contexto de entorno (`server.ts:218-240`) y `getDb()` (`database.ts:43-62`), si el proceso del servidor fue iniciado en `sandbox` o `test` (`APP_ENV` / `NODE_ENV`), ignorar cualquier cabecera `x-app-environment: production` o inferencia por `Host` para impedir que peticiones externas apunten a `gtr_pos.db`.
- **Respaldos `.bak` separados por entorno y verificación de integridad (`server.ts:5090-5116`, `database.ts:74`)**:
  - Usar rutas de respaldo específicas por entorno (`gtr_pos.db.bak` para producción, `gtr_pos_sandbox.db.bak` para sandbox) y ejecutar `PRAGMA wal_checkpoint(TRUNCATE)` + `PRAGMA integrity_check` antes de validar cualquier respaldo de contingencia.

### 1.2 Permisos y Atribución en Rutas de Ventas Pendientes / Pedidos (`server.ts`)
- **`POST /api/pending-sales/:id/toggle-reserve` (`server.ts:7849`)**:
  - Exigir `requirePermission(['edit_pending_sales', 'create_pending_sales'])` y tomar la identidad del operador desde `req.authSession` en lugar de confiar en campos del `req.body`.
- **`POST /api/pending-sales/:id/finalize` (`server.ts:7985`)**:
  - Exigir `requirePermission(['complete_pending_sales', 'create_sales'])` y vincular `user_id` al usuario autenticado de la sesión.
- **Revisión de rutas vecinas de pedidos (`PUT /api/pending-sales/:id`, `DELETE /api/pending-sales/:id`, `POST /api/pending-sales/:id/pay`)**:
  - Asegurar que todas validen su permiso correspondiente (`edit_pending_sales`, `cancel_pending_sales`) y registren el usuario real de `req.authSession`.

### 1.3 Respeto Estricto de Reservas de Stock en Finalización y Carrito POS (`server.ts`, `src/views/POS.tsx`, `src/context/AppContext.tsx`)
- **Finalización de pedido (`POST /api/pending-sales/:id/finalize` en `server.ts:7985`)**:
  - Calcular el stock disponible real descontando las unidades reservadas por **otros** pedidos activos (`stock - reserved_by_other_orders`), liberando únicamente la reserva propia del pedido que se está finalizando si tenía `reserve_stock = 1`.
- **Catálogo y límites en Carrito POS (`src/context/AppContext.tsx`, `src/views/POS.tsx`)**:
  - Respetar `stock_available` (stock físico menos reservas activas) al validar cantidades máximas en `addToCart` y `updateQuantity` para evitar que el cajero arme carritos con unidades comprometidas en reservas activas.

### 1.4 Edición Segura de Productos sin Sobrescribir Stock Vendido (`src/views/Inventory.tsx`, `server.ts`)
- **Separación de edición de metadatos vs. ajuste de stock**:
  - En `Inventory.tsx` y `PUT /api/products/:id` (`server.ts:3145`), al guardar la edición normal de un producto (nombre, código, categoría, precios, proveedor, imagen, stock mínimo), **ignorar el campo `stock`** del formulario para que nunca pise ventas ocurridas mientras el modal estaba abierto.
  - En el modal de edición de producto, mostrar el campo de stock como informativo (solo lectura) con acceso directo al flujo dedicado de **Ajuste de Inventario** (`POST /api/inventory/adjustments` o Ajuste Masivo), donde el cambio se aplica por delta auditado y con motivo obligatorio.

---

## Bloque 2: Sincronización en la Nube, Tombstones, Hashes y Guarda Forense

### 2.1 Orden de Hidratación y Prevención de Ventas "Revividas" (`firebaseSync.ts`, `server.ts`)
- **Hidratar invalidaciones antes de ventas (`firebaseSync.ts:928-956`)**:
  - Invertir el orden en `hydrateSqliteFromFirestoreIfNeeded` y sincronización incremental para que `hydrateInvalidatedSalesFromFirestore` se ejecute **antes** de procesar `sales` y `sale_items`, garantizando que los tombstones bloqueen la reimportación de ventas anuladas.
- **Preservar `payload_hash` en `processed_operations` (`firebaseSync.ts:766-819`)**:
  - Incluir `payload_hash` en la sincronización de `processed_operations` y usar `ON CONFLICT(operation_id) DO UPDATE SET payload_hash = COALESCE(excluded.payload_hash, processed_operations.payload_hash)` para no borrar el hash local durante una rehidratación.
- **Limpieza de `pending_sale_items` eliminados al editar pedido (`server.ts:7759-7845`, `firebaseSync.ts`)**:
  - Al actualizar los ítems de una venta pendiente (`PUT /api/pending-sales/:id`), eliminar en Firestore los documentos de `pending_sale_items` que ya no formen parte del pedido actualizado.

### 2.2 Bloqueo de Operaciones de Incidente y Guarda Forense (`server.ts`, `src/services/forensicAuditEngine.ts`)
- **Rechazo de `blocked_incident_399` en `POST /api/sales` (`server.ts:6931`)**:
  - Si `existingOp.status === 'blocked_incident_399'`, rechazar inmediatamente la operación con `409 Conflict` en lugar de permitir que continúe como venta nueva.
- **Guarda de seguridad en `forensicAuditEngine.ts` (`src/services/forensicAuditEngine.ts:1098`)**:
  - Desactivar la sobrescritura automática de `products.stock` en `reconcileStock` cuando el producto no tenga un corte base verificado o cuando solo se intente reconstruir desde `inventory_logs` parciales, dejándolo como alerta diagnóstica sin mutar el stock físico automáticamente.

---

## Bloque 3: Idempotencia Extremo a Extremo y Precisión Multimoneda (USD / BOB)

### 3.1 Llaves de Idempotencia Persistentes y Hash Completo (`src/views/POS.tsx`, `src/views/Inventory.tsx`, `src/views/CuentasPorCobrarView.tsx`, `server.ts`)
- **Persistencia de `clientOperationId` ante reintentos de red**:
  - Mantener el mismo `clientOperationId` asociado a la intención de cobro, abono, devolución o entrada de stock hasta que el servidor confirme éxito o el usuario modifique los datos del formulario, evitando duplicados por doble clic o corte momentáneo de red.
- **Hash de idempotencia completo en Ventas Pendientes (`server.ts:7490`)**:
  - Incluir `initial_abono`, `reserve_stock` y metadatos de pago dentro de `buildPendingSaleOperationHash`.
- **Validación de tasa de cambio histórica en reintentos confirmados (`server.ts:6915`)**:
  - Verificar que la tasa de cambio (`exchange_rate`) coincida antes de devolver respuesta idempotente exitosa.

### 3.2 Precisión en Créditos, Abonos Multimoneda y Devoluciones (`server.ts`, `src/views/CuentasPorCobrarView.tsx`)
- **Validación estricta de tasa de cambio (`exchangeRate > 0`)**:
  - Validar en todos los endpoints financieros (`/api/sales`, `/api/pending-sales`, `/api/credits/:id/pay`, `/api/Cashier/Open`, `/api/Cashier/Close`) que `Number.isFinite(rate) && rate > 0`.
- **Moneda y tasa explícita en abonos de Cuentas por Cobrar (`src/views/CuentasPorCobrarView.tsx`, `server.ts:5576`, `server.ts:7663`)**:
  - Permitir indicar explícitamente si el abono se recibe en `BOB` o `USD` junto con el tipo de cambio, registrando el monto exacto en la moneda de la cuenta de caja destino y el equivalente en `BOB` sobre el saldo de la deuda, e impidiendo sobrepagos tanto en el detalle como en la cabecera (`amount_paid <= total`).
- **Sincronización de `accounts_receivable` y ajuste de centavos en devoluciones (`server.ts:7416`, `server.ts:7212`)**:
  - Al procesar una devolución que reduzca el saldo de un crédito (`accounts_receivable`), replicar el documento actualizado de `accounts_receivable` a Firestore.
  - Cuando se devuelva el 100% de las unidades restantes de una venta, conciliar cualquier diferencia residual de `±0.01 BOB` por redondeo para que el reembolso total nunca supere ni quede por debajo del total cobrado.

---

## Bloque 4: Saneamiento de Scripts Externos de Consola (`scripts/` y raíz)

- **Parametrización y modo seguro (`--dry-run` por defecto)**:
  - En `scripts/execute_remediation.cjs`, `scripts/execute_firestore_cleanup.cjs`, `scripts/verify_all_30_scenarios.cjs` y `diagnose_incident_399.cjs`:
    - Eliminar credenciales/emails fijos o exigir variables de entorno (`ADMIN_EMAIL`, `ADMIN_PASSWORD`, `TARGET_SALE_ID`).
    - Envolver las correcciones SQL en transacciones atómicas (`db.transaction(...)`).
    - Exigir un flag explícito `--execute` para mutar datos reales (ejecutando `--dry-run` por defecto) para evitar ejecuciones accidentales.
