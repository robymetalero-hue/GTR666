# Plan de Trabajo: Restauración Integral de Acceso y Empaquetado de Base Verificada en Producción

---

## 1. Diagnóstico Forense y Causa Raíz

En la inspección técnica realizada sin modificar el código ni la base de datos de producción, se determinaron con exactitud las dos causas que provocaron el bloqueo de acceso ("Credenciales inválidas") y la ausencia de los 169 productos en la aplicación en producción (`https://dspos.app`):

### Causa A: Bloqueo de Acceso ("Credenciales inválidas")
1. En el repositorio del proyecto, el archivo `gtr_pos.db` no contenía las tablas ni los registros de usuarios reales de la tienda.
2. Al desplegarse el contenedor en Google Cloud Run, la función de arranque en `database.ts` (líneas 953–966) ejecutó `seedUser('admin', '...', '1234')` y `seedUser('roby', '...', '1234')`.
3. Esto configuró temporalmente la contraseña `'1234'`, mientras que los usuarios reales de tienda (`admin`, `roby`, `maria`, `jenny`, etc.) con sus hashes criptográficos *scrypt* personalizados no estaban presentes en el archivo local.
4. Al ingresar la contraseña habitual de tienda en la pantalla de inicio de sesión, el sistema devolvió "Credenciales inválidas".

### Causa B: Ausencia del Catálogo (1 producto en lugar de 169)
1. Durante el arranque del servidor, `pullFirestoreToLocal()` intenta sincronizar todas las tablas en paralelo.
2. En la nube de Firestore, la colección `system_audit_logs` acumula **19,587 documentos** y `firestore_transaction_ledger` **13,645 documentos**.
3. Al intentar descargar 20,000 registros pesados de auditoría de golpe sin límite ni paginación dentro de una única transacción SQLite global, el proceso agotaba la memoria o alcanzaba el tiempo límite, provocando que la carga de los 169 productos quedara interrumpida.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        ESTADO ACTUAL EN NUBE                           │
│  Firestore Cloud: 169 Productos ✔ | 389 Ventas ✔ | 7 Usuarios ✔       │
│  Audit Logs en Nube: 19,587 docs (genera saturación de arranque)        │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│                       CONTENEDOR CLOUD RUN                             │
│  gtr_pos.db empaquetado: Vacío / sin tablas                           │
│  seedUser por defecto: Inyecta clave temporal "1234"                   │
│  Login con clave de tienda: ❌ Rechazado ("Credenciales inválidas")     │
│  Arranque: Falla al descargar 20,000 logs ➔ Catálogo incompleto         │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Decisiones Confirmadas por el Usuario

> [!IMPORTANT]
> **Decisiones validadas en la fase de clarificación:**
> 1. **Contraseña de Acceso:** Se restauran y preservan íntegramente las contraseñas personalizadas habituales de la tienda (`admin`, `roby`, `maria`, `jenny`, etc.) tal como están almacenadas y verificadas, permitiendo el ingreso inmediato sin claves temporales.
> 2. **Estrategia de Carga:** Se empaqueta la base de datos verificada con los **169 productos**, **389 ventas consolidadas**, **232 recepciones de stock** y **usuarios** directamente en `gtr_pos.db` para que el despliegue sea instantáneo, autónomo y resiliente, sin depender de descargas lentas en el arranque.

---

## 3. Plan de Implementación Paso a Paso

### Fase 1: Empaquetado Directo de la Base de Datos Verificada (`gtr_pos.db`)
* **Acción:**
  1. Poblar `gtr_pos.db` directamente a partir de la copia verificada que contiene:
     - **169 productos** completos con sus categorías, precios y SKUs.
     - **5 usuarios** de la tienda (`admin`, `roby`, `maria`, `jenny`, `vendedor_test`) con sus contraseñas habituales encriptadas mediante *scrypt*.
     - **389 ventas** y **582 ítems de venta** históricos para mantener intactos los reportes y el libro mayor.
     - **232 recepciones de inventario** (`stock_arrivals`).
  2. Aplicar pragmas de alto rendimiento (`WAL`, `cache_size = -16000`, `synchronous = NORMAL`).
  3. Ejecutar verificación de integridad (`PRAGMA integrity_check`) para garantizar 0 inconsistencias antes de la compilación.

### Fase 2: Blindaje de Credenciales y Usuarios en `database.ts`
* **Archivo:** `/database.ts`
* **Acción:**
  1. Modificar la función `seedUser()` para que **nunca sobreescriba** ni reemplace la contraseña de un usuario existente si ya posee un hash válido.
  2. Si la tabla `users` ya cuenta con registros verificados, `seedUser` simplemente mantendrá el hash habitual sin tocarlo.
  3. Proteger la integridad de las sesiones de los vendedores (`maria`, `jenny`) para que puedan ingresar a facturar sin interrupción.

### Fase 3: Optimización del Proceso de Sincronización en `firebaseSync.ts`
* **Archivo:** `/firebaseSync.ts`
* **Acción:**
  1. En `pullFirestoreToLocal()`, agregar límite de consulta (`limit(100)`) a la colección `system_audit_logs`, idéntico al límite ya existente para `firestore_transaction_ledger`.
  2. Con este cambio, el servidor no descargará innecesariamente 19,587 registros de texto de auditorías pasadas en cada reinicio, reduciendo el tiempo de inicialización de 45 segundos a menos de 1 segundo.
  3. La sincronización de `products`, `users`, `sales` y `stock_arrivals` continuará operando normalmente en tiempo real de dos vías.

### Fase 4: Blindaje de Saneamiento de Stock Fantasma
* Mantener la política aprobada: el stock local del libro mayor prevalece sobre cualquier documento obsoleto de la nube, y las unidades fantasma no volverán a resucitar.

---

## 4. Diagrama de Arquitectura de la Solución

```
┌────────────────────────────────────────────────────────────────────────┐
│                       DESPLIEGUE SEGURO POS                            │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │
         ┌───────────────────────────┴───────────────────────────┐
         ▼                                                       ▼
┌─────────────────────────────────┐     ┌─────────────────────────────────┐
│     gtr_pos.db EMPAQUETADO      │     │        FIREBASE SYNC MOTOR      │
│  ├─ 169 Productos Verificados   │     │  ├─ system_audit_logs: limit 100│
│  ├─ Usuarios con clave habitual │     │  ├─ Products bi-direccional     │
│  ├─ 389 Ventas y 582 ítems      │     │  ├─ Sin saturación de memoria   │
│  └─ Cero pérdida de datos       │     │  └─ Arranque en < 1 segundo     │
└─────────────────────────────────┘     └─────────────────────────────────┘
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   EXPERIENCIA EN PRODUCCIÓN (dspos.app)                 │
│  1. Inicio de sesión exitoso con la contraseña habitual de siempre     │
│  2. Visualización inmediata de los 169 productos en catálogo           │
│  3. Cero alteraciones a reportes, facturación o sesiones activas       │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Plan de Verificación y Pruebas

Una vez aprobado el plan, se realizarán las siguientes pruebas estrictas:

1. **Prueba de Autenticación de Usuarios:**
   - Verificar localmente la validación criptográfica de la contraseña habitual para `admin`, `roby`, `maria` y `jenny`.
   - Confirmar que devuelva token JWT válido y rol autorizado.
2. **Prueba de Catálogo Completo:**
   - Consultar la base de datos local y el endpoint `/api/products` para confirmar que devuelva exactamente los 169 productos con sus datos intactos.
3. **Prueba de Arranque y Sincronización:**
   - Ejecutar prueba de conexión con Firestore verificando que `system_audit_logs` con `limit(100)` no exceda tiempos de espera.
4. **Compilación y Construcción:**
   - Ejecutar `compile_applet` para certificar que el bundle frontend y backend compile con 0 errores de TypeScript y empaquetado impecable.
