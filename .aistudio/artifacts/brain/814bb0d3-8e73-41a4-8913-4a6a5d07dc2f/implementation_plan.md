# Plan de Trabajo: Blindaje de Integridad de Inventario y Erradicación de Unidades Fantasma en Producción

---

## 1. Diagnóstico y Visión General del Problema

El sistema POS opera con un modelo híbrido de alta disponibilidad: **SQLite local autoritativo** (para ventas y conteos de ultra-baja latencia sin depender de internet) y **Google Cloud Firestore** (para persistencia en la nube y replicación multi-dispositivo).

En la auditoría forense de las Sesiones #28 y #29 se identificaron tres fallas críticas de arquitectura:
1. **Escudo de Sincronización Invertido (`firebaseSync.ts` líneas 788–796):** Cuando un producto se vendía en tienda hasta llegar a `stock = 0`, el proceso de sincronización `pullFirestoreToLocal` evaluaba `if (!isNaN(remoteStock) && remoteStock > 0) { data.stock = remoteStock; }`. Esto forzaba incondicionalmente el stock positivo de documentos remotos antiguos sobre el saldo `0` local, resucitando 77 unidades fantasma (ej. 70 piezas de HP Cartón 16 SKU 48, Osmo Mobile SKU 206, Philips 32GB SKU 24, etc.).
2. **Auto-Recuperación Ciega de Respaldo (`database.ts` líneas 67–114):** Si la base de datos local medía menos de 200 KB en el arranque, copiaba automáticamente archivos `.bak` o snapshots pasados, sobreescribiendo catálogos consolidados con datos desactualizados sin autorización administrativa.
3. **Omisión de Sincronización de Ítems de Conteo (`server.ts` línea 8963):** Al cerrar o completar sesiones de inventario, se sincronizaba la cabecera `inventory_counts` pero se omitía `inventory_count_items`, dejando los renglones detallados de conteo únicamente en la memoria local.

---

## 2. Objetivos y Alcance de la Solución

1. **Erradicación Total de Unidades Fantasma:** Purgar de inmediato y de forma permanente las 77 unidades fantasma detectadas en los 6 SKUs identificados (SKUs 48, 206, 122, 47, 24, 118), estableciendo su stock en `0` con marca de tiempo autoritativa sincronizada a Firestore.
2. **Blindaje de Sincronización Local vs Nube (Resolución por Timestamp y Libro Mayor):** Establecer que el libro mayor local (`sales`, `stock_arrivals`, `inventory_audit_logs`) con timestamp reciente siempre prevalezca sobre cualquier documento remoto. Un stock remoto jamás podrá resucitar un stock en `0` que provenga de una venta consolidada.
3. **Prohibición Estricta de Restauraciones de Respaldo No Autorizadas:** Eliminar la copia automática ciega de archivos `.bak` en `ensureProdDbExists()`. Si una base de datos requiere restauración, el sistema entrará en modo seguro de solo lectura y exigirá autorización explícita de un Administrador autenticado.
4. **Persistencia Completa de Sesiones de Conteo en Firestore:** Incluir `inventory_count_items` en `syncAfterWrite` para que los conteos físicos de almacén queden respaldados de manera inmutable en la nube.
5. **Preparación Limpia para el Nuevo Inventario Físico:** Dejar el catálogo 100% saneado para que el nuevo inventario que realizará el equipo arranque sobre números exactos, sin arrastrar faltantes artificiales de la falla de sistema.

---

## 3. Plan de Implementación Paso a Paso

### Fase 1: Blindaje del Motor de Sincronización (`firebaseSync.ts`)
* **Archivo:** `/firebaseSync.ts`
* **Cambio:**
  1. En el bucle de sincronización de `products` de `pullFirestoreToLocal`:
     * Obtener el `updated_at` de SQLite local y el `_tx_timestamp` / `updated_at` del documento de Firestore.
     * Si `localStock === 0` y la fecha local es posterior o igual a la remota, **forzar `data.stock = 0`** e impedir cualquier sobreescritura positiva.
     * Si `localUpdated > remoteUpdated`, **conservar el stock local**.
     * Si el stock en Firestore estuviera desactualizado respecto a una venta local reciente, disparar una actualización de corrección hacia Firestore para que la nube adopte el stock local verificado.
  2. Implementar salvaguarda de ventas agotadas: si en el libro mayor local (`sale_items`) existe una venta que agotó el producto y no hay ningún `stock_arrivals` posterior, el stock se mantiene obligatoriamente en `0`.

### Fase 2: Blindaje de Seguridad en la Base de Datos (`database.ts`)
* **Archivo:** `/database.ts`
* **Cambio:**
  1. Reescribir `ensureProdDbExists()`:
     * Si `gtr_pos.db` no existe o está por debajo del umbral de integridad, **no sobreescribir silenciosamente con `.bak`**.
     * Registrar una alerta crítica de auditoría y registrar el estado.
     * Solo permitir la restauración de un snapshot o `.bak` si es invocado por un endpoint administrativo autenticado con token de `admin` (`/api/system/restore-backup`) con confirmación explícita.
  2. Asegurar que los pragmas de SQLite (`journal_mode = WAL`, `synchronous = NORMAL`, `wal_checkpoint`) garanticen la persistencia inmediata en disco de cada venta y conteo.

### Fase 3: Integración de Conteo e Ítems en `server.ts`
* **Archivo:** `/server.ts`
* **Cambio:**
  1. En el endpoint `PUT /api/inventory-counts/:id/status` (líneas 8960–8970):
     * Actualizar `syncAfterWrite({ inventory_counts: [Number(id)], inventory_count_items: true })` para que tanto la cabecera como el detalle de los productos contados por el operador se sincronicen de inmediato con Firestore.
  2. En el endpoint `PUT /api/inventory-counts/:id/items/:itemId`:
     * Añadir persistencia de seguridad para evitar pérdida de datos si el operador cierra la pestaña a mitad de un conteo físico.

### Fase 4: Script de Saneamiento Productivo (Erradicación de Fantasmas)
* **Archivo:** `/scripts/sanitize_ghost_stocks.ts` (ejecutable una sola vez)
* **Acción:**
  1. Localizar los 6 SKUs identificados con stock fantasma:
     * SKU 48 (`hp carton 16gb`, ID 46): Forzar `stock = 0`.
     * SKU 206 (`Dji osmo mobile 8p activated`, ID 149): Forzar `stock = 0`.
     * SKU 122 (`sd sandisk ultra 64gb`, ID 116): Forzar `stock = 0`.
     * SKU 47 (`hp carton 8gb`, ID 45): Forzar `stock = 0`.
     * SKU 24 (`philips 32gb`, ID 24): Forzar `stock = 0`.
     * SKU 118 (`sd sandisk extreme pro 256gb v90`, ID 112): Forzar `stock = 0`.
  2. Registrar en `inventory_audit_logs` y `system_audit_logs` la nota: `"Saneamiento de sistema: Erradicación de stock fantasma por venta histórica liquidada previa a corte de inventario"`.
  3. Actualizar tanto SQLite local como los documentos correspondientes en Firestore con el timestamp actual de Bolivia (`-04:00`).
  4. Sincronizar el catálogo para que la aplicación móvil, web y puntos de venta reflejen de inmediato existencias reales en 0.

### Fase 5: Resolución Administrativa de la Sesión #29
* La Sesión #29 de María queda cerrada sin imputar pérdidas a la trabajadora:
  * Los falsos faltantes de −77 unidades quedan automáticamente anulados por el saneamiento de sistema.
  * Los sobrantes físicos reales encontrados en tienda (+10 en SKU 8, +2 en SKU 7, +1 en SKU 11, +1 en SKU 40) quedan regularizados para que el nuevo inventario arranque con stock verificado en anaquel.

---

## 4. Análisis de Riesgos y Factores que Podrían Causar Conflictos en el Futuro

| Factor de Riesgo Identificado | Causa Potencial | Medida de Blindaje Implementada en el Plan |
| :--- | :--- | :--- |
| **Ventas concurrentes durante un conteo físico** | Si un cliente compra en mostrador mientras el auditor cuenta el estante, el stock físico puede variar antes de registrarlo. | El sistema utiliza conciliación delta ($S_{\text{final}} = S_{\text{vivo}} + (Q_{\text{físico}} - E_c)$), lo que garantiza que ninguna venta realizada durante la auditoría se pierda o reste dos veces. |
| **Reconexión de dispositivos móviles con datos viejos en caché** | Una tablet o celular que se conecte tras días sin internet podría empujar datos obsoletos. | Se añade el encabezado `Cache-Control: private, no-store, max-age=0` y validación de marcas de tiempo en el middleware de integridad de Firestore. |
| **Ingresos de mercadería registrados sin SKU o mal clasificados** | Crear productos nuevos con stock inicial sin registrar el documento de compra formal en `stock_arrivals`. | Obligatoriedad de validación en creación de producto: todo stock inicial debe generar automáticamente su comprobante en el libro mayor inmutable. |
| **Reinicio de contenedor en Cloud Run con SQLite efímero** | En despliegues contenerizados, si el disco local se reinicia, podría perderse la base si no estuviera replicada. | Sincronización continua de dos vías con verificación criptográfica en `firestore_transaction_ledger`. |

---

## 5. Plan de Verificación y Pruebas

1. **Prueba de Invariante de Ventas:**
   * Registrar una venta simulada de prueba que reduzca un producto a stock `0`.
   * Disparar manualmente `pullFirestoreToLocal()` simulando que Firestore tiene datos con stock positivo.
   * **Criterio de Éxito:** El stock local debe permanecer estrictamente en `0` y Firestore debe actualizarse a `0`.
2. **Prueba de Bloqueo de Backup Silencioso:**
   * Simular base de datos corrupta o de menor tamaño.
   * **Criterio de Éxito:** `ensureProdDbExists()` no debe reemplazar archivos productivos sin orden de administrador.
3. **Verificación de Tipos y Compilación:**
   * Ejecutar `npm run lint` y `compile_applet` para garantizar cero errores de TypeScript y compilación exitosa de React SPA y Node backend.
4. **Auditoría de Saldos en Pantalla:**
   * Verificar en la vista de inventario del POS que los SKUs 48, 206, 122, 47, 24 y 118 aparezcan con existencia `0` exacta y que los productos con existencia real se muestren inalterados.
