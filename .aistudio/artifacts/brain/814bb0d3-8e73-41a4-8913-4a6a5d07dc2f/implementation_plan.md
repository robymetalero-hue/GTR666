# Optimización de Carga Instantánea (<1s), Protección de Carrito en Curso y Arranque No Bloqueante (v2.6.1)

Este plan resuelve de raíz el problema observado en el video (donde la barra de progreso del navegador móvil se detiene alrededor del 15% al intentar abrir `dspos.app`), garantizando que la aplicación cargue en **menos de 1 segundo**, que **los productos armados en el carrito jamás se pierdan si ocurre un microcorte de internet**, y que todas las pruebas se ejecuten en el entorno aislado (`Sandbox`) sin tocar un solo dato de producción.

## User Review & Critical Decisions

> [!IMPORTANT]
> **Decisiones confirmadas e incorporadas en el plan:**
> - **Protección Total del Carrito en Curso ante Cortes de Conexión**: Si estás armando una venta con 10, 15 o más productos en el carrito y se corta el internet momentáneamente, **NO tienes que volver a registrar los productos**. La pantalla de bloqueo sin conexión actúa como un escudo protector encima del Punto de Venta sin cerrar ni borrar el carrito; en cuanto vuelve la señal, el bloqueo desaparece, tus 10–15 ítems siguen exactamente donde estaban (con su cliente, descuento y método de pago) y el sistema verifica automáticamente su stock actual contra el servidor en vivo antes de cobrar.
> - **Caché Visual Inteligente + Datos 100% en Vivo**: Los archivos visuales estáticos con firma única de versión (iconos, hojas de estilo y paquetes de interfaz) se almacenan en la caché nativa del navegador para que la pantalla abra al instante, mientras que el documento principal, la validación de versión y todas las rutas de base de datos (`/api/*`) exigen conexión 100% en vivo sin caché (`no-store`).
> - **Arranque de Servidor No Bloqueante**: Al encender o despertar el servidor en la nube, la entrega de la página web tiene prioridad absoluta en el hilo principal, difiriendo y fragmentando la sincronización pesada con el respaldo en segundo plano para que jamás congele la entrada de los usuarios.
> - **Verificación 100% Aislada en Sandbox**: Todas las pruebas de rendimiento, carga y operaciones se ejecutarán exclusivamente contra el entorno aislado (`gtr_pos_sandbox.db`), sin alterar ni tocar un solo registro de la base de datos de producción (`gtr_pos.db`).

---

## 1. Overview & Core Concept

- **¿Qué pasa con el Carrito si se corta el internet a mitad de una venta?**
  1. **Se mantiene 100% intacto en pantalla y en memoria de sesión del día**: El carrito no es una "venta fantasma guardada en cola offline", sino un borrador visual en preparación. Por eso, durante el mismo día de trabajo, el bloqueo por falta de internet congela temporalmente el botón de cobro para evitar errores en la base de datos, pero **conserva intactos todos los ítems del carrito, pestañas de comandas (`Venta 1`, `Venta 2`), cliente seleccionado y descuentos**.
  2. **Indicador de tranquilidad en el bloqueo sin conexión**: Cuando aparezca el aviso de *"Sin Conexión con el Servidor Principal"*, mostrará explícitamente un indicador tranquilizador si hay productos en el carrito: ***"Tu carrito en curso (X ítems) está protegido y se mantendrá intacto en cuanto vuelva la conexión"***.
  3. **Sincronización de Stock en Vivo al Reconectar**: En el instante en que regresa el internet, la aplicación consulta el catálogo en vivo del servidor y actualiza silenciosamente el límite de stock disponible de los productos que tienes en el carrito, permitiéndote cobrar de inmediato sin volver a escanear ni buscar nada.
- **Diagnóstico de Causa Raíz del Video (Bloqueo al 15% en Chrome Móvil)**:
  1. **Interceptación del Service Worker en cada petición**: El Service Worker registraba un receptor vacío de red (`fetch`), obligando a Chrome en Android a despertar el hilo del Service Worker antes de descargar el documento inicial y cada archivo visual, deteniendo la barra de carga al ~15%.
  2. **Saturación del Hilo del Servidor al Despertar (Cold Start)**: Al iniciar el servidor, se ejecutaban en serie una descarga masiva (`pullFirestoreToLocal`) dentro de una única transacción síncrona sobre las 26 tablas y luego una subida completa (`pushAllLocalToFirestore`), bloqueando el bucle de eventos de Node.js durante varios segundos.
  3. **Bloqueo potencial de `IndexedDB.deleteDatabase` en teléfonos**: Si el navegador móvil mantenía una conexión abierta a IndexedDB, la orden de borrado disparaba `onblocked` sin resolver la promesa, reteniendo el arranque.

---

## 2. User Experience & Visual Design

- **Flujo de Entrada Instantánea y Resiliencia en Caja**:
  1. **Apertura Inmediata (< 1s)**: Al ingresar a `dspos.app` en Chrome Android, iOS o PC, el servidor entrega el HTML de inmediato sin bloqueos de CPU y el navegador reutiliza los paquetes visuales inmutables ya descargados, mostrando la pantalla de acceso o el terminal al instante.
  2. **Protección de Venta en Preparación (10–15+ ítems)**:
     - Si ocurre un corte de Wi-Fi o datos móviles mientras el cajero arma el carrito, se despliega la capa de protección mostrando cuántos ítems están resguardados en espera de señal.
     - Al restablecerse la conexión, la capa se retira automáticamente, el carrito permanece intacto y se sincroniza el stock real del servidor.
  3. **Limpieza Diaria con Límite de Tiempo Estricto (400 ms máx.)**: Al cambiar de día calendario (medianoche Bolivia) o al iniciar sesión del día, la purga de almacenamiento local aplica un límite máximo de 400 ms para que `IndexedDB` jamás congele la interfaz.

---

## 3. Key Product Decisions & Trade-Offs

- **Decisión 1: Eliminación del interceptor `fetch` en el Service Worker + Caché HTTP Inmutable para Activos Visuales**
  - *Enfoque Elegido*: Retirar el listener `fetch` del Service Worker (dejándolo dedicado exclusivamente a notificaciones Push de ventas y control de versión) y configurar cabeceras HTTP `Cache-Control: public, max-age=31536000, immutable` únicamente para los archivos compilados con hash (`/assets/*`), manteniendo `Cache-Control: no-store` en `index.html`, `version.json` y `/api/*`.
  - *Por qué*: Chrome Android activa su optimización nativa de navegación rápida (*Fast-Path Navigation*) cuando el Service Worker no intercepta `fetch`, eliminando el cuello de botella del 15% en la barra de carga.
- **Decisión 2: Preservación del Carrito Activo Durante el Día + Reconciliación en Vivo al Reconectar**
  - *Enfoque Elegido*: Mantener el estado del carrito activo (`cart` y `tabs`) protegido durante reconexiones dentro del mismo día laboral y reconciliar automáticamente el stock disponible de cada ítem del carrito contra la respuesta en vivo de `/api/products` al volver la conexión.
  - *Por qué*: Evita que el cajero pierda tiempo volviendo a cargar 10–15 productos frente al cliente si el internet parpadea, sin comprometer la regla de que el cobro final se ejecuta 100% en línea contra el servidor.
- **Decisión 3: Sincronización de Respaldo Diferida y No Bloqueante en el Servidor**
  - *Enfoque Elegido*: Diferir el inicio de la sincronización de arranque con Firestore unos segundos después de que el servidor ya esté atendiendo peticiones HTTP, procesar cada tabla cediendo el turno al bucle de eventos (`setImmediate`) y omitir la subida masiva redundante (`pushAllLocalToFirestore`) al arrancar cuando la base de datos local ya está verificada y sincronizada.
  - *Por qué*: Garantiza que el servidor web responda en milisegundos incluso recién encendido en Cloud Run.

---

## 4. Technical Architecture & Data Strategy

### Diagrama de Arquitectura de Carga Instantánea y Protección de Carrito

```
┌────────────────────────────────────────────────────────────────────────────┐
│                   NAVEGADOR MÓVIL (Chrome Android / iOS)                   │
│                                                                            │
│  1. Navegación Directa (Sin bloqueo de Service Worker en 'fetch')          │
│     ├─► GET / (index.html) ──────────► no-store (Siempre última versión)   │
│     ├─► GET /assets/*.[hash].js/css ─► Caché HTTP Inmutable (Carga en 0ms) │
│     └─► GET /api/* (Catálogo/Ventas) ► 100% En Vivo desde Servidor Principal│
│                                                                            │
│  2. Escudo de Carrito en Curso ante Microcortes de Red                     │
│     ├─► Se pierde internet ─► Bloquea cobro pero CONSERVA los 10-15 ítems  │
│     └─► Vuelve internet ────► Reconcilia stock en vivo y desbloquea cobro  │
│                                                                            │
│  3. Guardián Anti-Bloqueo de Almacenamiento Local (Time-Bounded 400ms)     │
│     └─► Cierra conexiones previas de IndexedDB + Resuelve en <= 400ms      │
└───────────────────────────────────────┬────────────────────────────────────┘
                                        │ Respuesta HTTP < 50ms
                                        ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                     SERVIDOR PRINCIPAL (Node.js / Express)                 │
│                                                                            │
│  1. Hilo Principal Desbloqueado (Prioridad Absoluta a Tráfico Web y POS)   │
│     ├─► Sirve HTML y API de Ventas/Inventario instantáneamente             │
│     └─► Sincronización de Respaldo Diferida y Fragmentada (setImmediate)   │
│                                                                            │
│  2. Aislamiento Estricto de Bases de Datos                                 │
│     ├─► Producción (gtr_pos.db) ─────────► Intacta (Única Fuente de Verdad)│
│     └─► Sandbox (gtr_pos_sandbox.db) ────► Pruebas de Velocidad y Control  │
└────────────────────────────────────────────────────────────────────────────┘
```

### Estrategia de Datos y Verificación en Entorno Aislado (Sandbox)

1. **Protección Absoluta de Producción (`gtr_pos.db`)**:
   - No se modificará, borrará ni alterará ningún registro de ventas, inventario o cajas en `gtr_pos.db`.
2. **Pruebas Automatizadas en Entorno Aislado (`x-app-environment: sandbox`)**:
   - Se verificará la velocidad de respuesta (`TTFB` de `/`, `/version.json`, `/sw.js`, `/api/products`, `/api/bootstrap`) y la preservación del carrito en el entorno aislado `sandbox`.
