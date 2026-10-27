# Plan de Implementación: Resolución de Defectos y Cierre de Auditoría c227fa0 (GTR666)

## 1. Contexto y Objetivos
Tras la verificación exhaustiva sobre el commit `c227fa0`, 114 de 156 escenarios resultaron aprobados (+19 con respecto a la revisión anterior). Sin embargo, se identificaron 42 casos no cumplidos y regresiones críticas de usabilidad (especialmente el bloqueo del formulario de pedidos en POS) y seguridad en rutas de servidor.

Este plan establece la solución quirúrgica y definitiva respetando las respuestas del usuario:
- **Permisos por defecto**: Denegación estricta (`userPerms.xxx === true` o rol administrador principal).
- **Autoría de ventas offline**: Identidad atribuida con consistencia total al cajero transmisor (`effectiveUserId`, `effectiveUserName`).
- **Formulario de pedidos**: Liberación garantizada de `isSavingPendingRef.current = false` en bloque `finally` para permitir envíos consecutivos y reintentos tras errores.

---

## 2. Puntos Críticos y Estrategia de Solución

### A. Desbloqueo Inmediato del Formulario de Pedidos en POS (`src/views/POS.tsx`)
- **Problema (B01, B02)**: `isSavingPendingRef.current = true` nunca se restablecía a `false` en el bloque `finally` de `handleSavePendingSale`, bloqueando permanentemente nuevos pedidos o correcciones tras error HTTP 400.
- **Acción**:
  1. En `finally`: agregar explícitamente `isSavingPendingRef.current = false;`.
  2. Al cerrar el modal o reiniciar el carrito: asegurar que `isSavingPendingRef.current = false;`.
  3. Mantener `clientOpId` estable mientras persista la misma intención de guardado, pero renovarlo al limpiar o crear un nuevo pedido.

### B. Deduplicación Transaccional y Agregación de Demanda en Pedidos (`server.ts`)
- **Problema (E05, E09, N06)**:
  - En `POST /api/pending-sales`, el `clientOpId` no se insertaba en `processed_operations` dentro de la transacción, permitiendo duplicación en reintentos.
  - En `PUT /api/pending-sales/:id`, no se agregaba la demanda por producto con líneas repetidas, permitiendo sobre-reserva.
- **Acción**:
  1. En `POST /api/pending-sales`: insertar en `processed_operations` (`operation_type: 'pending_sale'`) dentro de la misma transacción de SQLite. Si ya existe idéntico payload, retornar el pedido anterior con `{ isDuplicate: true }`; si difiere el payload comercial, responder HTTP 409.
  2. En `PUT /api/pending-sales/:id`: agregar la demanda por `product_id` de las nuevas líneas, descontar las reservas existentes de ese mismo pedido (`currentOrderLines`), y validar `netAvailable >= totalDemand`.

### C. Conflicto Canónico (HTTP 409) y Validación de Precios en Ventas (`server.ts`)
- **Problema (K07, B04, B08)**:
  - Al reutilizar `client_operation_id` con payload modificado, el servidor arrojaba `CONFLICT_409` capturado erróneamente en `/api/sale-returns` con referencia rota a `clientOpId`, devolviendo HTTP 500.
  - El hash SHA-256 no incluía `currency`, `exchange_rate` ni actor, permitiendo cambiar de BOB a USD con el mismo hash.
  - Ventas de administrador no validaban si `item.price` era numérico finito $\ge 0$.
- **Acción**:
  1. Trasladar el bloque `catch` para `CONFLICT_409` a `POST /api/sales` retornando limpiamente `res.status(409).json({ error: 'Operación en conflicto: la clave de operación ya fue utilizada con datos comerciales diferentes.' })`.
  2. Incluir en el hash comercial: `items` (id, qty, price, discount), `total`, `discount`, `client_id`, `payment_method`, `currency`, `exchange_rate`, y `user_id`.
  3. Validar `Number.isFinite(item.price) && item.price >= 0` en todas las líneas antes de entrar a la transacción.

### D. Sanitización de Costos y Atribución en Ventas Offline (`server.ts`)
- **Problema (B03, B07, K13)**:
  - En `GET /api/offline-sales/pending`, aunque `items[].cost` se enmascaraba, se retornaba `...row` que contenía `items_json` en texto crudo con el costo de compra.
  - En `POST /api/offline-sales/submit`, se usaba `effectiveUserId` para consultar el nombre de usuario, pero la sentencia SQL `INSERT` usaba `user_id || 1` proveniente del cuerpo del cliente, desincronizando ID y nombre.
- **Acción**:
  1. En `GET /api/offline-sales/pending`: eliminar `items_json` de la respuesta o reconstruirlo a partir del array sanitizado cuando el usuario no sea administrador.
  2. En `POST /api/offline-sales/submit`: enlazar `effectiveUserId` en la columna `user_id` de la inserción, garantizando que el autor sea estrictamente el cajero transmisor autenticado.

### E. Enforzamiento Estricto de Permisos por Defecto (`server.ts`)
- **Problema (B05, B06, E10, E13)**:
  - Si `manage_credits` o `physical_control_checklist` no estaban explícitamente en `false` (ej. valor `undefined`), el cajero tenía acceso a cuentas por cobrar y edición de conteos.
  - El rol literal `cajero` (distinto de `vendedor`) obtenía liquidaciones globales.
- **Acción**:
  1. En `/api/accounts-receivable` (GET y POST abonos): `const canManageCredits = isAdmin || userPerms.manage_credits === true; if (!canManageCredits) return res.status(403)...`.
  2. En `/api/inventory-counts/:id` (GET y PUT): exigir `isAdmin || userPerms.physical_control_checklist === true` y validar que el conteo pertenezca al usuario y no esté cerrado/aplicado.
  3. En `/api/cash-register/closures` y `/api/liquidations`: condicionar el alcance global a `isAdmin`. Si el usuario no es admin (sea `vendedor`, `cajero` o similar), filtrar exclusivamente por su propio `user_id`.

### F. Control de Voz WebSocket Exclusivo para Administrador Principal (`server.ts`)
- **Problema (V01)**:
  - `authenticateWebSocketUpgrade` en la ruta `/live` aceptaba cualquier rol `admin`/`administrador`/`propietario`.
- **Acción**:
  - Requerir estrictamente `isMainAdmin(userRow)` para la conexión al socket `/live`.

---

## 3. Plan de Verificación y Certificación
1. **Verificación Estática y Sintaxis**:
   - `compile_applet` para garantizar que TypeScript y Vite compilan con cero errores.
2. **Ejecución de Pruebas de Regresión y Nuevas Pruebas**:
   - `tests/check_kiosk_v2.cjs` (verificar los 11 escenarios de kiosco).
   - `tests/txt_critical_fixes_runner.cjs` (verificar los 24 casos de seguridad y balances).
   - `tests/test_all_six_points.cjs` (verificar precios BOB, roundCashBs, JWT, y roles).
   - `tests/test_product_history_synthesis.cjs` (verificar kárdex y running balance intactos).
   - Crear y correr un runner específico para los casos B01-B08, E05, E09, E10, E13, K07, K13, N06.
3. **Resguardo de Datos**:
   - Confirmar que `gtr_pos.db` mantiene la integridad total de sus 169+ productos y catálogo comercial.
