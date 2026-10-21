# Plan de Implementación: Bloque 1 — Seguridad e Integridad Crítica y Ajustes Finales

Plan quirúrgico para corregir las fallas comprobadas de seguridad, autenticación, protección de costos y aislamiento de datos en GTR POS (`robymetalero-hue/GTR666`), conforme a las aclaraciones acordadas.

---

## 1. Aislamiento Confiable de Base de Datos (`server.ts`)
- **Problema**: Las líneas 195–215 procesan la cabecera HTTP `x-app-environment`, permitiendo a un cliente web forzar el cambio entre sandbox y producción.
- **Solución Quirúrgica**:
  - Eliminar por completo la lectura y evaluación de `req.headers['x-app-environment']`.
  - El entorno se resolverá exclusivamente con las variables del entorno del servidor y el hostname del host confiable:
    - `process.env.APP_ENV === 'sandbox' || process.env.APP_ENV === 'development'`
    - Dominios que contengan `ais-dev`, `localhost` o `127.0.0.1` -> `sandbox`
    - Dominios que contengan `ais-pre` o `NODE_ENV === 'production'` -> `production`
  - Mantener la cabecera de respuesta `res.setHeader('X-App-Environment', ...)` para fines informativos del frontend, pero no como vector de entrada.

---

## 2. Acceso y Modificación de Cajas (`server.ts`)
- **Ruta `GET /api/cajas/:userId/sales`**:
  - Exigir que `req.verifiedUser` coincida con `userId` o tenga rol de administrador (`admin`, `administrador`, `propietario`). Si un vendedor intenta consultar ventas de otro usuario, responder `403 Prohibido`.
  - En la consulta de `sale_items`: Ocultar `si.cost`. Para usuarios que no son administradores ni poseen permisos de costos, omitir el campo `cost` devolviendo únicamente `{ id, sale_id, product_id, quantity, price, product_name, sku, category }`.
- **Ruta `POST /api/cajas/:userId/close`**:
  - Eliminar la confianza en `adminUser.role` y `adminUser.id` provenientes del `req.body`.
  - Exigir sesión válida en `req.verifiedUser` con rol de administrador real. Registrar al administrador genuino en `caja_cierres`.
- **Ruta `POST /api/cash-accounts/:sellerId/settle`**:
  - Reemplazar `req.headers['x-user-role']` por la verificación estricta de `req.verifiedUser` verificado por JWT.

---

## 3. Control Físico de Inventario (`server.ts`)
- **Rutas `/api/inventory-counts`**:
  - En `POST /api/inventory-counts`: Exigir que la opción `force_new` solo pueda ser ejecutada por administradores verificados (`req.verifiedUser`).
  - En `PUT /api/inventory-counts/:id/status`: Exigir rol de administrador verificado para pasar a estado `cerrado`, `aprobado` o ejecutar `auto_apply`.
  - En `POST /api/inventory-counts/:id/recount`: Exigir rol de administrador verificado para solicitar recuentos forzados.
  - En `GET /api/inventory-counts/:id`: Mantener el modo `BLIND` estricto: cuando un auditor o vendedor consulte el conteo, no retornar `p.stock` actual, costo ni diferencias calculadas hasta que la sesión sea cerrada o aprobada formalmente por un administrador.

---

## 4. Información Confidencial y Sincronización Firestore (`firebaseSync.ts` y `server.ts`)
- **Exclusión de `jwt_secret` en `firebaseSync.ts`**:
  - Al realizar push de la tabla `settings` a Firestore (tanto en batch como en sync individual), omitir explícitamente cualquier fila donde `key === 'jwt_secret'`.
  - Garantizar que este secreto nunca se escriba en los documentos remotos de Firestore.
- **Protección de Endpoints de Costos (`server.ts`)**:
  - `/api/stock-arrivals`: Ocultar costos a usuarios sin permisos de compra/finanzas.
  - `/api/products/:id/stock-history`: Ocultar el campo `cost` de los logs de auditoría a vendedores estándar.
  - `/api/products/:id/price-history`: Exigir autorización para visualizar históricos de costo unitario.
  - `/api/system-audit`: Exigir rol administrativo.

---

## 5. Clientes y Configuraciones (`server.ts`)
- **Ruta `GET /api/clients`**:
  - Exigir sesión válida (`req.verifiedUser`).
  - Permitir el acceso únicamente a administradores o usuarios que posean el permiso explícito `view_clients` (o `view_customers`).
- **Ruta `POST /api/clients/:id/points`**:
  - Exigir sesión verificada y permiso administrativo o de fidelización.
- **Ruta `POST /api/settings/receipt`**:
  - Retirar de rutas públicas; exigir rol de administrador verificado.

---

## 6. Ajustes Finales en Componentes Frontend
- **`src/views/CajasView.tsx` (`calculateMethodTotals`)**:
  - Remover el fallback a `exchangeRate` del contexto global vigente; usar `m.sale_exchange_rate || m.exchange_rate || 6.96` para que los arqueos en Bs nunca fluctúen con cambios posteriores de tasa.
- **`src/views/Inventory.tsx` (Modal de Ticket)**:
  - Eliminar el fallback a la tasa actual en `traceTicketDetails.exchange_rate || exchangeRate` cuando se visualice un comprobante histórico.

---

## 7. Verificación y Pruebas
1. Intentar manipular `x-app-environment` vía HTTP y comprobar que el backend lo ignora.
2. Probar acceso a `GET /api/clients` sin sesión (401) y con vendedor sin permiso `view_clients` (403).
3. Verificar que un vendedor no pueda cerrar cajas de otros ni recibir `si.cost` en `GET /api/cajas/:userId/sales`.
4. Verificar que `pushLocalToFirestore('settings')` no sincronice `jwt_secret`.
5. Ejecutar `tsc --noEmit` y `npm run build` para asegurar compilación sin errores.
