# Plan de Implementación: Inicio de Sesión Diario Obligatorio, Cero Caché en Dispositivos y Conectividad Priorizada en Tiempo Real (v2.6.0)

## 1. Diagnóstico y Objetivo Principal
Para garantizar que ningún celular o terminal conserve datos antiguos, sesiones eternas o cachés que alteren el inventario y las ventas, implementaremos una arquitectura **Stateless Client (Cliente Sin Estado Local)** con **Re-autenticación Diaria a Medianoche** y **Canal de Conectividad Priorizado de Alta Velocidad**:

1. **Vencimiento Diario de Sesión a Medianoche (`America/La_Paz`) + Limpieza Profunda Automática**:
   - Cada sesión autenticada registrará la fecha calendario de Bolivia (`YYYY-MM-DD`, ej. `2026-11-02`) tanto en el token del servidor como en el cliente (`gtr_session_date`).
   - Al abrir la aplicación cada nuevo día calendario (o si un dispositivo estuvo guardado días o semanas), el sistema detectará que la fecha de sesión no coincide con el día actual de Bolivia y ejecutará automáticamente una **Limpieza Profunda Total (`performDailyDeepDeviceWipe`)**:
     - Borrado de `localStorage`, `sessionStorage`, todas las bases `IndexedDB` (`gtr_pos_offline_db`, `GTR_POS_APP`, `localforage`) y `window.caches`.
     - Cierre inmediato de sesión y redirección obligatoria a la pantalla de **Iniciar Sesión (Usuario y Contraseña)** conectada en vivo al servidor.

2. **Eliminación Total del Login Optimista y Cachés en Celulares (`LoginScreen.tsx` & `sw.js`)**:
   - En `src/views/LoginScreen.tsx`, se eliminará por completo el **Login Optimista** (`getCachedUserByUsername` y `setUser(optimisticUser)`), que permitía entrar a la interfaz usando perfiles guardados en caché antes de que el servidor respondiera.
   - Ahora el inicio de sesión será **100% en línea contra `/api/auth/login`**: primero limpia cualquier rastro de caché antigua en el celular, valida usuario y contraseña directamente en la base de datos principal y recién entonces abre el sistema con los datos frescos del servidor.
   - En `public/sw.js`, se desactivará el almacenamiento en caché de HTML/JS/CSS (`Network-Only` estricto para navegación y datos, manteniendo únicamente el receptor de notificaciones Web Push), evitando que los celulares sirvan archivos antiguos sin internet.

3. **Conectividad Priorizada de Baja Latencia y Sincronización Instantánea en Vivo**:
   - **WebSocket de Reconexión Rápida y Heartbeat Ligero (`AppContext.tsx` & `server.ts`)**:
     - Reducción del tiempo de reconexión automática de `10s` a `1.5s` con ping/pong cada `8s` y reconexión instantánea al desbloquear la pantalla del celular (`visibilitychange` / `focus` / `online`).
   - **Difusión en Tiempo Real de Cambios de Stock y Ventas (`catalog_updated`)**:
     - Cada vez que se registre una venta, ingreso de mercadería, edición de producto o movimiento de caja en el servidor (`server.ts`), el servidor emitirá una señal inmediata por WebSocket (`type: 'catalog_updated'`) a todos los celulares conectados para que actualicen el stock en pantalla al instante desde la base de datos principal sin esperas ni lentitud.
   - **Protección Estricta de Operaciones de Escritura**:
     - Toda creación/edición de productos, ventas, ingresos o salidas verificará conectividad activa con el servidor principal antes de ejecutarse, impidiendo cualquier movimiento si el dispositivo no está en línea.

---

## 2. Archivos a Modificar

- **`public/version.json` y `src/utils/versionCheck.ts`**:
  - Actualizar versión a **`2.6.0`** para forzar la actualización inmediata y limpieza de todos los celulares al conectarse.
- **`public/sw.js`**:
  - Convertir el Service Worker a modo **`Network-Only` (`v2.6.0-zero-cache`)**: eliminar toda caché de páginas y scripts locales al activarse y pasar todas las peticiones directamente a la red.
- **`src/utils/offlineStorage.ts` y `src/utils/localForageCache.ts`**:
  - Añadir `performDailyDeepDeviceWipe()` para destruir todas las bases IndexedDB (`gtr_pos_offline_db`, `GTR_POS_APP`), `window.caches`, `localStorage` y `sessionStorage` cuando inicia un nuevo día o antes de iniciar sesión.
  - Desactivar el guardado de catálogos o perfiles cacheados en `localForageCache.ts`.
- **`src/views/LoginScreen.tsx`**:
  - Eliminar el login optimista basado en caché; exigir conexión activa a internet, limpiar residuos locales antes de autenticar y validar credenciales estrictamente contra `/api/auth/login` registrando la fecha del día (`gtr_session_date`).
- **`src/context/AppContext.tsx` y `src/App.tsx`**:
  - Verificar al iniciar la app y cada minuto si cambió el día calendario en Bolivia (`America/La_Paz`); si es un nuevo día, ejecutar `performDailyDeepDeviceWipe()` y exigir usuario y contraseña.
  - Priorizar la conectividad en vivo con reconexión rápida de WebSocket (`1.5s`), refresco instantáneo al volver a abrir el celular (`visibilitychange`) y escucha del evento `catalog_updated` para actualizar productos y stock al instante desde el servidor.
- **`server.ts`**:
  - Emitir evento WebSocket `catalog_updated` tras cualquier venta o cambio de inventario para que todos los dispositivos vean el stock exacto de la base de datos principal en tiempo real.
  - Incluir `sessionDate` (fecha actual de Bolivia `YYYY-MM-DD`) en `/api/auth/login` y validar en `/api/auth/me` que la sesión pertenezca al día en curso.
