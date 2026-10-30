# Plan de Restauración de Conexión Automática con Firebase

## Objetivo
Restablecer la conexión y sincronización 100% automática con Firebase usando tus datos reales de producción, eliminando las solicitudes de códigos o variables de entorno desconocidas en AI Studio, mientras se conservan todas las mejoras de seguridad en ventas, cajeros, idempotencia anti-duplicados y actualizaciones limpias de versión.

---

## Cambios Propuestos

### 1. Eliminación de avisos de códigos desconocidos (`.env.example`)
- **Qué pasaba:** Al listar `FIREBASE_SYNC_EMAIL`, `FIREBASE_SYNC_PASSWORD`, `DATABASE_ENV`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` y `VAPID_SUBJECT` en `.env.example`, la plataforma te pedía rellenar esos códigos manualmente.
- **Solución:** Limpiaremos `.env.example` para que no declare variables manuales obligatorias que disparen ventanas emergentes de configuración, ya que el servidor genera o gestiona sus credenciales internas automáticamente.

### 2. Reconexión automática del servicio de sincronización con Firebase (`server.ts`)
- **Qué pasaba:** El servidor esperaba variables de entorno manuales para autenticar el canal de sincronización (`ensureServerAuth()`) y, además, ponía la vista previa en modo `sandbox` aislado por defecto.
- **Solución:**
  - Restaurar la autenticación automática del canal interno de sincronización (`sync@gtrpos.com`) con respaldo automático para que el servidor inicie sesión y sincronice con Firestore sin pedirte claves.
  - Configurar el entorno de base de datos por defecto en **`production`** (datos reales sincronizados con Firebase), cambiando a `sandbox` únicamente si tú lo activas explícitamente.

### 3. Ajuste de reglas de seguridad para el canal de sincronización (`firestore.rules`)
- **Qué pasaba:** La regla `isAuthorizedSyncOrAdmin()` exigía `email_verified == true` incluso para la cuenta técnica interna `sync@gtrpos.com`, la cual se autentica por contraseña interna y no por correo verificado de Google, bloqueando las lecturas/escrituras automáticas del servidor hacia Firestore.
- **Solución:**
  - Permitir que la cuenta administradora principal (`robymetalero@gmail.com`) requiera su verificación de Google (`email_verified == true`), mientras que el canal interno del servidor (`sync@gtrpos.com`) pueda sincronizar automáticamente tras autenticarse en Firebase Auth.
  - Desplegar las reglas actualizadas en Firebase Firestore.

---

## Lo que se mantiene intacto
- Candado de idempotencia (`idempotency_key`) para evitar ventas y abonos duplicados.
- Conservación del cajero original en cada venta realizada en modo Offline.
- Cálculo y validación de precios y totales exclusivamente desde el servidor.
- Barra de actualización automática estilo AI Studio con preservación de carrito y sesión.
