# Cierre Operativo GTR POS — Resolución de Observaciones del Dictamen (bfe1047)

Este plan resuelve de forma definitiva los 4 bloqueos operativos (`Z01`, `Z02/Z03/Z07`, Reglas de Firestore y `Z04`) y las diferencias de idempotencia sin clave (`T05/T06`) señalados en el dictamen de revisión sobre el commit `bfe1047`, dejando el sistema listo para operar en caja con continuidad garantizada, precisión contable neta y seguridad estricta.

## User Review & Critical Decisions

> [!IMPORTANT]
> **Decisiones confirmadas por el usuario en Fase 1:**
> - **Continuidad de Ventas y Secuencia de IDs (`Z01`)**: Basar el bloqueo anti-fantasmas únicamente en `deleted_records` (eliminando la lista fija `437..440` de triggers y reglas) y adelantar automáticamente `sqlite_sequence` por encima de cualquier ID presente en `deleted_records` antes de insertar nuevas ventas o pedidos.
> - **Recuperación Contable Neta e Idempotente (`Z02`, `Z03`, `Z07`)**: Calcular el efecto neto exacto (ventas menos devoluciones ya aplicadas y movimientos de caja con su signo real) una sola vez por venta mediante registro atómico de remediación, coordinado con la réplica durante `pullFirestoreToLocal`, y eliminar las inserciones de auditorías sintéticas fijas (`+1` / `+24`).
> - **Reglas de Firestore, Verificador Aislado y Deduplicación (`Z04`, `T05/T06`)**: Aislar la regla comodín `match /{collectionName}/{docId}` para que jamás anule las protecciones de `users`, `settings` o bitácoras; exigir autenticación real eliminando `hasIntegrityProof()` como bypass anónimo; hacer que el verificador opere 100% en copia temporal sin abrir jamás `gtr_pos.db` con escritura; y deduplicar devoluciones y abonos enviados sin `client_operation_id`.

---

## 1. Overview & Core Concept

- **Qué resuelve**:
  1. **Continuidad ininterrumpida en Caja (`Z01`)**: Evita que el contador `AUTOINCREMENT` de SQLite choque contra IDs prohibidos (`437–440`) o contra tombstones en `deleted_records` tras una restauración de réplica.
  2. **Exactitud Matemática en Hidratación de Incidentes (`Z02`, `Z03`, `Z07`)**: Garantiza que si se hidrata el estado de remediación sobre una base o réplica que contiene ventas retiradas (con o sin devoluciones previas), el inventario y la caja queden en su saldo neto exacto una única vez, sin duplicar reposiciones ni ser sobrescritos por instantáneas antiguas durante `pullFirestoreToLocal`.
  3. **Seguridad Zero-Trust en Firestore**: Impide que la regla comodín (`/{collectionName}/{docId}`) permita borrar usuarios, configuraciones o bitácoras, elimina el bypass por campos aportados por el cliente (`hasIntegrityProof`) y restringe eliminaciones a administradores.
  4. **Aislamiento Total de Pruebas (`Z04`) e Idempotencia Universal (`T05/T06`)**: El script de certificación nunca abre `gtr_pos.db` ni `gtr_pos_sandbox.db` en modo escritura, y los endpoints de devoluciones y abonos generan una clave determinista de ventana corta cuando un cliente legado omite `client_operation_id`.

---

## 2. User Experience & Visual Design

- **Flujo Transparente para el Cajero y Administrador**:
  - Al registrar ventas consecutivas (incluyendo el cruce por los IDs `436 -> 437 -> 441` o tras restaurar una copia previa), el POS emite los tickets sin interrupciones ni errores `500`.
  - Al ejecutar sincronización desde la nube (`pullFirestoreToLocal`), el stock y el saldo de caja reflejan exactamente las operaciones reales netas.
  - Si una terminal con versión previa reintenta una devolución o abono por caída momentánea de red sin enviar `client_operation_id`, el servidor devuelve la respuesta original idempotente sin duplicar el movimiento en caja ni en inventario.

---

## 3. Key Product Decisions & Trade-Offs

- **Decisión 1: Eliminación de lista negra estática `437..440` + Avance Automático de `sqlite_sequence` (`Z01`)**
  - *Enfoque elegido*: Los triggers `trg_block_ghost_*` consultan únicamente `deleted_records`. Adicionalmente, el helper `ensureSafeAutoincrementSequence(db, tables)` garantiza que `sqlite_sequence.seq` sea siempre `>= MAX(MAX(tabla.id), MAX(CAST(deleted_records.record_id AS INTEGER)))`.
  - *Por qué*: Si una venta no fue eliminada, el ID `437` es completamente utilizable; y si un ID (ej. `399` o `437`) sí está en `deleted_records` tras restaurar una réplica con secuencia menor, adelantar `sqlite_sequence` hace que SQLite asigne el siguiente ID libre (`> max_deleted_id`) sin abortar la venta ni renumerar ventas históricas.

- **Decisión 2: Reversión Contable Neta, Única y Coordinada con el Pull (`Z02`, `Z03`, `Z07`)**
  - *Enfoque elegido*:
    - Para cada venta objetivo que aún exista como encabezado activo en `sales` y no haya sido marcada como revertida en `incident_quarantine_records`:
      - **Stock neto a reponer por producto**: `MAX(0, SUM(sale_items.quantity) - SUM(sale_returns.quantity))` (no vuelve a reponer unidades que ya habían entrado al almacén mediante una devolución previa).
      - **Efecto neto de caja a revertir por vendedor**: `SUM(CASE WHEN type = 'devolucion' OR amount < 0 THEN -ABS(amount_bs) ELSE ABS(amount_bs) END)` sobre `cash_movements` de esa venta (considerando también egresos por devolución registrados con `sale_id` o derivados de `sale_returns`), de modo que una venta de Bs 30 con devolución previa de Bs 10 solo descuente los Bs 20 netos que permanecían en caja.
    - Si el encabezado en `sales` ya no existe o ya fue revertido (`Z03`), las filas huérfanas remanentes en `sale_items`, `cash_movements`, `accounts_receivable` o `sale_returns` se archivan y eliminan sin tocar `products.stock` ni `cash_accounts.current_balance`.
    - Durante `pullFirestoreToLocal` (`Z07`), el cálculo de efectos netos sobre ventas retiradas presentes en la réplica remota o local se coordina con la importación de las 26 colecciones (`SYNC_TABLES`) para que la tabla `cash_accounts` y `products` conserven el ajuste neto y nunca sean pisadas por el saldo pre-purga de la réplica.
    - Se eliminan por completo los `INSERT` fijos artificiales (`+1` en producto 1, `+24` en producto 5 y log con fecha fija `2026-10-27T12:30:00-04:00`) tanto de `database.ts` como de `firebaseSync.ts`.

- **Decisión 3: Cierre de Regla Comodín y Autenticación Estricta en Firestore**
  - *Enfoque elegido*:
    - Aislar `match /{collectionName}/{docId}` con una guarda explícita `isBusinessCollection(collectionName)` que excluya `users`, `usuarios`, `settings`, `system_audit_logs`, `firestore_transaction_ledger`, `sale_returns`, `system`, `sync_metadata` y `security_logs`, evitando que el comodín anule los `allow delete: if false` específicos.
    - Exigir `isAuthenticated()` en todas las escrituras y lecturas operativas de producción (el demonio del servidor se autentica con `FIREBASE_SYNC_EMAIL` / `FIREBASE_SYNC_PASSWORD` o token válido), usando `hasIntegrityProof()` como validación estructural adicional en `create`/`update` y nunca como sustituto de autenticación.
    - Restringir `allow delete` en colecciones de negocio únicamente a `isAdmin()` (o colecciones `sandbox_*`).

- **Decisión 4: Deduplicación Determinista de Ventana para `T05` y `T06`**
  - *Enfoque elegido*: En `POST /api/sales/refund`, `POST /api/accounts-receivable/:id/pay` y `POST /api/pending-sales/:id/pay`, si la solicitud no incluye `clientOperationId` / `client_operation_id`, el servidor sintetiza una clave determinista basada en el estado actual del registro antes de mutarlo (ej. para devolución: hash del payload + unidades ya devueltas `alreadyReturnedTotal` en una cubeta temporal de 15 segundos; para abono: hash del payload + `paid_amount` actual en cubeta de 15 segundos, o detección de ráfaga idéntica inmediata), registrándola en `processed_operations` para que reintentos duplicados sin clave devuelvan el resultado original sin duplicar el efecto.

---

## 4. Technical Architecture & Data Strategy

```
┌────────────────────────────────────────────────────────────────────────────┐
│                    FLUJO DE CONTINUIDAD, SINCRONIZACIÓN Y SEGURIDAD        │
└────────────────────────────────────────────────────────────────────────────┘
                                      │
      ┌───────────────────────────────┼───────────────────────────────┐
      ▼                               ▼                               ▼
┌───────────────────────────┐ ┌───────────────────────────┐ ┌───────────────────────────┐
│ 1. Continuidad IDs (Z01)  │ │ 2. Hidratación Neta       │ │ 3. Firestore & Endpoints  │
│ - Triggers consultan solo │ │    (Z02 / Z03 / Z07)      │ │ - Regla comodín aislada   │
│   deleted_records         │ │ - Stock neto = vendido    │ │   de users/settings/logs  │
│ - ensureSafeAutoincrement │ │   menos devuelto          │ │ - Auth obligatoria +      │
│   adelanta sqlite_sequence│ │ - Caja neta = ingresos    │ │   delete solo isAdmin()   │
│   > MAX(deleted_records)  │ │   menos devoluciones      │ │ - T05/T06: clave          │
│   antes de cada venta     │ │ - Aplicado 1 sola vez y   │ │   determinista si falta   │
│                           │ │   preservado tras pull    │ │   client_operation_id     │
└───────────────────────────┘ └───────────────────────────┘ └───────────────────────────┘
```

### Validación y Certificación Aislada (`Z04`)
- El script `scripts/verify_zero_defect_suite.cjs` se refactoriza para no abrir jamás `gtr_pos.db` ni `gtr_pos_sandbox.db` con permisos de escritura: todas las pruebas (`Z01`, `Z02`, `Z03`, `Z04`, `Z05`, `Z06`, `Z07` y `T05/T06`) se ejecutan sobre bases SQLite temporales o en memoria (`:memory:`), más la verificación de `npm run build` y `npm run lint`.
