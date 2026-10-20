# Auditoría y Certificación Final: Parche de Seguridad Crítica & Modo Kiosco V2

Plan integral de verificación, pruebas y certificación para el cierre del parche de seguridad crítica en GTR POS, comprobando punto por punto que los vendedores no puedan acceder a costos, alterar precios, elevar privilegios ni ejecutar operaciones destructivas, manteniendo intacto el flujo comercial y offline.

## User Review & Critical Decisions

> [!IMPORTANT]
> **Puntos Críticos de Validación Confirmados:**
> - **Cero Regresiones Operativas:** Los vendedores pueden buscar productos, calcular totales, emitir comprobantes fiscales/tickets, registrar pagos en Bs/USD y trabajar sin conexión a internet exactamente como antes.
> - **Ocultación Absoluta de Costos:** Respuestas de `/api/products` y exportaciones omiten `price_cost` y márgenes de ganancia para roles no autorizados; la memoria y caché local se purgan al cambiar a sesión de vendedor.
> - **Validación de Precios en Servidor:** `POST /api/sales` valida precios unitarios y descuentos autorizados contra la base de datos antes de registrar transacciones, rechazando manipulaciones indebidas con error 403 y alerta de auditoría.
> - **Aislamiento de Operaciones Administrativas:** Rutas de reinicio, reseteo de turnos, respaldos, sandbox y tasa de cambio exigen verificación estricta de rol `admin` o `propietario`.

## 1. Overview & Core Concept

- **Qué hace:** Ejecuta una auditoría de seguridad integral en servidor y cliente para certificar que todas las vulnerabilidades críticas señaladas en el parche están mitigadas y blindadas, sin interferir con la experiencia del cajero ni con la sincronización local/offline.
- **Audiencia objetivo:** Propietarios de negocio, administradores y personal de caja de GTR POS.
- **Valor clave:** Certeza absoluta de cumplimiento normativo y de seguridad sin interrupción operativa de la tienda en producción.

## 2. User Experience & Visual Design

- **Flujo del Vendedor / Cajero:**
  - Inicia sesión normalmente o desbloquea con su PIN de caja.
  - La interfaz de Punto de Venta (`pos`) muestra productos con sus precios de venta y mayorista oficiales; los campos de costo de adquisición no aparecen en ninguna tabla, modal ni inspección de red.
  - El vendedor no puede salir arbitrariamente a paneles administrativos sin autorización de supervisor (`SupervisorUnlockModal`).
  - Las operaciones de cierre ciego de caja (`cajas`) y conteo físico (`conteo_fisico`) operan fluidamente.

- **Flujo del Administrador / Supervisor:**
  - Dispone de acceso completo a costos, márgenes, configuración de tasas de cambio, auditoría forense e inventario global.
  - Al ingresar su PIN o credenciales en terminales bloqueadas, recibe una sesión temporal de 5 minutos con re-bloqueo automático tras inactividad.

## 3. Key Product Decisions & Trade-Offs

- **Decisión 1: Verificación de Identidad por Token JWT Seguro:**
  - *Enfoque:* El servidor no confía en encabezados manipulables por el cliente (`x-user-role`, `x-user-permissions`). La identidad se deriva exclusivamente del token firmado o de la sesión verificada en SQLite.
  - *Por qué:* Previene ataques de falsificación y suplantación de permisos en llamadas API directas.

- **Decisión 2: Validación Transaccional de Ventas en el Backend:**
  - *Enfoque:* `POST /api/sales` recalcula subtotales y valida precios contra el catálogo registrado antes de asentar inventario y transacciones financieras.
  - *Por qué:* Impide la manipulación de precios desde consolas de desarrollador o clientes modificados.

- **Decisión 3: Purga de Caché de Costos en Cliente sin Borrado de Ventas Offline:**
  - *Enfoque:* Al iniciar sesión como vendedor, se limpian selectivamente las propiedades de costo en memoria y almacenamiento local (`localForageCache`), preservando intacta la cola de ventas offline (`offline_sales_queue`).
  - *Por qué:* Protege la confidencialidad de compras sin poner en riesgo transacciones pendientes por sincronizar.

## 4. Technical Architecture & Data Strategy

```
┌────────────────────────────────────────────────────────┐
│              GTR POS Client Application                │
├──────────────────────────┬─────────────────────────────┤
│      Sesión Admin        │       Sesión Vendedor       │
│  • Visualiza Costos      │  • Costos Purgados          │
│  • Ajustes de Sistema    │  • Bloqueado en POS / Caja  │
│  • Tasa de Cambio        │  • Precios de Venta Fijos   │
└────────────┬─────────────┴──────────────┬──────────────┘
             │                            │
             │   JWT Auth Header          │
             ▼                            ▼
┌────────────────────────────────────────────────────────┐
│             Server Security Middleware                 │
│  • enforcePermission / verifySupervisorToken           │
│  • Sanitización de Costos en /api/products             │
│  • Validación de Precios en POST /api/sales            │
└──────────────────────────┬─────────────────────────────┘
                           │
             ┌─────────────┴─────────────┐
             ▼                           ▼
┌──────────────────────────┐┌────────────────────────────┐
│      SQLite Engine       ││      System Audit Log      │
│  • Catálogo Oficial      ││  • Registro de Intentos    │
│  • Precios & Existencias ││  • Alertas de Precios 403  │
└──────────────────────────┘└────────────────────────────┘
```

- **Plan de Verificación y Pruebas a Ejecutar:**
  1. **Prueba de Exposición de Costos:** Petición no autenticada y con rol cajero a `/api/products` para verificar la ausencia total de `price_cost`.
  2. **Prueba de Elevación de Privilegios:** Intento de modificación de rol a través de `PUT /api/users/:id` por un usuario regular, comprobando el rechazo 403.
  3. **Prueba de Rutas Administrativas:** Verificación de rechazo (401/403) en `/api/admin/reset-database`, `/api/settings/exchange-rate` y respaldos.
  4. **Prueba de Manipulación de Ventas:** Envío de una venta con precio unitario alterado para confirmar el rechazo por parte del servidor.
  5. **Prueba de Regresión Comercial:** Ejecución de venta válida con cálculo de Bs/USD, confirmando que la lógica operativa está 100% preservada.
