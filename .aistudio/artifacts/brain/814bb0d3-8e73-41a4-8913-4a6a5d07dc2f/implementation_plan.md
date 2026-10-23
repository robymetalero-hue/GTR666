# Plan de Implementación: Restauración de Base de Datos de Producción y Acceso en dspos.app

Restablecer el entorno de producción (`dspos.app`), recuperar la base de datos activa `gtr_pos.db` con los 156 productos y usuarios existentes a partir del respaldo maestro `gtr_pos.db.bak`, asegurar la detección confiable de `dspos.app` y sincronizar con Firestore sin alterar las credenciales del usuario `admin`.

---

## 1. Revisión de Diagnóstico

1. **Causa de productos vacíos (0 productos) y error de credenciales**:
   - En el servidor, el archivo `gtr_pos.db` (base de datos SQLite de producción) no existía físicamente en el disco.
   - El respaldo completo `gtr_pos.db.bak` (7.7 MB) contiene intactos los 156 productos, todos los clientes, ventas y los 5 usuarios del sistema (`admin`, `roby`, `maria`, `jenny`, `vendedor_test`).
   - Al faltar `gtr_pos.db`, las llamadas dirigidas a producción inicializaban un archivo SQLite en blanco, resultando en 0 productos y credenciales inválidas para `admin`.

2. **Detección de entorno**:
   - En peticiones dirigidas a `dspos.app`, el servidor debe enrutar inequívocamente a producción (`gtr_pos.db` y colecciones principales de Firestore), reconociendo tanto la variable `APP_ENV=production` como el dominio de producción `dspos.app`.

---

## 2. Cambios Propuestos

### Módulo de Base de Datos (`database.ts`)
- **Restauración y Salvaguarda Automática**:
  - Copiar y restaurar inmediatamente `gtr_pos.db` a partir de `gtr_pos.db.bak` (7.7 MB).
  - En `getProdDb()`, implementar un mecanismo de auto-recuperación seguro: si `gtr_pos.db` no existe o tiene un tamaño inferior al umbral mínimo, restaurarlo automáticamente desde el respaldo de seguridad más reciente (`gtr_pos.db.bak` o `snapshot_*`) antes de conectar, previniendo que producción quede en blanco.
  - Asegurar la ejecución de pragmas SQLite de alto rendimiento (`journal_mode = WAL`, `synchronous = NORMAL`).

### Módulo de Servidor y Detección de Dominio (`server.ts`)
- **Resolución de Entorno Confiable**:
  - En el middleware de selección de entorno, evaluar:
    1. Si `process.env.APP_ENV === 'production'`, el entorno es **producción**.
    2. Si el encabezado `Host` o `x-forwarded-host` corresponde a `dspos.app` (o subdominios de producción), asignar entorno **producción** (`isSandbox = false`).
    3. Si `process.env.APP_ENV === 'sandbox'` o dominios de desarrollo (`ais-dev-*`), asignar **sandbox** (`isSandbox = true`).
  - Garantizar que las solicitudes a `dspos.app` operen sobre `gtr_pos.db` y las colecciones de Firestore `users`, `products`, `sales`, etc.

### Sincronización con Firestore (`firebaseSync.ts`)
- Ejecutar verificación de integridad y sincronización de los 156 productos y cuentas de usuario en las colecciones de producción de Firestore.
- Asegurar que la colección `products` mantenga la correspondencia 1:1 con `gtr_pos.db`.

### Autenticación y Acceso
- Mantener intacto el hash de contraseña existente para el usuario `admin`.
- Probar la validación de inicio de sesión con `admin` sobre la base de producción recuperada.

---

## 3. Plan de Verificación

### Pruebas Automatizadas
1. **Verificación de Base de Datos de Producción**:
   - Ejecutar script Node.js para consultar `gtr_pos.db`:
     - Confirmar que la tabla `products` contiene 156 productos con precios, stock y categorías.
     - Confirmar que la tabla `users` contiene a `admin`, `roby`, `maria` y `jenny`.
2. **Prueba de Middleware de Dominio**:
   - Realizar petición HTTP simulando `Host: dspos.app` y verificar que el encabezado de respuesta `X-App-Environment` retorne `production`.
3. **Prueba de Endpoint `/api/products` en Producción**:
   - Realizar llamada HTTP a `/api/products` bajo el entorno de producción y confirmar que retorna la lista completa de productos.
4. **Compilación de la Aplicación**:
   - Ejecutar `compile_applet` para validar que el servidor y cliente compilan sin errores.
