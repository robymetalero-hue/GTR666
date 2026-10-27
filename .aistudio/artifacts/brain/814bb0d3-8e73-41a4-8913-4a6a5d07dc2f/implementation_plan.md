# Plan de Implementación: Blindaje Integral de Seguridad, Kiosco y Consistencia Transaccional GTR666

Plan arquitectónico para resolver los 23 escenarios pendientes auditados en `Revision_GTR666_cambios_20261027_26de191c.txt`, garantizando el cumplimiento del 100% de los estándares de seguridad, aislamiento de datos entre cajeros, protección del inventario físico y conciliación matemática de caja y stock.

## Decisiones Críticas y Confirmaciones del Usuario

> [!IMPORTANT]
> A continuación se resumen las decisiones estratégicas confirmadas para la ejecución de este parche:
>
> 1. **Gestión de Precios y Moneda en Pedidos POS**:
>    - *Decisión confirmada*: **Forzar todos los pedidos a moneda nacional BOB calculada**.
>    - Cada ítem del pedido utilizará la misma función oficial de precio en bolivianos (`getCartItemPriceBs`), validando el total en el servidor con la tasa de cambio vigente y evitando reinterpretar precios en dólares como moneda local.
> 2. **Demanda Agregada por Producto en Pedidos**:
>    - *Decisión confirmada*: **Consolidar demanda total por producto y rechazar con HTTP 400 si supera el stock disponible**.
>    - Si un pedido repite el mismo producto en múltiples líneas, el sistema sumará las cantidades totales y verificará que no sobrepase `stock físico - reservas activas de otros pedidos`.
> 3. **Alcance de Cajeros en Cuentas por Cobrar y Conteos**:
>    - *Decisión confirmada*: **Bloqueo estricto HTTP 403 y prohibición de editar conteos cerrados o ajenos**.
>    - Cajeros sin permisos explícitos no podrán listar deudas ajenas, registrar abonos, ni modificar inventarios físicos completados (`applied_at != null` o estado aprobado/cerrado).

---

## 1. Alcance y Concepto Central

- **Propósito**: Eliminar las discrepancias detectadas en los 148 escenarios de prueba, blindando los accesos a datos financieros, evitando dobles reservas de stock en pedidos y blindando la integridad de las transacciones SQLite y réplicas.
- **Principio Rector**: Máxima seguridad y fidelidad contable sin alterar registros comerciales existentes, manteniendo intactos los snapshots de costos, tasas históricas y saldos de caja.
- **Usuarios Destinatarios**:
  - *Cajero en Terminal (Modo Kiosco)*: Interfaz ágil y aislada; solo accede a su propia caja, turnos y ventas; no puede inspeccionar deudas ajenas, ejecutar conciliaciones globales ni visualizar costos unitarios de compra.
  - *Administrador Principal / Propietario*: Supervisión forense completa, acceso exclusivo a herramientas de voz con ejecución SQL (`/live`), control de créditos y gestión de inventario.

---

## 2. Experiencia de Usuario y Flujos Operativos

```
┌────────────────────────────────────────────────────────────────────────┐
│                        FLUJO OPERATIVO BLINDADO POS                    │
└────────────────────────────────────────────────────────────────────────┘

  [ Cajero en Terminal ]
         │
         ├──► 1. Creación de Pedido (POS.tsx)
         │       • Conversión síncrona a moneda oficial BOB (V04/V05)
         │       • Inhabilitación inmediata del botón con 'isSubmittingRef' (V06)
         │       • Clave estable 'clientOperationId' generada por intención (E05)
         │       • Validación atómica de demanda agregada por producto (E06/N05)
         │
         ├──► 2. Cuentas por Cobrar y Abonos
         │       • Verificación estricta de permiso 'manage_credits' (K20/K21)
         │       • Tasa de cambio forzada positiva y finita (N08)
         │       • Monto en BOB impacta proporcionalmente a caja y deuda (N09/N10)
         │
         ├──► 3. Conteos Físicos de Inventario
         │       • Solo acceso a conteos propios en progreso (K14/E04)
         │       • Bloqueo total si está cerrado o aprobado (K15/K16)
         │       • Cantidades restringidas a enteros no negativos (E21)
         │
         └──► 4. Arqueo y Liquidación de Caja
                 • Solo visualiza su propia cuenta y movimientos (K10/E07)
                 • Costos unitarios completamente censurados (K12)

  [ Administrador Principal ]
         │
         ├──► Canal de Voz /live (Restringido estrictamente a 'isMainAdmin') (V01)
         ├──► Conciliación Global y Aprobación de Conteos Físicos
         └──► Supervisión de Auditoría Forense y Respaldos WAL Confiables
```

---

## 3. Decisiones de Producto y Arquitectura

1. **Aislamiento Estricto de Kiosco por Endpoint (server.ts)**:
   - `/api/cajas/status`: Filtrar automáticamente para que los cajeros únicamente reciban el saldo y arqueo de su propio `seller_id`. Solo administradores reciben la vista consolidada de todas las cajas.
   - `/api/offline-sales/pending`: Filtrar por el operador de sesión autenticado y enmascarar costos unitarios (`NULL as price_cost`).
   - `/api/inventory/reconcile-catalog`: Exigir rol de administrador (403 inmediato para cajeros).
   - `/api/accounts-receivable`: Exigir permiso explícito `manage_credits` o rol administrador.
   - `/api/inventory-counts/:id`: Validar propiedad del conteo y prohibir cualquier modificación si el conteo ya tiene `applied_at` o estado `aprobado`/`cerrado`.
2. **Normalización y Deduplicación en Pedidos Pendientes (POS.tsx & server.ts)**:
   - Forzar `currency: 'BOB'` y precios en bolivianos calculados con `getCartItemPriceBs` en `POST /api/pending-sales`.
   - Implementar deduplicación transaccional con `processed_operations`: si se reintenta con la misma clave e idéntico contenido, retornar el pedido original (200); si la misma clave se reutiliza con contenido alterado, responder `HTTP 409 Conflicto`.
   - Consolidar la demanda por `product_id` sumando líneas repetidas antes de comparar contra `stock - reservas_activas`.
3. **Control de Concurrencia Optimista en Inventario (server.ts)**:
   - En la actualización de productos desde el formulario, verificar que el stock no haya variado entre la apertura del formulario y el guardado, o separar la actualización de metadatos (nombre, categoría, alarmas) del ajuste directo de existencias.
4. **Idempotencia en Ingresos de Compra y Devoluciones**:
   - Agregar soporte de `client_operation_id` en `POST /api/stock-arrivals` para prevenir ingresos duplicados por reintentos.
   - Validar cantidades enteras positivas en devoluciones (`sale_returns`) y ventas, rechazando `NaN` o números con decimales fraccionarios no autorizados.
5. **Robustez de Respaldos y Entornos**:
   - `createLocalDbSnapshot`: Forzar vaciado de WAL (`wal_checkpoint(PASSIVE)`) y comprobar que el archivo de respaldo contenga las páginas actualizadas.
   - `APP_ENV`: Priorizar estrictamente la configuración del servidor, bloqueando la alteración del entorno mediante cabeceras cliente como `Host` o `X-App-Environment`.
6. **Canal de Voz Administrativo**:
   - Restringir la conexión WebSocket a `/live` exclusivamente al Administrador Principal (`isMainAdmin`), bloqueando tokens con rol subordinado y eliminando la autenticación por parámetro URL en favor del subprotocolo.

---

## 4. Arquitectura Técnica y Estrategia de Datos

```
┌────────────────────────────────────────────────────────────────────────┐
│                   MATRIZ DE CONTROL Y FLUJO DE DATOS                   │
└────────────────────────────────────────────────────────────────────────┘

  [ Cliente React (POS / Terminal) ]
     │
     ├──► POS.tsx: 
     │       • isSubmittingRef (Bloqueo síncrono al clic)
     │       • clientOperationId estable (UUID v4 memoizado por carrito)
     │       • Precios en BOB: getCartItemPriceBs(item, rate)
     │
     ▼ (HTTP / WebSocket)
  [ Servidor Express / WebSocket Gate ]
     │
     ├──► Upgrade Gate: /live -> solo isMainAdmin (Sec-WebSocket-Protocol)
     │
     ├──► Kiosk RBAC Middleware:
     │       • /api/cajas/status (Filtro por seller_id si no es admin)
     │       • /api/accounts-receivable (Guard manage_credits)
     │       • /api/inventory/reconcile-catalog (Guard admin)
     │       • /api/inventory-counts (Guard dueño + estado abierto + enteros)
     │
     └──► Motor Transaccional SQLite (better-sqlite3)
             │
             ├── BEGIN TRANSACTION
             │     ├─ 1. processed_operations (Check hash & op_id -> 409 si difiere)
             │     ├─ 2. Validar Demanda Agregada (sum(qty) <= disponible)
             │     ├─ 3. Insertar Pedido / Venta / Ingreso
             │     ├─ 4. Actualizar Stock / Reservas
             │     └─ 5. Registrar Auditoría Forense
             └── COMMIT (Atómico; si processed_operations falla, revierte)
```

### Componentes y Módulos a Modificar

1. **`server.ts`**:
   - Incorporar guardas de permisos en `/api/cajas/status`, `/api/offline-sales/pending`, `/api/inventory/reconcile-catalog`, `/api/accounts-receivable` y conteos físicos.
   - En `POST /api/pending-sales` y `PUT /api/pending-sales/:id`: deduplicación atómica con `processed_operations`, validación de demanda agregada por producto y forzado de moneda BOB.
   - En `POST /api/stock-arrivals`: registrar `client_operation_id` para evitar dobles recepciones.
   - Validación de cantidades enteras en `sale_returns` y rechazo de `NaN`/infinito en totales y tasas.
   - En `/live`: verificar `isMainAdmin(verifiedUser)` y rechazar tokens en URL.
   - En `createLocalDbSnapshot`: garantizar consistencia WAL antes de confirmar snapshot.
2. **`src/views/POS.tsx`**:
   - Bloqueo síncrono mediante `isSubmittingRef` en la creación de pedidos pendientes.
   - Generación de `clientOperationId` estable por intento de pedido.
   - Uso obligatorio de `getCartItemPriceBs` y envío explícito de `currency: 'BOB'`.
3. **`database.ts`**:
   - Garantizar que la tabla `processed_operations` preserve filas históricas y soporte operaciones de tipo `pending_sale` y `stock_arrival`.

---

## 5. Plan de Verificación y Certificación

1. **Batería de Pruebas Automatizadas de Auditoría**:
   - Ejecutar suite de pruebas de Kiosco (`check_kiosk_v2.cjs` y verificación de escenarios K07, K08, K10, K11, K12, K14, K15, K16, K20, K21).
   - Ejecutar verificación de pedidos y demanda agregada (escenarios E05, E06, E09, N05, N06, V04, V05, V06).
   - Ejecutar pruebas de deduplicación, enteros y tipos de cambio (escenarios E11, E20, E21, E22, N08, N09).
   - Ejecutar suite integral de los 6 puntos (`test_all_six_points.cjs`).
   - Ejecutar suite financiera y de Kárdex (`test_product_history_synthesis.cjs` y `test_financial_history_and_rates.cjs`).
2. **Compilación y Linteo**:
   - `compile_applet` para garantizar cero fallos de Vite y empaquetado.
   - `lint_applet` para asegurar tipado TypeScript estricto.
3. **Verificación de Invariantes**:
   - Confirmar preservación exacta del balance contable y de existencias: Stock físico 220, Libro 220, Caja BOB 3.000.
