# GTR666 — Plan Quirúrgico de Corrección de Fallas Pendientes

Plan de resolución puntual y quirúrgico para subsanar las 6 fallas identificadas en el sistema en producción GTR POS (`robymetalero-hue/GTR666`), respetando estrictamente la inmutabilidad de la base de datos, precios y funciones operativas existentes.

---

## Decisiones Confirmadas por el Usuario

1. **Aislamiento de Entorno sin Cabeceras HTTP**:
   - Si `APP_ENV` no está definida en el servidor, el entorno por defecto será **producción** si `NODE_ENV === 'production'`, y **sandbox** en cualquier otro caso.
   - Se eliminan por completo las evaluaciones de `Host`, `x-forwarded-host` y `Referer` en la decisión de la base de datos.
2. **Permisos de Clientes (`view_clients`)**:
   - Habilitado por defecto (`true`) para el rol vendedor en `DEFAULT_PERMISSIONS` y en la consola de permisos, garantizando que el POS mantenga su capacidad operativa de buscar y asociar clientes a las ventas.
3. **Manejo de `jwt_secret` en Firestore**:
   - Auditar y preparar script seguro de eliminación del documento en Firestore sin alterar ni rotar la clave local (`.server_jwt_secret` / SQLite) y sin publicar reglas que interrumpan la sincronización activa.

---

## Detalle de Correcciones Quirúrgicas por Módulo

### 1. Aislamiento de Bases de Datos (`server.ts` ~línea 195)
- **Diagnóstico**: Las líneas 207–211 aún utilizaban `host.includes('ais-dev')`, `referer.includes('ais-dev')` y `host.includes('ais-pre')`, permitiendo que peticiones HTTP con encabezados `Host` o `Referer` falsificados influyeran en el aislamiento.
- **Acción**:
  - Eliminar toda dependencia de `req.headers.host`, `req.headers['x-forwarded-host']` y `req.headers.referer`.
  - La variable `isSandbox` se resolverá exclusivamente con:
    ```ts
    let isSandbox = false;
    if (process.env.APP_ENV === 'sandbox' || process.env.APP_ENV === 'development') {
      isSandbox = true;
    } else if (process.env.APP_ENV === 'production') {
      isSandbox = false;
    } else {
      isSandbox = process.env.NODE_ENV !== 'production';
    }
    ```
  - Preservar `dbAsyncLocalStorage` y los archivos SQLite existentes inalterados.

---

### 2. Seguridad de Firestore y JWT (`firebaseSync.ts`, `authSecurity.ts`, `firestore.rules`)
- **Diagnóstico**: El secreto `jwt_secret` pudo haberse sincronizado a Firestore en despliegues pasados y las reglas vigentes en `firestore.rules` permiten `allow read: if true;` en `/settings/{settingId}`.
- **Acción**:
  - Crear script de auditoría y remediación `scripts/audit_and_purge_jwt_secret.ts` que se conecte a Firestore con el SDK existente y elimine el documento `jwt_secret` de las colecciones `settings` y `sandbox_settings` si existiese, sin tocar la base local SQLite ni regenerar el secreto.
  - En `firestore.rules`, restringir la lectura del documento `jwt_secret`:
    ```
    match /settings/{settingId} {
      allow read: if settingId != 'jwt_secret';
      allow create, update: if (isAuthenticated() || isSandbox('settings') || hasIntegrityProof());
      allow delete: if false;
    }
    ```
  - Mantener las reglas preparadas sin desplegar a producción sin previa comprobación.

---

### 3. Permisos de Clientes y Auditoría (`server.ts`, `src/utils/permissions.ts`, `src/views/PermissionsConsole.tsx`)
- **Diagnóstico**:
  - `/api/clients` exige `view_clients`, el cual no existía en `DEFAULT_PERMISSIONS` ni en `PermissionsConsole.tsx`.
  - `/api/system-audit` consultaba `view_audit_logs` o `system_audit`, mientras la consola define `view_audit`.
- **Acción**:
  - En `src/utils/permissions.ts`:
    - Agregar `view_clients: true` a `DEFAULT_PERMISSIONS`.
    - Normalizar `view_clients`:
      ```ts
      normalized.view_clients = perms.view_clients !== undefined ? !!perms.view_clients : (perms.clients !== undefined ? !!perms.clients : true);
      ```
    - Normalizar `view_audit`:
      ```ts
      const auditVal = perms.view_audit !== undefined ? !!perms.view_audit : (perms.view_audit_logs !== undefined ? !!perms.view_audit_logs : false);
      normalized.view_audit = auditVal;
      normalized.view_audit_logs = auditVal;
      ```
  - En `src/views/PermissionsConsole.tsx`:
    - Incluir el ítem `view_clients` en el grupo de ventas/clientes para visualización y configuración en UI.
  - En `server.ts` (`/api/system-audit`):
    - Validar `isAdmin || !!userPerms.view_audit || !!userPerms.view_audit_logs`.

---

### 4. Exposición de Costos en Historiales (`server.ts`)
- **Diagnóstico**:
  - En `/api/stock-arrivals`: `canViewCosts` incluía `userPerms.increase_stock`. El usuario con permiso de aumentar existencias no debe ver costos de compra.
  - En `/api/inventory-audit` y `/api/products/:id/price-history`: Si un log tiene `price_before`, `price_after`, o datos serializados en `before_data`/`after_data` que corresponden a costos, se entregaban íntegros.
- **Acción**:
  - En `GET /api/stock-arrivals`:
    - Corregir a: `const canViewCosts = isAdmin || !!userPerms.view_costs || !!userPerms.financial_reports;` (eliminando `increase_stock`).
    - Para usuarios sin `canViewCosts`, enviar `arrival_price: null`.
  - En `GET /api/products/:id/price-history` e `inventory-audit`:
    - Sanitizar profundamente los registros cuando `!canViewCosts`:
      - Si el evento es `cambio_costo`, excluirlo del listado.
      - Para otros eventos, remover o reemplazar campos de costo de `before_data`, `after_data` y `changed_fields`.
  - En `GET /api/products/:id/stock-history`:
    - Mantener `price: null` en ingresos para usuarios sin permisos de costo.

---

### 5. Control Físico de Inventario (`PUT /api/inventory-counts/:id/status`)
- **Diagnóstico**: Se protegieron `cerrado` y `aprobado`, pero un operario podía cancelar sesiones activas pasando `status = 'cancelado'`.
- **Acción**:
  - Exigir que la cancelación (`status === 'cancelado'`) solo pueda realizarse por:
    - Un administrador verificado (`isAdmin`), o
    - El propio usuario que inició la sesión (`Number(count.user_id) === Number(verifiedUser.id)`), impidiendo que un empleado cancele auditorías ajenas.
  - Conservar el flujo normal de conteo (`en_progreso`, `pausado`, `finalizado`) y la ocultación BLIND.

---

### 6. Acceso a Caja y Auditoría Forense (`server.ts`)
- **Diagnóstico**:
  - `requireForensicAuditAccess`: leía `req.headers['x-user-role']` y `req.headers['x-user-username']`.
  - `GET /api/cash-accounts`: leía `req.headers['x-user-role']` y `req.headers['x-user-id']`.
  - `GET /api/cash-accounts/:sellerId/movements`: leía `req.headers['x-user-role']` y `req.headers['x-user-id']`.
- **Acción**:
  - En `requireForensicAuditAccess`:
    - Leer exclusivamente `(req as any).verifiedUser`. Si no hay sesión o no es administrador/usuario con permiso `access_forensic_audit`, rechazar con 403.
  - En `GET /api/cash-accounts`:
    - Usar `verifiedUser.role` y `verifiedUser.id`. Si el rol es `vendedor`, retornar únicamente su propia caja. Si es admin, retornar todas las cuentas.
  - En `GET /api/cash-accounts/:sellerId/movements`:
    - Usar `verifiedUser`. Si `!isAdmin` y `verifiedUser.id !== sellerId`, responder 403.

---

## Matriz de Pruebas y Verificación

1. **Prueba de Aislamiento**: Peticiones con `Host` o `Referer` arbitrarios no deben cambiar la base SQLite en uso.
2. **Prueba de Permisos**:
   - Vendedor con `view_clients: true` consulta `/api/clients` exitosamente (200 OK).
   - Vendedor sin permiso recibe 403.
   - Consulta a `/api/system-audit` con `view_audit: true` accede correctamente; sin él, 403.
3. **Prueba de Costos**:
   - Usuario con solo `increase_stock` en `/api/stock-arrivals` ve cantidades y fechas pero `arrival_price: null`.
   - `/api/products/:id/price-history` no entrega eventos de costo a usuarios sin permiso.
4. **Prueba de Cajas y Auditoría Forense**:
   - Peticiones enviando `x-user-role: admin` sin token válido son rechazadas (401/403).
   - Un cajero autenticado no puede acceder a `/api/cash-accounts/:otroId/movements`.
5. **Prueba de Auditoría de Inventario**:
   - Intento de cancelar auditoría ajena con usuario estándar retorna 403.
6. **Compilación y Lint**:
   - `tsc --noEmit` y `npm run build` sin errores.
