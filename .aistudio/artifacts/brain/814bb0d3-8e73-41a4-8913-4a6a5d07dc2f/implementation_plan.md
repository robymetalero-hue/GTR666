# Restauración Integral del Historial y Kárdex de Movimientos de Productos

Este plan describe la arquitectura y estrategia de implementación para restaurar por completo la trazabilidad de productos en GTR POS, unificando compras (`stock_arrivals`), ventas en mostrador (`sale_items`), devoluciones (`sale_returns`), ajustes por conteo físico (`inventory_counts`) y creación de catálogo con cálculo dinámico de saldos anteriores y posteriores.

## User Review & Critical Decisions

> [!IMPORTANT]
> Se han incorporado las decisiones confirmadas por el usuario en la fase de clarificación interactiva:

- **Alcance Transaccional**: Reconstrucción integral multi-fuente a partir de todas las tablas vivas (`stock_arrivals`, `sale_items`, `sales`, `sale_returns`, `inventory_counts`, `inventory_count_items`, `inventory_audit_logs`, `system_audit_logs` y `products`). Ningún producto se mostrará vacío o con `(0)` movimientos si tiene inventario o transacciones registradas.
- **Formato del Kárdex**: Kárdex cronológico completo que detalla explícitamente el saldo anterior (`quantity_before`), el cambio neto (`quantity_changed`) y el saldo resultante (`quantity_after`) para cada operación.
- **Seguridad y Permisos de Costo**: Protección estricta de costos unitarios y precios de compra (`price_cost`, `arrival_price`), mostrándolos únicamente a usuarios con rol `admin`/propietario o permiso explícito `view_costs`.

---

## 1. Overview & Core Concept

- **El Problema**: Al abrir la opción **"Ver Historial"** en la pestaña de Stock/Caja (o expandir los detalles de cualquier artículo como el Samsung S26 Ultra SKU 229 del video), el modal mostraba `TODOS (0)` y *"No se encontraron registros de movimiento para este producto"*. Esto ocurría porque el endpoint `/api/products/:id/audit-history` dependía exclusivamente de la tabla auxiliar `inventory_audit_logs`, la cual no contiene registros de productos creados sin bitácora previa o cuya descarga en la sincronización Firestore está restringida.
- **La Solución**: Construir un motor de síntesis de kárdex en `/api/products/:id/audit-history` que consolide de forma fidedigna e inmutable todas las operaciones transaccionales reales registradas en SQLite y Firestore, ordenadas cronológicamente y con cálculo inverso del balance vivo de stock.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                      FUENTES TRANSACCIONALES VIVAS (SQLITE / FIRESTORE)           │
├─────────────────┬──────────────────┬──────────────────┬──────────────────────────┤
│ Compras/Lotes   │ Ventas Mostrador │ Devoluciones     │ Auditorías Físicas       │
│ stock_arrivals  │ sale_items+sales │ sale_returns     │ inventory_counts/items   │
└────────┬────────┴────────┬─────────┴────────┬─────────┴────────────┬─────────────┘
         │                 │                  │                      │
         └─────────────────┼──────────────────┴──────────────────────┘
                           ▼
     ┌───────────────────────────────────────────────────────────────┐
     │  MOTOR DE SÍNTESIS DE KÁRDEX FORENSE (/api/products/:id/audit)│
     │  - Deduplica registros y fusiona referencias de tickets       │
     │  - Reconstruye matemáticamente: Antes -> Delta -> Después     │
     │  - Filtra costos según rol del usuario solicitante            │
     │  - Inyecta evento de Creación Inicial con stock de apertura   │
     └─────────────────────────────┬─────────────────────────────────┘
                                   │
                                   ▼
     ┌───────────────────────────────────────────────────────────────┐
     │       INTERFAZ DE USUARIO: MODAL Y TABLA DE HISTORIAL         │
     │  - Tabs funcionales: Todos | Ingresos | Salidas | Precios     │
     │  - Desglose visual: Fecha, Usuario, Ticket, Diferencial       │
     └───────────────────────────────────────────────────────────────┘
```

---

## 2. User Experience & Visual Design

### Flujo de Usuario
1. El usuario navega a **Stock / Caja** (`Inventory.tsx`).
2. En la ficha de cualquier producto (ej. *Samsung S26 Ultra 512GB*), pulsa **"Ver Historial"** o el icono de reloj/kárdex.
3. Se abre el modal centrado con carga instantánea y datos poblados:
   - **Encabezado y Metadatos**: SKU, Categoría, Stock actual en vivo y Precio de venta con tipografía monoespaciada tabular (`tabular-nums`).
   - **Segmented Filter Tabs**:
     - **Todos ($N$)**: Línea de tiempo completa.
     - **Ingresos ($N_i$)**: Compras de existencias, devoluciones aprobadas, incrementos físicos y stock inicial.
     - **Salidas ($N_s$)**: Ventas en mostrador, mermas y decrementos de conteo.
     - **Precios / Costos ($N_p$)**: Modificaciones históricas de precios de venta y costos de lote.
     - **Cantidades ($N_c$)**: Todos los movimientos que alteraron el número de unidades físicas.
4. Cada tarjeta de movimiento muestra:
   - **Distintivo de Acción**: Icono contextual y etiqueta (ej. *"Venta Realizada"*, *"Compra de Existencias"*, *"Devolución de Cliente"*, *"Creación de Producto"*).
   - **Referencia y Responsable**: Ticket/factura vinculado (ej. `Venta #104`, `Ingreso #12`) y usuario que autorizó el movimiento.
   - **Bloque de Trazabilidad Matemática**: `Antes: X pz → Después: Y pz • Dif: ±Z pz`.
   - **Fecha y Hora**: Formato legible local (Bolivia GMT-4).

### Directrices Visuales (Frontend Design Constitution)
- **Cero Pills Estáticas**: Las insignias de estado y metadatos se presentan sin cápsulas de caramelo, utilizando tipografía limpia, jerarquía nítida y separadores sutiles (`·`).
- **Tabular Figures**: Todos los números, stocks y montos utilizan `font-mono tabular-nums`.
- **Segmented Buttons**: Botones de filtro interactivos con fondo segmentado sobrio y respuesta inmediata ($\le 200\text{ms}$).

---

## 3. Key Product Decisions & Trade-Offs

- **Decisión 1: Síntesis Dinámica vs. Migración de Filas Estáticas**
  - *Enfoque*: El endpoint `/api/products/:id/audit-history` generará la respuesta sintetizando directamente las tablas primarias (`stock_arrivals`, `sale_items`, `sale_returns`, etc.) en lugar de depender únicamente de una tabla de log desnormalizada.
  - *Razón*: Garantiza resiliencia total frente a sincronizaciones parciales de Firestore, importaciones de Excel o purgas de bitácoras. Los movimientos reales jamás se perderán mientras existan las ventas o compras.
- **Decisión 2: Trazabilidad de Stock Inicial en Creación**
  - *Enfoque*: Si un producto fue registrado con stock inicial (ej. 1 unidad) pero no cuenta con un log explícito en `inventory_audit_logs`, el sistema sintetiza un evento `'creacion_producto'` usando la fecha de creación del producto y su stock de apertura.
  - *Razón*: Soluciona exactamente el caso del video, donde un producto recién dado de alta con 1 unidad figuraba con 0 movimientos.
- **Decisión 3: Enmascaramiento de Costos por Rol**
  - *Enfoque*: Si el usuario es un cajero estándar, las propiedades `price` en compras y `price_cost` en cambios de costo se envían como `null` y se ocultan en la interfaz visual.
  - *Razón*: Cumple con las políticas de confidencialidad financiera confirmadas por el usuario.

---

## 4. Technical Architecture & Data Strategy

### Componentes y Rutas Afectadas

1. **`server.ts` (`GET /api/products/:id/audit-history`)**:
   - Reemplazar la consulta exclusiva a `inventory_audit_logs` por una consulta multi-fuente que integre:
     - `stock_arrivals` (entradas por compra).
     - `sale_items` JOIN `sales` JOIN `users` (salidas por venta).
     - `sale_returns` JOIN `sales` (entradas por devolución).
     - `inventory_count_items` JOIN `inventory_counts` (ajustes físicos con diferencia no nula).
     - `inventory_audit_logs` (ajustes manuales deduplicados contra compras/ventas ya procesadas).
     - `system_audit_logs` (cambios de precios y costos).
     - Registro inicial del producto (`products.created_at`, stock inicial).
   - Aplicar el algoritmo de barrido cronológico inverso para calcular consistentemente `quantity_before`, `quantity_after` y `quantity_changed`.
   - Aplicar control de permisos sobre campos financieros según el token verificado (`verifiedUser`).

2. **`firebaseSync.ts`**:
   - Ajustar la sincronización de `inventory_audit_logs` y `system_audit_logs` para ordenar por `created_at` descendente o priorizar la integridad local, asegurando que los registros más recientes estén disponibles.

3. **`src/views/Inventory.tsx`**:
   - Verificar que el modal de historial (`showStockHistoryModal`) y la vista detallada inline (`renderProductHistoryLogs`) consuman de forma idéntica los registros unificados.
   - Refinar los contadores de las pestañas (`Todos`, `Ingresos`, `Salidas`, `Precios/Costos`, `Cantidades`) para mapear con precisión los tipos de eventos sintetizados.

### Plan de Verificación Automatizada

- **Prueba 1**: Producto con compras, ventas y devoluciones refleja todos los movimientos en sus respectivas pestañas.
- **Prueba 2**: Producto recién creado con stock inicial muestra el evento de creación inicial con saldo 0 $\rightarrow$ stock inicial.
- **Prueba 3**: Cajero sin permisos no visualiza costos de compra en el payload ni en la UI.
- **Prueba 4**: Ejecutar suite completa de no-regresión (`txt_critical_fixes_runner.cjs`, `audit_cycle_runner.cjs`, `verify_pre_production_readiness.cjs`).
- **Prueba 5**: `compile_applet` y `lint_applet` al 100% limpios.
