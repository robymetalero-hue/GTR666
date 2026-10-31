# Plan de Cierre y Blindaje Final en Producción — GTR POS

Este plan implementa las tres mejoras finales de seguridad, control de acceso y verificación de sincronización en vivo para dejar el entorno productivo (`gtr_pos.db` + Cloud Firestore) completamente blindado y sin brechas operativas.

## Revisión del Usuario y Decisiones Confirmadas

> [!IMPORTANT]
> **Decisiones confirmadas por el usuario en la Fase 1:**
> - **Alcance de Cierre (`Aplicar las 3 mejoras de blindaje y desplegar reglas`)**: Se aplicará el blindaje de permisos en servidor/cliente, la limpieza y despliegue oficial de `firestore.rules` hacia Firebase, y el verificador de sincronización en vivo con la nube.
> - **Control de Acceso Estricto (`Solo Propietario y Administradores`)**: Tanto la edición directa de stock en productos como el reseteo/liquidación de cajas acumuladas quedan restringidos exclusivamente a usuarios con rol **`propietario`**, **`admin`** o **`administrador`**.

---

## 1. Visión General y Objetivo Operativo

- **Qué resuelve**:
  1. **Autorización exclusiva para Propietario y Administradores**: Garantiza que el rol `propietario` tenga autoridad total reconocida en el backend (`PUT /api/products/:id` y `POST /api/cash-accounts/:sellerId/settle`) sin bloqueos falsos (`403`), mientras impide que cualquier cuenta de `vendedor` modifique existencias o reinicie cajas acumuladas.
  2. **Endurecimiento y despliegue de `firestore.rules`**: Elimina las referencias a correos fijos no verificados (`server-sync@gtrpos.com`, `sync@gtrpos.com`) en `isSyncDaemon()`, exige `email_verified == true` para toda autoridad por correo o reclamo de sincronización, mantiene bloqueada la alteración no autorizada de stock en `products` y despliega las reglas directamente en el proyecto de Firebase.
  3. **Verificación y Reconciliación Activa con Cloud Firestore**: Incorpora un endpoint y control de verificación inmediata en el panel de **Configuraciones** (y acceso rápido desde **Cajas**) que comprueba el conteo exacto de ventas, productos y cuentas de caja en `gtr_pos.db`, fuerza el envío de cualquier cambio local pendiente a Cloud Firestore y muestra el resumen de integridad con numerales tabulares.

---

## 2. Experiencia de Usuario y Diseño Visual

- **Flujos de Usuario Clave**:
  1. **Reseteo de Caja Exclusivo para Propietario/Admin**: En la vista **Cajas**, únicamente el Propietario y los Administradores visualizan y ejecutan el botón **Resetear a 0.00 Bs** y el modal de **Arqueo con Conteo**. Los vendedores ven únicamente su estado informativo sin controles de autoliquidación.
  2. **Edición de Stock Protegida por Rol**: En **Inventario**, al abrir el modal de edición de un producto existente, el campo de stock físico solo es editable para `propietario`, `admin` y `administrador` (registrando automáticamente el ajuste en el Kárdex). Para cualquier otro rol, el campo permanece bloqueado y el servidor conserva intacto el stock anterior (`oldProd.stock`).
  3. **Verificador de Sincronización Cloud en Vivo**: En **Configuraciones**, el administrador o propietario dispone de un botón de acción directa **Verificar y Sincronizar con Cloud Firestore**, que ejecuta una conciliación completa (`pushAllLocalToFirestore`) y muestra el estado verificado de ventas, productos y cajas sin recargar la página.
- **Identidad Visual y Disciplina de Interfaz**:
  - **Estética SaaS de Alta Densidad**: Superficies limpias de un solo nivel de elevación con bordes sutiles de `1px` (`border-slate-200 dark:border-slate-800`), respetando el modo claro/oscuro existente.
  - **Tipografía y Numerales Tabulares**: Todas las cifras financieras, conteos de tickets, unidades de stock y marcas de tiempo emplean `font-mono tabular-nums` para alineación vertical exacta.
  - **Disciplina Cero-Píldoras en Metadatos**: Los indicadores informativos usan texto limpio con separadores tipográficos (`·`), reservando los botones rellenos exclusivamente para acciones interactivas reales.

---

## 3. Decisiones Técnicas y de Seguridad

- **Decisión 1: Validación de Rol en Servidor Basada en `verifiedUser` + Invariante `K02/F10`**
  - *Enfoque elegido*: En `PUT /api/products/:id`, el servidor identifica al usuario mediante `req.verifiedUser` (token JWT verificado) además de las cabeceras de contexto, reconociendo explícitamente a `propietario`, `admin` y `administrador` como roles autorizados para modificar stock directo. Si un usuario no administrador edita metadatos permitidos de un producto, el servidor conserva `oldProd.stock` sin alterarlo. En `POST /api/cash-accounts/:sellerId/settle`, solo `propietario`, `admin` y `administrador` pueden ejecutar la liquidación o reseteo a cero.
  - *Por qué*: Cumple simultáneamente la política de máxima seguridad solicitada por el propietario y las pruebas de auditoría (`K02/F10`), evitando que el propietario sufra rechazos `403` al editar productos.
- **Decisión 2: Reglas de Firestore (`firestore.rules`) Sin Correos Fijos No Verificados**
  - *Enfoque elegido*: En `isSyncDaemon()`, se retiran los correos literales `['server-sync@gtrpos.com', 'sync@gtrpos.com']` sin verificación de correo, permitiendo únicamente tokens con `email_verified == true` y rol/claim de sincronización o el correo verificado del propietario (`robymetalero@gmail.com`), o el UID técnico autorizado del servidor. En la colección `/products/{productId}`, toda escritura o actualización exige `isAuthorizedSyncOrAdmin()` junto con `hasValidIntegrityEnvelope()` y `hasValidNumericInvariants()`.
  - *Por qué*: Cierra los hallazgos `M13` y `L06` del informe de auditoría y garantiza que las reglas desplegadas en producción coincidan con el código auditado.

---

## 4. Arquitectura Técnica y Flujo de Datos

```
┌────────────────────────────────────────────────────────────────────────────┐
│                   CLIENTE POS (React + Contexto Producción)                │
│                                                                            │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────┐  │
│  │   Vista Inventario   │  │     Vista Cajas      │  │ Configuraciones  │  │
│  │ Stock editable solo  │  │ "Resetear a 0.00 Bs" │  │ Botón Verificar  │  │
│  │ Propietario / Admin  │  │ solo Propietario/Adm │  │ Sincronización   │  │
│  └──────────┬───────────┘  └──────────┬───────────┘  └────────┬─────────┘  │
└─────────────┼─────────────────────────┼───────────────────────┼────────────┘
              │ PUT /api/products/:id   │ POST /settle          │ POST /api/sync/verify
              ▼                         ▼                       ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                     SERVIDOR EXPRESS + SQLITE (gtr_pos.db)                 │
│                                                                            │
│  1. Verifica JWT (verifiedUser): exige rol propietario | admin             │
│  2. Transacción ACID en gtr_pos.db + Registro en Kárdex / Cash Settlements │
│  3. Replicación inmediata pushLocalToFirestore + Escudo Anti-Sobrescritura │
└───────────────────────────────────────┬────────────────────────────────────┘
                                        │
                                        ▼
┌────────────────────────────────────────────────────────────────────────────┐
│         CLOUD FIRESTORE (Reglas firestore.rules Desplegadas vía RPC)       │
│  • isAuthorizedSyncOrAdmin() con email_verified == true                    │
│  • Verificación de sobre criptográfico SHA-256 (_tx_hash, _tx_timestamp)   │
└────────────────────────────────────────────────────────────────────────────┘
```

### Mapa de Componentes e Interacciones
- **Módulo de Inventario (`PUT /api/products/:id`)**: Verifica `isOwnerOrAdmin` (`propietario`, `admin`, `administrador`). Si es administrador/propietario y envía un nuevo `stock`, actualiza la existencia y escribe el registro en `inventory_audit_logs` y `system_audit_logs` dentro de la misma transacción SQLite, disparando `syncAfterWrite` hacia Firestore.
- **Módulo de Cajas (`POST /api/cash-accounts/:sellerId/settle`)**: Verifica `isOwnerOrAdmin`. Registra el corte en `cash_settlements`, cambia los movimientos pendientes a `'liquidado'`, fija `current_balance = 0.0` con `last_settlement_at` en formato ISO canónico y empuja de inmediato los tres documentos a Firestore.
- **Verificador de Sincronización (`POST /api/sync/verify-and-push`)**: Ejecuta `pushAllLocalToFirestore()` en el contexto de producción y devuelve el conteo actualizado de ventas, productos, clientes y cajas sincronizadas para mostrar confirmación inmediata en la interfaz.
- **Despliegue de Reglas (`firestore.rules`)**: Tras actualizar el archivo de reglas, se ejecuta el despliegue hacia Firebase para que las reglas queden activas en la base de datos de producción.
