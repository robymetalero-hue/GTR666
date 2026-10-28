# Plan de Restauración de Producción y Purga de Registros de Prueba de IA

Restauración íntegra y automática de la base de datos de producción (`gtr_pos.db`) a partir de los datos reales resguardados en Firestore (`ai-studio-remixgtrposaisma-814bb0d3-8e73-41a4-8913-4a6a5d07dc2f`), corrección definitiva del bloqueo de autenticación tras reinicios del contenedor (`Reset app`) y eliminación quirúrgica de todos los registros residuales creados durante las pruebas automatizadas de IA.

## User Review & Critical Decisions

> [!IMPORTANT]
> **Decisiones confirmadas por el usuario en la Fase 1:**
> - **Alcance de Restauración**: Restaurar automáticamente el 100% de los datos reales desde Firestore hacia `gtr_pos.db` (399 ventas reales `#1–#398` + `#424`, 595 líneas de venta, 169 productos, 253 llegadas de stock, usuarios reales, cuentas de caja, liquidaciones, departamentos, configuración e historiales de auditoría).
> - **Purga de Registros de Prueba de IA**: Eliminar definitivamente de Firestore y SQLite los siguientes registros ficticios detectados:
>   1. **12 pedidos pendientes ficticios (`pending_sales` `#1` al `#12`)** y sus **12 ítems (`pending_sale_items`)** a nombre de `"Cliente Deduplicado"` y `"Test Aggregate Edit"` (`Bs. 10`).
>   2. **7 ventas offline ficticias (`offline_pending_sales`)** con prefijo `off_test_*` (`off_test_1793100019585` a `off_test_1793117956520`), conservando únicamente `offline_1792864482494_a8j5eylih` (que originó la venta legítima `#424`).
>   3. **Cuenta de caja ficticia (`cash_accounts` ID `#7`)** perteneciente a `"vendedor_test"` (`seller_id: 7`) y cualquier usuario ficticio `"vendedor_test"` en `users`.
>   4. **Cliente ficticio (`clients` ID `#1`)** a nombre de `"Cliente Prueba Integridad"`.
> - **Continuidad de Ventas Verificada**: Confirmado que las ventas reales llegan hasta la `#398` (26/10/2026) más la `#424` (27/10/2026 por Bs. 610 de `@maria`).

---

## 1. Overview & Core Concept

- **Qué resuelve**:
  1. **Desbloqueo de Hidratación Automática post-Reset**: Cuando el contenedor se reinicia, `gtr_pos.db` requiere hidratarse desde Firestore. Actualmente `ensureServerAuth()` queda sin sesión si no existen variables de entorno manuales y `firestore.rules` rechaza la lectura de colecciones protegidas (`users`, `settings`, `inventory_audit_logs`, `system_audit_logs`), dejando `gtr_pos.db` vacío (`0 ventas`, `0 productos`).
  2. **Limpieza Forense de Residuos de Pruebas en Firestore**: Aunque las ventas de prueba `#399–#423` y `#425–#428` ya fueron retiradas de `sales`, quedaron en Firestore 12 pedidos pendientes de prueba, 7 registros offline `off_test_*`, 1 cuenta de caja `vendedor_test` y 1 cliente `"Cliente Prueba Integridad"`.
  3. **Blindaje de Tombstones y Secuencia (`sqlite_sequence`)**: Registra los tombstones de los registros de prueba purgados en `deleted_records` para impedir que cualquier cliente en caché los reintroduzca, y asegura que el contador de ventas continúe limpiamente a partir del siguiente ID disponible sin bloqueos de trigger.
- **Valor Operativo**: El cajero y el administrador vuelven a ver inmediatamente sus **399 ventas reales, 169 productos con stock real, cajas cuadradas (`@maria` con Bs. 610, `@jenny`, `@admin`, `@roby`) y 0 registros basura de pruebas**, incluso si el servidor se reinicia en el futuro.

---

## 2. User Experience & Visual Design

- **Flujo de Usuario tras la Restauración**:
  1. Al abrir la aplicación, el catálogo muestra los **169 productos reales** con sus existencias actualizadas (incluyendo los ingresos `#239–#257` de `@jenny`).
  2. En **Historial de Ventas** y **Dashboard**, se visualizan las **399 ventas legítimas** (`#1` a `#398` y `#424` de Bs. 610), sin saltos de error ni registros ficticios.
  3. En **Pedidos y Cuentas por Cobrar**, desaparecen los 12 pedidos falsos (`"Cliente Deduplicado"` y `"Test Aggregate Edit"`), quedando la bandeja limpia en `0` pedidos falsos.
  4. En **Cajas y Liquidaciones**, solo aparecen los vendedores reales (`@maria` con saldo actual `Bs. 610.00`, `@jenny`, `@admin`, `@roby`), sin la caja fantasma `@vendedor_test`.
  5. En **Clientes**, desaparece `"Cliente Prueba Integridad"`.

---

## 3. Key Product Decisions & Trade-Offs

- **Decisión 1: Autenticación Determinística del Demonio de Sincronización (`ensureServerAuth` + `firestore.rules`)**
  - *Enfoque Elegido*: Dotar a `ensureServerAuth()` de autenticación automática mediante la cuenta de servicio dedicada del servidor (`sync-daemon@gtrpos.internal`, UID `mPBz9Ze5GVaVC9sCSwnzMv2hCWp1`) cuando no se definan variables externas, y autorizar explícitamente ese UID/email de servicio en `isSyncDaemon()` dentro de `firestore.rules` (exigiendo siempre `hasValidIntegrityEnvelope()` en toda escritura).
  - *Por qué*: Evita que un reinicio de contenedor (`Reset app`) deje al servidor sin permisos para descargar `users`, `settings`, `products` y `sales` desde Firestore, manteniendo bloqueado cualquier acceso anónimo o sin sobre de integridad criptográfica.
- **Decisión 2: Purga Quirúrgica con Tombstones en `deleted_records`**
  - *Enfoque Elegido*: Eliminar los registros ficticios tanto en Firestore como en `gtr_pos.db` e insertar sus IDs en `deleted_records` (`pending_sales` `#1–#12`, `pending_sale_items` `#1–#12`, `offline_pending_sales` `off_test_*`, `cash_accounts` `#7`, `clients` `#1` y `users` `#7` si existiera).
  - *Por qué*: Si algún navegador tenía abierta una pestaña antigua antes de la limpieza, el escudo de `deleted_records` impide que esos registros de prueba vuelvan a sincronizarse hacia la nube.

---

## 4. Technical Architecture & Data Strategy *(Technical Reference)*

### Diagrama de Arquitectura del Proceso de Restauración y Limpieza

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   FIRESTORE (Nube de Producción Real)                       │
│  • sales (399 reales: #1..#398, #424)   • products (169 reales)             │
│  • sale_items (595 reales)              • stock_arrivals (253 reales)       │
│  • cash_movements (401 reales)          • cash_settlements (85 reales)      │
│  • users / settings / departments       • audit_logs (Kárdex y Sistema)     │
└───────────────────┬─────────────────────────────────────┬───────────────────┘
                    │ 1. Purga Quirúrgica Remota          │ 2. Hidratación Completa
                    ▼ (Elimina residuos de pruebas IA)    ▼ (pullFirestoreToLocal)
┌───────────────────────────────────────┐ ┌───────────────────────────────────┐
│   REGISTROS DE PRUEBA ELIMINADOS      │ │   SQLite Local (gtr_pos.db)       │
│  ✕ pending_sales #1..#12              │ │  ✓ 399 Ventas (#1..#398 + #424)   │
│  ✕ pending_sale_items #1..#12         │ │  ✓ 595 Ítems de venta             │
│  ✕ offline_pending_sales off_test_*   │ │  ✓ 169 Productos con stock real   │
│  ✕ cash_accounts #7 (vendedor_test)   │ │  ✓ 253 Entradas de stock          │
│  ✕ users #7 (vendedor_test)           │ │  ✓ Cajas reales (@maria Bs. 610)  │
│  ✕ clients #1 (Cliente Prueba Integ.) │ │  ✓ Secuencia autoincrement segura │
└───────────────────────────────────────┘ └───────────────────────────────────┘
```

### Mapeo de Operaciones y Verificación
1. **Actualización y Despliegue de `firestore.rules`**:
   - Autorizar la identidad del demonio de sincronización del servidor en `isSyncDaemon()` para lectura de las 26 colecciones de `SYNC_TABLES` y escritura validada con `hasValidIntegrityEnvelope()`.
   - Desplegar las reglas actualizadas a Firestore mediante `DeployRules`.
2. **Restauración de `ensureServerAuth()` en `firebaseSync.ts`**:
   - Asegurar que el backend inicie sesión automáticamente con su identidad de sincronización al arrancar el servidor antes de ejecutar `pullFirestoreToLocal(true)`.
3. **Ejecución de Purga de Registros de Prueba en Firestore y Sincronización Completa hacia `gtr_pos.db`**:
   - Eliminar en Firestore:
     - `pending_sales` (`1` al `12`) y `pending_sale_items` asociados.
     - `offline_pending_sales` cuyo ID inicie con `off_test_`.
     - `cash_accounts` doc `7` (`seller_username == 'vendedor_test'`) y cualquier usuario `vendedor_test` en `users`.
     - `clients` doc `1` (`name == 'Cliente Prueba Integridad'`).
   - Registrar los tombstones correspondientes en `deleted_records`.
   - Ejecutar `pullFirestoreToLocal(true)` para hidratar todas las tablas en `gtr_pos.db`, verificar el checkpoint WAL (`wal_checkpoint(TRUNCATE)`) y recalcular `ensureSafeAutoincrementSequence(db)`.
4. **Auditoría Post-Restauración de Solo Lectura**:
   - Comprobar en `gtr_pos.db` y en Firestore que:
     - `sales` = `399` registros exactos (`#1–#398` y `#424`), `0` ventas fantasma.
     - `products` = `169` productos reales.
     - `pending_sales` = `0` pedidos ficticios.
     - `offline_pending_sales` = solo `offline_1792864482494_a8j5eylih` (resuelto en `#424`), `0` registros `off_test_*`.
     - `cash_accounts` = solo cuentas reales (`@maria` = `Bs. 610`, `@jenny` = `0`, `@admin` = `0`, `@roby` = `0`), `0` cuentas `vendedor_test`.
     - `clients` = `0` clientes `"Cliente Prueba Integridad"`.
