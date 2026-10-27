# Plan de Blindaje Integral del Modo Kiosco (Integración Quirúrgica y Cero Conflictos)

## 1. Principio Rector: Integración Limpia y No Destructiva
Todos los ajustes se aplicarán mediante **cambios puntuales y quirúrgicos** sobre los componentes, estados y rutas que ya existen en la aplicación web actual, garantizando:
- **Cero conflictos con el uso normal**: Cuando el Modo Kiosco esté desactivado (o cuando un Supervisor desbloquee temporalmente la terminal), la aplicación funcionará exactamente igual que hoy, sin pasos adicionales ni cambios en la experiencia de usuario para el Administrador/Propietario.
- **Reutilización de componentes existentes**: Se aprovecharán el `SupervisorUnlockModal`, los endpoints `/api/settings/kiosk` y `/api/auth/verify-supervisor`, y el estado `offlineQueue` ya presentes en el código, sin introducir librerías nuevas, migraciones destructivas de base de datos ni cambios de estructura.
- **Compatibilidad total de API**: Los parámetros adicionales en `/api/sales` serán opcionales y retrocompatibles para no afectar reportes, analíticas ni exportaciones existentes.

---

## 2. Ajustes Quirúrgicos por Módulo

### A. Persistencia del Modo Kiosco y Login Seguro (Sin alterar sesiones actuales)
1. **Sincronización Ligera con `/api/settings/kiosk` (`AppContext.tsx` y `ConfiguracionesView.tsx`)**:
   - Aprovechar el endpoint `/api/settings/kiosk` que **ya existe** en `server.ts`.
   - Al cargar `AppContext`, sincronizar `kioskMode` con `/api/settings/kiosk` de forma silenciosa (con fallback inmediato a `localStorage` si no hay red) para que recargar con `F5` respete siempre la configuración del servidor.
2. **Permisos Iniciales Seguros en Login (`LoginScreen.tsx`)**:
   - En el estado optimista de inicio de sesión para usuarios que no son `admin`, inicializar permisos básicos de cajero hasta que responda la validación de `/api/login` (que toma milisegundos), sin cambiar la pantalla de login ni las cuentas configuradas.

### B. Aislamiento de Ventas y Caja en Modo Kiosco (Sin tocar vistas de Admin)
1. **Historial de Ventas del Turno Actual (`ExtraViews.tsx`)**:
   - Únicamente cuando `isKioskLocked` sea `true` (Modo Kiosco activo y sin desbloqueo de Supervisor):
     - Filtrar automáticamente la lista de ventas por el cajero actual (`user.username` / `user.id`) y fecha del día/turno en curso.
     - Ocultar visualmente las tarjetas de totales globales de la tienda y el selector de otros cajeros, conservando intactos el buscador de tickets, vista de detalle, reimpresión PDF y envío por WhatsApp.
2. **Vista de Cajas (`CajasView.tsx`)**:
   - Si `isKioskLocked` es `true`, mostrar la vista individual de caja del operador actual en lugar del listado general de todas las cajas de la empresa.

### C. Autorización con Supervisor Reutilizando `SupervisorUnlockModal`
1. **Callback de Acción Autorizada en `SupervisorUnlockModal` (`App.tsx` / `AppContext.tsx`)**:
   - Añadir soporte para ejecutar una acción puntual tras validar el PIN/contraseña en el mismo `SupervisorUnlockModal` que ya usa la barra superior:
     - **Botón "Salir" en Barra Inferior Móvil (`App.tsx`)**: Conectarlo al mismo flujo de validación de Supervisor que ya utiliza el botón "Salir" de escritorio.
     - **Botón "Devolución" (`ExtraViews.tsx`) y Eliminación de Venta Pendiente (`Inventory.tsx`)**: Si `isKioskLocked` está activo, abrir `SupervisorUnlockModal` antes de proceder; si el Modo Kiosco no está activo, se ejecuta directamente como hasta ahora.

### D. Ocultamiento Limpio del Asistente de IA en Kiosco
1. **Condicional de Renderizado (`App.tsx` y `permissions.ts`)**:
   - En `App.tsx`, renderizar `<AudioVoice />` únicamente cuando `!isKioskLocked` (`{!isKioskLocked && <AudioVoice />}`).
   - En `permissions.ts`, establecer `access_ai: false` por defecto para el rol básico de cajero sin afectar al administrador.

### E. Resguardo de Cola Offline y Carrito al Salir
1. **Verificación Previa al Cierre de Sesión (`App.tsx`)**:
   - Antes de ejecutar `setUser(null)` al cerrar sesión:
     - Si `pendingSalesCount > 0` (ventas offline sin subir), mostrar una notificación advirtiendo que existen ventas pendientes de sincronizar y evitar el cierre accidental de la sesión hasta que sincronicen.
     - Si `cart.length > 0`, confirmar con el operador antes de limpiar la sesión para no perder productos escaneados.
2. **Sanitización Segura de ID en Tickets Compartidos (`server.ts`)**:
   - Limpiar caracteres especiales en `saleId` dentro de `/api/tickets/share` manteniendo exactamente el mismo formato de enlace PDF para WhatsApp.
