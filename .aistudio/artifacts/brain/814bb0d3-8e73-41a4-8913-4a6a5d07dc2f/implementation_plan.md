# Plan de Intervención: Remediación de Contaminación y Aislamiento Estricto de Entornos (GTR666)

Plan de remediación y blindaje de arquitectura para corregir la contaminación de registros de prueba generados desde la venta #399 en adelante, garantizando la preservación matemática intacta de la venta legítima #398 (Bs 2.150, @maria) y ventas históricas, con aislamiento hermético entre entornos para impedir cualquier recurrencia futura.

---

### Decisiones de la Consulta y Confirmaciones de Usuario

> [!IMPORTANT]
> A partir de las aclaraciones del usuario en la Fase 1, se han fijado las siguientes directrices operativas:
> - **Estrategia de Ejecución**: Ejecutar la limpieza atómica y el aislamiento de entornos directamente con respaldo previo íntegro y verificado (sin frenar la operación en esperas intermedias).
> - **Blindaje de Pruebas**: Bloquear de forma estricta (`fail-closed`) la ejecución de cualquier runner o script de prueba contra bases o servicios de producción, forzando el uso exclusivo de bases SQLite temporales y entornos aislados.
> - **Sincronización con Firestore**: Purgar físicamente los documentos remotos de prueba e insertar marcadores duraderos de invalidación (`tombstones`) para impedir que sincronizaciones posteriores resuciten registros eliminados.

---

## 1. Visión General y Alcance del Incidente

### 1.1 Causa Raíz Identificada
1. **Fallback Silencioso a Producción**: `server.ts:2` define `process.env.APP_ENV = process.env.APP_ENV || 'production'`, haciendo que cualquier proceso donde `APP_ENV` no esté explícitamente configurado se ejecute con privilegios y rutas comerciales.
2. **Preferencia Insegura en Runners de Pruebas**: Scripts como `tests/test_all_six_points.cjs`, `tests/test_product_history_synthesis.cjs` y `tests/test_audit_c227fa0_fixes.cjs` utilizaban `fs.existsSync('./gtr_pos.db') ? './gtr_pos.db' : './gtr_pos_sandbox.db'`, conectándose directamente a la base de datos viva y emitiendo `POST /api/sales` sin cabeceras de sandbox.
3. **Efectos en Cascada**: Cada venta de prueba ejecutada contra la API viva impactó stock (`products.stock`), caja (`cash_movements` y `cash_accounts`), auditoría y colas de sincronización hacia Firestore.

### 1.2 Límites Estrictos de la Intervención
- **Frontera de Preservación Inviolable**: La venta **#398** (Bs 2.150, efectivo, 40 ítems, usuario `@maria`), así como todas las ventas legítimas anteriores (#1 a #398), quedan **100% intactas y protegidas**.
- **Prohibición de Borrados Ciegos**: Queda terminantemente prohibido ejecutar sentencias tipo `DELETE FROM sales WHERE id >= 399` o búsquedas por comodín `LIKE '%399%'`.
- **Prohibición de Resets Globales**: No se utilizará `/api/admin/reset-database` ni `clearAllFirestoreAndLocalData`. La intervención se ejecuta exclusivamente sobre la lista cerrada de IDs de prueba identificados.

---

## 2. Experiencia de Usuario, Auditoría y Transparencia

Aunque la mayor parte de la intervención es a nivel de base de datos y middleware de servidor, el sistema de información debe reflejar la salud y seguridad de los datos:

1. **Aislamiento Visual de Entornos en Shell y Encabezado**:
   - En entornos locales o de desarrollo sin credenciales comerciales explícitas, el banner de modo `SANDBOX / AISLADO` se mantendrá activo y visible sin ambigüedades.
   - En producción comercial (`dspos.app`), el indicador permanece limpio y protegido contra cualquier spoofing de cabeceras (`x-app-environment`).
2. **Trazabilidad en Kárdex y Módulo de Auditoría**:
   - Las ventas de prueba retiradas dejarán de figurar como transacciones operativas en el historial de ventas, cortes de caja y balances contables.
   - Se conservará un registro administrativo formal en `system_audit_logs` que documentará la intervención técnica con ID de incidente, fecha, usuario responsable y delta corregido, garantizando que el Kárdex forense cuadre exactamente con el stock físico.

---

## 3. Decisiones de Producto y Arquitectura

### 3.1 Aislamiento "Fail-Closed" en Servidor y Base de Datos
- **Enfoque Seleccionado**: Modificar `server.ts` y `database.ts` para que, en ausencia de `APP_ENV`, el servidor **falle de manera cerrada** (`fail-closed`) o asuma `development/sandbox` en entornos locales/preview, requiriendo una asignación deliberada para acceder al almacenamiento de producción.
- **Justificación**: Elimina de raíz la posibilidad de que un desarrollador o agente de IA arranque un script o proceso sin parámetros y contamine la tienda real.

### 3.2 Barrera de Contención en Scripts de Prueba (`tests/*.cjs`)
- **Enfoque Seleccionado**: Refactorizar todos los scripts de prueba en `tests/` para que:
  1. Verifiquen al inicio `process.env.APP_ENV === 'test'`. Si no está configurado, o si apunta a producción, el runner aborta inmediatamente con código de salida 1.
  2. Prohíban terminantemente abrir `./gtr_pos.db`. Cada suite usará una base de datos temporal efímera (ej. `./gtr_pos_test_runner.db` o memoria SQLite) que se inicializa y destruye en cada ciclo.
  3. No envíen solicitudes mutantes (`POST`, `PUT`, `DELETE`) hacia puertos o dominios productivos.

### 3.3 Restitución Matemática de Inventario
- **Fórmula de Corrección**: Por cada producto afectado por una venta de prueba, la restitución neta es:
  $$\Delta \text{Stock} = \sum (\text{Unidades vendidas en prueba}) - \sum (\text{Unidades ya devueltas en prueba})$$
- Si una prueba no alteró el stock o si existió un conteo físico posterior que absorbió la discrepancia, se respeta la realidad física sin generar "unidades fantasma".

### 3.4 Conciliación de Caja y Cuentas por Cobrar
- Revertir únicamente los movimientos reales en `cash_movements` vinculados a las ventas de prueba seleccionadas.
- Si una venta se insertó directamente sin movimiento de caja, no se deducen saldos a ciegas.
- Si existió un arqueo o liquidación mixta, se conserva la evidencia física de entrega y se ajusta la trazabilidad del cálculo sin alterar montos físicos entregados.

---

## 4. Arquitectura Técnica y Estrategia de Datos

### 4.1 Diagrama de Aislamiento y Flujo de Intervención

```
┌────────────────────────────────────────────────────────────────────────┐
│                        ARQUITECTURA DE AISLAMIENTO                     │
└────────────────────────────────────────────────────────────────────────┘

    [ Tests Automatizados / Agentes ]          [ Tráfico Comercial / Usuarios ]
                    │                                         │
                    ▼                                         ▼
         APP_ENV === 'test'                        APP_ENV === 'production'
                    │                                         │
       ┌────────────┴────────────┐               ┌────────────┴────────────┐
       │   Guarda Fail-Closed    │               │  Validación Host/Secret │
       │  Rechaza gtr_pos.db     │               │    Base de Datos Real   │
       └────────────┬────────────┘               └────────────┬────────────┘
                    │                                         │
                    ▼                                         ▼
       [ gtr_pos_test_tmp.db ]                         [ gtr_pos.db ]
          (Base Efímera)                           (Producción Blindada)
                                                              │
                                                              ▼
                                                   [ Transacción de Limpieza ]
                                                   1. Backup SQLite & WAL
                                                   2. Snapshot de IDs >= 399
                                                   3. Reversa Inventario & Caja
                                                   4. Cuarentena & Borrado
                                                   5. Purga Firestore + Tombstones
```

### 4.2 Fases del Procedimiento de Remediación

#### Fase 1: Respaldo Coherente y Snapshot Inmutable
1. Detener escritores y sincronizadores en segundo plano.
2. Crear copia de seguridad completa y verificable de `gtr_pos.db`, `gtr_pos.db-wal` y `gtr_pos.db-shm` en una ruta privada fuera del alcance web (`backups/incident_399_pre_clean_<timestamp>.db`).
3. Comprobar integridad de la copia mediante `sqlite3` y verificar que la venta #398 y sus 40 ítems se encuentren íntegros.
4. Generar el manifiesto con los IDs exactos de ventas de prueba (desde #399 hasta el máximo actual observado) con sus hashes y dependencias.

#### Fase 2: Transacción Atómica de Limpieza en SQLite
Dentro de un único bloque de transacción SQLite (`BEGIN IMMEDIATE`):
1. **Verificación de Invariante**: Comprobar que `sales WHERE id = 398` existe, tiene `total = 2150` y usuario `@maria`. Si falla, abortar con `ROLLBACK`.
2. **Archivo a Cuarentena**: Guardar las filas seleccionadas de `sales`, `sale_items`, `cash_movements`, `accounts_receivable`, etc., en una tabla privada de auditoría (`incident_quarantine_records`).
3. **Ajuste de Inventario**: Aplicar las restituciones exactas calculadas producto por producto.
4. **Ajuste de Caja**: Revertir los movimientos de efectivo comprobados de dichas ventas en `cash_accounts`.
5. **Retiro de Dependencias**: Eliminar ordenadamente de:
   - `sale_items` (por `sale_id IN (...)`)
   - `sale_returns` (por `sale_id IN (...)`)
   - `cash_movements` (por `sale_id IN (...)`)
   - `accounts_receivable` y `credit_payments`
   - `processed_operations` (marcando las claves como inválidas para evitar reintentos offline)
   - `sales` (por los IDs explícitos de la lista)
6. **Marcadores de Eliminación**: Registrar en `deleted_records` para que la sincronización identifique el retiro.
7. **Commit**: Consolidar la transacción de forma indivisible.

#### Fase 3: Purga Remota en Firestore y Prevención de Resurrección
1. Consultar en la colección `sales` de Firestore los documentos correspondientes a los IDs eliminados.
2. Ejecutar borrado remoto (`deleteDoc`) en batch de:
   - `sales/{saleId}`
   - `sale_items` vinculados
   - `cash_movements` vinculados
3. Actualizar en Firestore los documentos de `products` con el stock corregido.
4. Insertar documentos de control de invalidación (`tombstones`) para impedir que clientes offline sincronicen y resuciten estas ventas de prueba.

#### Fase 4: Blindaje Permanente del Código Fuente
1. **`server.ts`**: Corregir la resolución predeterminada de `APP_ENV` para que nunca asuma silenciosamente producción en entornos de desarrollo o pruebas.
2. **`database.ts`**: Bloquear el acceso a `prodDbPath` si el contexto detectado es de prueba o runner automatizado.
3. **`tests/*.cjs`**: Actualizar todos los scripts de prueba para requerir `APP_ENV=test`, usar bases temporales y rechazar conexiones contra bases comerciales.

---

## 5. Matriz de Verificación y Escenarios de Aceptación (01 - 30)

Una vez ejecutada la intervención, se validarán punto por punto los 30 escenarios estipulados en la instrucción oficial:

| Escenario | Criterio de Aceptación | Método de Verificación |
|---|---|---|
| **01** | #398 conserva exactamente total, moneda, usuario, fecha y líneas | Consulta SELECT explícita y hash SHA-256 de fila y líneas |
| **02** | Ventas reales anteriores a #399 intactas | Recuento e integridad referencial de #1 a #398 |
| **03** | IDs de prueba no aparecen en historial comercial | Búsqueda en API `/api/sales` e historial |
| **04** | Ventas legítimas posteriores preservadas | Verificación de cualquier venta real posterior al corte |
| **05 - 09** | Restitución exacta de stock sin duplicidades ni ítems fantasmas | Comparación Kárdex vs `products.stock` antes y después |
| **10 - 12** | Saldos de caja y tasas históricas cuadradas | Conciliación de `cash_accounts` y `cash_movements` |
| **13 - 14** | Cero créditos, abonos o puntos huérfanos | Verificación de integridad en `accounts_receivable` |
| **15** | Kárdex forense coincide con stock físico | Ejecución de `forensicAuditEngine.ts` |
| **16** | Idempotencia: reejecución no duplica corrección | Prueba de corrida secundaria de la intervención |
| **17 - 18** | Manejo de fallos y no falsos positivos | Verificación de rollback y visibilidad de estado |
| **19 - 22** | Sincronización no resucita registros ni en reinicios | Prueba de ciclo pull/push y reinicio de servidor |
| **23 - 25** | Runners no abren producción ni escriben en Firestore real | Ejecución de suite de pruebas con guardas activas |
| **26 - 30** | Reportes, permisos y respaldos íntegros y operativos | Validación de reportes POS, login de cajero y test de backup |
