# Plan de Implementación — Blindaje Integral "Cero Fallas" (Trazabilidad 100%, Anti-Fantasma, Anti-Doble Sync y Precisión Matemática)

## 1. Objetivo
Garantizar que el sistema opere con **precisión matemática del 100%**, **trazabilidad inmutable** y **cero posibilidad de registros fantasmas o doble sincronización**, integrando barreras a nivel de motor SQLite, sincronizador Firestore, endpoints transaccionales y una batería exhaustiva de pruebas automatizadas.

---

## 2. Capas de Blindaje a Implementar

### Capa 1: Triggers SQLite Anti-Fantasma e Invariantes Financieros (`database.ts`)
Se instalarán triggers nativos en SQLite dentro de `ensureAllTablesAndMigrations()` para que el propio motor de base de datos impida cualquier estado inválido o resurrección de registros eliminados, sin importar qué ruta o proceso intente escribir:
- **Triggers Anti-Resurrección de Tombstones (`trg_block_ghost_*`)**:
  - `BEFORE INSERT` en `sales`, `pending_sales`, `cash_movements`, `accounts_receivable`, `credit_payments`, y `sale_returns`: aborta con `RAISE(ABORT, 'GHOST_RECORD_BLOCKED')` si el `NEW.id` existe en `deleted_records` para esa tabla o si la venta/pedido padre está en `deleted_records` o en `BLOCKED_INCIDENT_SALE_IDS` (`437`, `438`, `439`, `440`).
  - `BEFORE INSERT` en `sale_items` y `pending_sale_items`: aborta si su `sale_id` / `pending_sale_id` padre está en `deleted_records` o si el ítem mismo fue eliminado.
- **Triggers de Invariantes Numéricos y No-Negatividad (`trg_invariant_*`)**:
  - **Stock protegido**: `BEFORE UPDATE OF stock ON products` impide que `NEW.stock < 0` (`RAISE(ABORT, 'NEGATIVE_STOCK_FORBIDDEN')`).
  - **Saldos de Cuentas por Cobrar coherentes**: `BEFORE INSERT / UPDATE ON accounts_receivable` impide que `NEW.remaining_amount < -0.01` o `NEW.remaining_amount > NEW.amount + 0.01`.
  - **Puntos de fidelidad no negativos**: `BEFORE UPDATE OF points ON clients` impide que `NEW.points < 0`.

---

### Capa 2: Prevención de Doble Sincronización y Deduplicación por Hash (`firebaseSync.ts` y `server.ts`)
Para erradicar escrituras redundantes, condiciones de carrera entre `push` y `pull` y ciclos de re-sincronización de datos idénticos:
- **Caché de Huellas SHA-256 (`lastSyncedDigestCache`)**:
  - Cada registro sincronizado (`tableName:docId`) almacena un hash determinista de su payload útil (excluyendo metadatos volátiles como `_syncedAt` e `_integrity`).
  - En `pushLocalToFirestore`: si el hash actual del registro local coincide exactamente con el último hash confirmado en Firestore (ya sea por un `push` previo o recién descargado en `pullFirestoreToLocal`), se omite el `batch.set()` ahorrando cuota y evitando doble sincronización.
  - En `pullFirestoreToLocal`: al insertar o actualizar un documento remoto válido, se registra inmediatamente su hash en `lastSyncedDigestCache` para que el siguiente ciclo de `push` no vuelva a subirlo a Firestore.
- **Mutex / Cola Unificada y Coalescencia de `syncAfterWrite`**:
  - Implementar un cerrojo de exclusión mutua (`syncExecutionQueue`) para que `pushLocalToFirestore` y `pullFirestoreToLocal` nunca se ejecuten en paralelo.
  - En `server.ts`, agregar un debounce/coalescencia de 250 ms por `tableName:id` en `syncAfterWrite` para agrupar múltiples actualizaciones rápidas de una misma transacción en un único envío a Firestore.

---

### Capa 3: Precisión Matemática Autoritativa al 100% y Dashboard Neto (`server.ts`)
- **Recálculo e Imposición Autoritativa en `POST /api/sales` y `POST /api/pending-sales`**:
  - El servidor calculará de forma autoritativa el subtotal exacto de los ítems (`ROUND(SUM(quantity * price), 2)`), validará que el descuento manual y el descuento por puntos no superen el subtotal, e **impondrá automáticamente el `authoritativeTotal` calculado por el servidor** (`Math.max(0, Number((itemsSubtotal - safeDiscount - safePointsDiscount).toFixed(2)))`).
  - Si el total enviado por el cliente difería del total real, se corrige transparentemente al valor exacto del servidor y se deja constancia en el log de auditoría (`[MATH_PRECISION_ENFORCED]`), garantizando **cero errores de cálculo** en ventas, pagos mixtos, créditos y comisiones.
- **Dashboard Financiero 100% Neto de Devoluciones (`GET /api/dashboard`)**:
  - Ajustar las consultas de ingresos (`totalRevenue`), ganancias (`totalProfit`), ventas del período y métricas por método de pago en `GET /api/dashboard` para descontar las devoluciones registradas en `sale_returns` (tanto ingresos devueltos como utilidad revertida según el costo de los productos devueltos), manteniendo paridad exacta al centavo con el Historial de Ventas y Devoluciones.

---

### Capa 4: Endurecimiento de Reglas de Firestore (`firestore.rules`)
- Definir explícitamente la función `isAdmin()` verificando `request.auth != null && request.auth.token.email == 'robymetalero@gmail.com' && request.auth.token.email_verified == true`.
- Añadir validaciones de límites numéricos (`hasValidSaleBounds`, `hasValidProductBounds`, `hasValidReceivableBounds`) que impidan crear o actualizar documentos con `stock < 0`, `total < 0`, `remaining_amount < 0` o IDs bloqueados (`437..440`), preservando intacta la sincronización automática del servidor mediante `hasIntegrityProof()`.
- Desplegar las reglas actualizadas con `deploy_firebase`.

---

### Capa 5: Suite Automatizada de Certificación Multi-Escenario (`scripts/verify_zero_defect_suite.cjs`)
Se creará y ejecutará una suite de pruebas exhaustiva que certificará en vivo tanto la nueva batería **Zero-Defect** como los **30 escenarios previos**:
1. **Prueba de Triggers SQLite Anti-Fantasma**: Intento directo de insertar ventas/ítems/movimientos cuyos IDs están en `deleted_records` o en la lista negra `#437-#440` -> verifica bloqueo inmediato por trigger.
2. **Prueba de Invariantes Numéricos en Motor DB**: Intento de forzar stock negativo en `products`, saldo negativo en `accounts_receivable` o puntos negativos en `clients` -> verifica rechazo por trigger.
3. **Prueba de Recálculo Matemático Autoritativo**: Envío de una venta con `total` manipulado o con error de redondeo en el cliente -> verifica que el servidor impone el total exacto de la suma de ítems menos descuentos y registra el movimiento de caja por el monto exacto.
4. **Prueba de Deduplicación Anti-Doble Sync**: Ejecución consecutiva de sincronización sobre los mismos registros -> verifica mediante el caché de hashes que la segunda pasada detecta `0` cambios pendientes y no duplica escrituras.
5. **Prueba de Trazabilidad Completa (Venta -> Crédito -> Pago -> Devolución Parcial -> Dashboard Neto -> Kárdex)**: Verifica cuadre exacto al centavo entre `sales`, `sale_returns`, `cash_accounts`, `cash_movements`, `inventory_audit_logs` y `/api/dashboard`.
6. **Ejecución de `scripts/verify_all_30_scenarios.cjs`**: Confirmación de 30/30 PASS sin regresiones.
