# Plan de Remediación Crítica: Base de Datos y Caja (GTR POS)

Plan de ingeniería para corregir de forma segura, modular y verificada las fallas críticas de base de datos, idempotencia, matemática monetaria de caja y gestión de stock señaladas en el documento de mejoras de auditoría.

## Decisiones Críticas y Alcance Confirmado

> [!IMPORTANT]
> Siguiendo la respuesta del usuario, el alcance de esta intervención se enfoca **únicamente en las fallas críticas de base de datos y caja/moneda**, ejecutado **por fases con verificación automatizada por bloque**.

- **Alcance Acordado**: Base de datos, idempotencia (`processed_operations`), arqueo y matemática de caja (`credits`, `sales`, `returns`), conteo físico y disponibilidad de inventario.
- **Exclusiones Acordadas**: Cambios cosméticos de UI no relacionados con la integridad transaccional de caja y base de datos.
- **Estrategia**: Cero pérdida de datos comerciales, migración retrocompatible en SQLite y suite de pruebas automatizadas por bloque antes del pase final.

---

## 1. Visión General del Sistema y Flujo Afectado

```
┌────────────────────────────────────────────────────────────────────────┐
│                        ARQUITECTURA DE DATOS Y CAJA                    │
└────────────────────────────────────────────────────────────────────────┘

    [Cliente POS / PWA]
            │
            ▼
    ┌──────────────────────┐      ┌───────────────────────────────────┐
    │ POST /api/sales      │ ───► │ Idempotencia: processed_operations│ (Fase 1: T01)
    │ POST /api/returns    │      │ (Validación de hash y op_id único)│
    └──────────────────────┘      └───────────────────────────────────┘
            │
            ▼
    ┌──────────────────────┐      ┌───────────────────────────────────┐
    │ Devoluciones Múltiples│ ───► │ sale_returns (op_id compuesto)    │ (Fase 3: T04, T19)
    │ Cuentas por Cobrar   │ ───► │ Abonos USD/BOB con tasa de cambio │ (Fase 3: T24)
    └──────────────────────┘      └───────────────────────────────────┘
            │
            ▼
    ┌──────────────────────┐      ┌───────────────────────────────────┐
    │ Conteo de Inventario │ ───► │ Delta relativo sobre stock vivo   │ (Fase 2: T02, T03)
    │ Pedidos y Reservas   │ ───► │ Validación sum(items) y stock neto│ (Fase 4: T15, T16, T25)
    │ Ventas Offline       │ ───► │ offline_pending_sales (+abono)    │ (Fase 4: T17)
    └──────────────────────┘      └───────────────────────────────────┘
            │
            ▼
    ┌─────────────────────────────────────────────────────────────────┐
    │ SQLite Core Engine (gtr_pos.db & gtr_pos_sandbox.db)            │
    │ Respaldos en caliente con API nativa: db.backup() (Fase 5: T10)  │
    └─────────────────────────────────────────────────────────────────┘
```

---

## 2. Plan de Implementación por Fases

### Fase 1: Unificación de Esquema e Idempotencia en Base de Datos (T01 & T18)
- **Problema**: En `database.ts`, existen dos sentencias `CREATE TABLE IF NOT EXISTS processed_operations` contradictorias. La primera omite `client_operation_id`, provocando en cada arranque del servidor el error: `SqliteError: no such column: client_operation_id`. Esto anula el control de idempotencia y deja desprotegidas las ventas y cobros ante reintentos.
- **Acción**:
  1. Unificar la definición canónica de `processed_operations` en `database.ts` con todas las columnas requeridas: `id`, `client_operation_id UNIQUE NOT NULL`, `operation_type`, `payload_hash`, `response_body`, `status`, `created_at`.
  2. Implementar una migración segura que detecte si la tabla existente carece de `client_operation_id`, migrando los registros o actualizando la tabla sin destruir datos.
  3. Aplicar tanto en `gtr_pos.db` como en `gtr_pos_sandbox.db`.

### Fase 2: Conteo Físico y Estados de Inventario (T02 & T03)
- **Problema**:
  - **T02**: En `server.ts`, la aprobación de conteos calcula `delta = physical - snapshot`. Si se vendieron unidades entre el inicio del conteo y la aprobación, la venta se resta dos veces, corrompiendo el stock hacia abajo.
  - **T03**: En `firebaseSync.ts`, el filtro de estados locales protege `['cancelado', 'aprobado', 'cerrado']` pero omite `finalizado`, permitiendo que un documento remoto desaprobado reabra un conteo y duplique el ajuste de stock.
- **Acción**:
  1. En `server.ts:approveInventoryCount`, calcular el delta de ajuste con respecto al stock vivo actual o fijar el stock físico contado directamente si el proceso fue de conteo ciego validado.
  2. En `firebaseSync.ts`, incorporar `finalizado` a la lista de estados locales terminales protegidos e impedir que `applied_at` se sobreescriba si el conteo ya impactó el inventario.

### Fase 3: Caja, Devoluciones y Matemática Monetaria (T04, T19 & T24)
- **Problema**:
  - **T04**: El índice `idx_sale_returns_client_op_id` es único por fila en `sale_returns`. Al procesar devoluciones con múltiples productos bajo un mismo ticket/petición, la segunda fila choca con la restricción UNIQUE y hace rollback con error 500.
  - **T24**: En `POST /api/credits/:id/payments`, los abonos en Bolivianos se restan directamente del saldo en Dólares (`remaining - payAmount`), borrando deudas en dólares con centavos de bolivianos.
  - **T19**: En devoluciones parciales sucesivas, los redondeos unitarios pueden acumular reembolsos superiores al total original efectivamente pagado.
- **Acción**:
  1. En `database.ts` y `server.ts`, ajustar la clave de idempotencia de líneas de devolución a nivel de item (`${client_operation_id}_item_${item.id}`) o registrar el `client_operation_id` a nivel de cabecera de devolución.
  2. En `server.ts`, aplicar la conversión de divisa estricta al abonar a una deuda en USD con BOB: `montoAbonadoUSD = payAmount / exchangeRate`, actualizando la deuda en USD y registrando en caja el ingreso real en BOB.
  3. En `server.ts`, topear el reembolso acumulado al subtotal neto pagado de la compra original.

### Fase 4: Reservas de Stock, Validación de Pedidos y Caja Offline (T15, T16, T17 & T25)
- **Problema**:
  - **T25**: `POST /api/pending-sales` confía en el campo `total` enviado en el cuerpo de la petición sin recalcularlo en el servidor a partir de los ítems.
  - **T15 & T16**: No se valida la disponibilidad neta (`stock - getReservedStock`) al registrar pedidos ni al aprobar ventas offline, provocando sobregiros de stock.
  - **T17**: La tabla `offline_pending_sales` no incluye la columna `initial_abono`, por lo que el anticipo cobrado al cliente en una venta a crédito fuera de línea desaparece del arqueo de caja.
- **Acción**:
  1. En `database.ts`, añadir la columna `initial_abono REAL DEFAULT 0` a `offline_pending_sales` mediante migración segura.
  2. En `server.ts`, validar en el backend que `total == round(sum(price * quantity) - discount, 2)` en pedidos pendientes.
  3. En `server.ts`, verificar disponibilidad real antes de confirmar reservas y aprobar ventas offline.
  4. Al aprobar ventas offline a crédito con anticipo, ingresar dicho monto real a los movimientos de caja activa.

### Fase 5: Respaldos Físicos Online en SQLite (T10)
- **Problema**:
  - Las copias de respaldo mediante `fs.copyFileSync` mientras SQLite opera con WAL pueden generar archivos `.db` incompletos o inconsistentes si hay páginas en el archivo `-wal` que no han sido checkpointed.
- **Acción**:
  1. Implementar la rutina de respaldo usando la API nativa asíncrona de better-sqlite3: `db.backup(destinationPath)`.
  2. Asegurar que las descargas de respaldo desde la UI y los respaldos automáticos utilicen este mecanismo transaccional seguro.

### Fase 6: Batería de Pruebas Automatizadas y Certificación
- **Acción**:
  1. Crear una suite de pruebas automatizada dedicada (`tests/txt_critical_fixes_runner.cjs`) que simule y certifique cada una de las correcciones implementadas:
     - Prueba de arranque e inserción idempotente en `processed_operations`.
     - Prueba de abono en BOB sobre deuda en USD con conversión de tipo de cambio.
     - Prueba de devolución multilínea con el mismo ID de cliente.
     - Prueba de aprobación de conteo físico sin doble descuento de stock.
     - Prueba de validación de total recalculado en pedidos pendientes.
     - Prueba de persistencia de anticipo de venta offline en arqueo de caja.
     - Prueba de integridad de backup con `db.backup()`.
  2. Ejecutar la suite completa y confirmar 100% de pruebas aprobadas antes del cierre.

---

## 3. Decisiones Técnicas y Salvaguardas

- **Preservación de Datos**: Las bases de datos `gtr_pos.db` y `gtr_pos_sandbox.db` ya cuentan con respaldo frío en `backups/`. Las modificaciones de esquema utilizarán `ALTER TABLE` o tablas temporales con copia idempotente, sin sentencias `DROP TABLE` destructivas.
- **Transaccionalidad en SQLite**: Toda operación compuesta (ej. venta + caja + stock + auditoría) continuará encapsulada en `db.transaction(...)`.
- **Aislamiento Sandbox/Producción**: Se mantiene la separación estricta mediante `dbAsyncLocalStorage`.
