# Plan de Implementación: Blindaje de Seguridad, Kiosco y Precisión Transaccional GTR666

Plan integral para aplicar las correcciones del informe `GTR666_kiosco_revision_y_parche_20261026_16de2010.txt` garantizando la protección estricta del inventario, la conciliación matemática de caja y stock, y la integridad de los registros comerciales históricos.

## Decisiones Críticas y Confirmaciones del Usuario

> [!IMPORTANT]
> A continuación se resumen las decisiones estratégicas confirmadas para la ejecución de este parche:

- **Canal de Voz en Tiempo Real y Herramientas SQL (`/live`)**:
  - *Decisión confirmada*: **Reservar el asistente de voz administrativo con ejecución de SQL y herramientas de sistema exclusivamente al Propietario / Administrador Principal**.
  - Los cajeros conservarán acceso autenticado a las alertas del sistema (`/alerts`) y a la operativa del terminal sin riesgo de fuga de datos ni escalamiento de privilegios.
- **Ventas y Acciones Offline en Cola Local**:
  - *Decisión confirmada*: **Permitir que el cajero en turno sincronice las ventas y pedidos pendientes del terminal**.
  - Se añadirá el identificador de operador (`ownerUserId`) para trazabilidad de autoría en auditoría, pero no se bloqueará la sincronización operativa de tickets legítimos pendientes generados durante contingencias de red.
- **Idempotencia y Reutilización de Clave de Operación (`client_operation_id`)**:
  - *Decisión confirmada*: **Rechazo estricto con HTTP 409 Conflicto y registro en log de auditoría**.
  - Si un reintento llega con la misma clave de operación pero un contenido o payload modificado, el sistema protegerá la transacción original y alertará de discrepancia para evitar dobles deducciones o adulteración de tickets.

---

## 1. Alcance y Concepto Central

- **Propósito**: Resolver de manera definitiva los 52 escenarios auditados de seguridad, integración, límites de API y WebSockets sin provocar regresiones en las ventas, recepciones, devoluciones, arqueos de caja ni en la síntesis forense del historial de productos (Kárdex).
- **Usuarios Destinatarios**: 
  - *Cajero / Vendedor*: Terminal ágil, protegido contra operaciones cruzadas de otros turnos, sin exposición de costos de compra ni accesos administrativos no autorizados.
  - *Administrador / Dueño*: Control total, supervisión de auditoría forense inalterable, acceso exclusivo a herramientas de voz con ejecución SQL y gestión de crédito/catálogo.
- **Principio de No Regresión**: Conservar intacta la base de datos comercial (`gtr_pos_sandbox.db` y `gtr_pos.db`), respetando los 500 registros de control de balance de caja y stock.

---

## 2. Experiencia de Usuario y Flujos Operativos

```
┌────────────────────────────────────────────────────────────────────────┐
│                        FLUJO OPERATIVO KIOSCO POS                      │
└────────────────────────────────────────────────────────────────────────┘

  [ Cajero en Terminal ]
         │
         ├──► 1. Inicio de Turno y Apertura de Caja (Auditoría vinculada al ID de sesión)
         │
         ├──► 2. Venta / Devolución / Pedido
         │       • Validación atómica de stock agregado por producto (E06)
         │       • Autoría ligada al operador activo de la sesión (K05/K13)
         │       • Sin exposición de costos en cierres ni catálogos (K12/E07)
         │
         ├──► 3. Contingencia Offline
         │       • Cola local en IndexedDB con 'ownerUserId' y clave UUID estable
         │       • Sincronización continua sin corte prematuro de promesa (E08)
         │       • Cajero puede enviar pedidos del equipo sin perder continuidad
         │
         └──► 4. Cierre y Arqueo
                 • Solo visualiza su propia caja y liquidación (K09/K10)
                 • Costos unitarios ocultos a perfiles sin permiso financiero

  [ Administrador / Propietario ]
         │
         ├──► Asistente de Voz /live (Autenticación JWT en subprotocolo WebSocket)
         ├──► Auditoría Forense y Kárdex Multifuente de Productos
         └──► Conciliación Global de Catálogo y Autorización de Conteos
```

- **Retroalimentación en Interfaz**:
  - Mensajes de error contextuales claros ante conflictos (HTTP 409: *"La transacción ya fue procesada con un contenido previo"*).
  - Bloqueo visual e inhabilitación inmediata del botón de cobro durante el vuelo de la solicitud para impedir dobles clics y reintentos desfasados.
  - Ocultamiento sistemático de campos de costo unitario para roles no administrativos en recibos, modales de kárdex y cierres de turno.

---

## 3. Decisiones de Producto y Arquitectura

1. **Autenticación Robusta en WebSockets (`server.on('upgrade')`)**:
   - *Enfoque*: Extraer y validar el JWT a través del subprotocolo `Sec-WebSocket-Protocol` (`['access_token', token]`).
   - *Por qué*: Evita exponer credenciales en la URL de conexión (que pueden ser registradas en logs HTTP o proxies) y bloquea conexiones anónimas a `/live` y `/alerts`.
2. **Autoría Comercial Vinculada a la Sesión (`verifiedUser.id`)**:
   - *Enfoque*: En `POST /api/sales` y `POST /api/pending-sales`, para cajeros y vendedores el sistema asigna forzosamente `sale.user_id = verifiedUser.id`. Solo administradores pueden asignar ventas a terceros.
   - *Por qué*: Previene suplantación de identidad en comisiones, balances de arqueo y trazabilidad forense.
3. **Manejo de Transacciones y Fallas de Deduplicación**:
   - *Enfoque*: El registro de la operación en `processed_operations` se ejecuta dentro de la misma transacción SQLite que la venta y la deducción de inventario. Si la inserción de deduplicación falla, toda la transacción revierte.
   - *Por qué*: Garantiza que no existan ventas "huérfanas" sin evidencia de deduplicación ni inconsistencias por transacciones a medio completar.
4. **Validación de Inventario Agregado en Pedidos**:
   - *Enfoque*: Si un pedido incluye el mismo producto en múltiples líneas (ej. 6 unidades y 6 unidades cuando el stock físico es 10), se consolida la demanda total (12 unidades) antes de evaluar disponibilidad.
   - *Por qué*: Previene sobreventas por evaluación fraccionada línea por línea.
5. **Rate Limiting en Verificación de Supervisores**:
   - *Enfoque*: Limitar a 5 intentos fallidos cada 15 minutos en `/api/auth/verify-supervisor` sin penalizar verificaciones exitosas.
   - *Por qué*: Protege contra ataques de fuerza bruta al PIN de supervisor en el terminal POS.

---

## 4. Arquitectura Técnica y Estrategia de Datos

```
┌────────────────────────────────────────────────────────────────────────┐
│                   ARQUITECTURA DE INTEGRACIÓN Y PARCHE                 │
└────────────────────────────────────────────────────────────────────────┘

 [ Cliente React / PWA ]
   ├── AudioVoice.tsx ──────────► [Sec-WebSocket-Protocol: token] ──┐
   ├── AppContext.tsx (Alerts) ─► [Sec-WebSocket-Protocol: token] ──┤
   ├── offlineStorage.ts ───────► { id, ownerUserId, payloadHash }  │
   └── POS.tsx ─────────────────► POST /api/sales & /pending-sales  │
                                                                   ▼
 [ Backend Express / WebSocket Server ]                     [ Upgrade Handler ]
   ├── Token / Role Gate ◄───────────────────────────────── Validar JWT & Role
   │     ├─ /live: Solo Admin/Owner                                │
   │     └─ /alerts: Todos los usuarios válidos                    │
   │                                                               │
   ├── API Endpoints Hardening                                     │
   │     ├─ POST /api/sales: Forzar verifiedUser.id                │
   │     ├─ POST /api/pending-sales: Guard create_pending_sales    │
   │     ├─ GET /api/sales/:id: Guard de pertenencia/admin         │
   │     ├─ POST /api/inventory/reconcile-catalog: Solo Admin      │
   │     ├─ GET /api/cash-register/closures: Ocultar costos        │
   │     └─ PUT /api/inventory/counts/:id: Bloqueo de conteos cer. │
   │                                                               │
   └── Motor SQLite Transaccional (gtr_pos_sandbox.db & gtr_pos.db)│
         ├─ processed_operations (client_operation_id + payload_hash)
         ├─ sales & sale_items
         ├─ stock_arrivals & inventory_counts
         └─ audit_logs (registro de 409 y autoría)
```

### Componentes y Archivos Afectados

1. **`server.ts`**:
   - Implementar verificación de tokens en `server.on('upgrade')` para `/live` (con restricción a administrador/owner) y `/alerts`.
   - Modificar clientes internos de voz para evitar llamadas sin sesión.
   - Imponer autoría obligatoria del operador en `POST /api/sales` y pedidos.
   - Enriquecer validaciones de idempotencia (detección de discrepancia de hash con respuesta 409).
   - Bloquear manipulación de conteos físicos ya aprobados o cerrados.
   - Aplicar rate limit estricto a `/api/auth/verify-supervisor`.
2. **`firebaseSync.ts`**:
   - Proteger productos locales contra sobreescritura accidental por colisión de SKU con IDs remotos divergentes.
3. **`src/context/AppContext.tsx`**:
   - Ajustar `syncRunningRef` para liberarse exclusivamente en el bloque `finally` de la sincronización asíncrona.
   - Transmitir credenciales mediante subprotocolo seguro en la conexión de alertas.
4. **`src/utils/offlineStorage.ts`**:
   - Añadir `ownerUserId` a las acciones generadas en cola offline.
5. **`src/views/POS.tsx`**:
   - Asegurar generación de claves estables de operación y consolidación de montos/cantidades válidas antes del envío.
6. **`src/components/AudioVoice.tsx`**:
   - Ajustar el handshake de conexión WebSocket para enviar el token JWT por subprotocolo sin parámetros en URL.

---

## 5. Plan de Verificación y Certificación

1. **Compilación y Linteo**:
   - Ejecutar `compile_applet` para garantizar cero errores en Vite/TypeScript.
   - Ejecutar `lint_applet` para validar consistencia de sintaxis e importaciones.
2. **Batería de Pruebas de Regresión**:
   - Ejecutar `tests/test_product_history_synthesis.cjs` (verificar que el kárdex y el historial multifuente permanezcan al 100%).
   - Ejecutar `tests/txt_critical_fixes_runner.cjs` (verificar los 24 casos críticos de base de datos y caja).
   - Ejecutar `tests/audit_cycle_runner.cjs` (verificar los 27 casos de auditoría).
   - Ejecutar `scripts/verify_pre_production_readiness.cjs` (validación de preparación para entrega).
3. **Verificación de Invariantes Financieros y de Stock**:
   - Confirmar que los 500 movimientos comerciales de referencia sigan cuadrando: Stock 220, Libro 220, Caja BOB 3.000.
