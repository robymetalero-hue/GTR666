# Plan de Trabajo: Corrección de Defectos y Optimización de Interfaz (Modo Vertical y Horizontal)

## 1. Alcance Estricto
- **Cero funciones nuevas no solicitadas**: No se agregarán módulos, tablas ni funciones adicionales. El trabajo se concentra **100% en corregir defectos visuales, de posicionamiento, desbordamiento y ergonomía táctil** en la interfaz actual, tanto en **Modo Vertical (Portrait)** como en **Modo Horizontal (Landscape)**.

---

## 2. Correcciones en Modo Vertical (Portrait - Celulares y Tablets)

### 2.1. Solapamiento de Barras Inferiores y Menú Desplegable (`src/App.tsx` y `src/views/POS.tsx`)
- **Corrección de colisión en Punto de Venta (`POS.tsx`)**:
  - Actualmente la barra flotante de *"Mi Carrito / Detalles / Cobrar"* usa `bottom-0` cuando `!isKioskLocked`, tapando directamente la barra de navegación inferior (`h-14 bottom-0 z-40` en `App.tsx`).
  - Se ajustará su posicionamiento a `bottom-14 md:bottom-0` (y `bottom-0` en horizontal compacto cuando la barra inferior de navegación se oculta), garantizando que ambas barras sean 100% visibles y accesibles sin superponerse.
  - Se ajustará el padding inferior del catálogo de productos (`pb-32 md:pb-6`) para que la última fila de productos nunca quede oculta detrás de las barras inferiores.
- **Alineación exacta del Menú Móvil Desplegable (`App.tsx`)**:
  - Sincronizar el anclaje superior del panel desplegable (`top-12 sm:top-14`) con la altura real del `header` móvil (`h-12 sm:h-14`), eliminando la rendija vacía de `8px`.
  - Ajustar la altura máxima del menú desplegable (`max-h-[calc(100dvh-7.5rem)]`) para que el perfil de usuario y el botón **"Salir"** nunca queden tapados por la barra de navegación inferior.

### 2.2. Compactación de Tarjetas KPI en Grilla 2x2 y Barras de Filtros (`ExtraViews.tsx`, `Dashboard.tsx`, `CuentasPorCobrarView.tsx`, `Inventory.tsx`, `CajasView.tsx`)
- **Grilla KPI 2x2 en Vertical Móvil**:
  - Cambiar las grillas de indicadores superiores de `grid-cols-1 sm:grid-cols-2` con `p-6` a `grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-4` con padding adaptativo (`p-3.5 sm:p-5`) y tipografía escalable (`text-lg sm:text-2xl tabular-nums`), permitiendo ver los 4 indicadores clave de un vistazo sin consumir toda la pantalla vertical.
- **Alineación de Barras de Búsqueda, Filtros y Botones de Acción**:
  - En `Inventory.tsx`, `HistorialVentasView`, `DevolucionesView`, `CuentasPorCobrarView.tsx` y `CajasView.tsx`, organizar las barras de herramientas móviles con contenedores flexibles y scroll horizontal limpio (`overflow-x-auto scrollbar-none`) o grillas uniformes de 2 columnas para que los botones (`Ingreso Mercadería`, `Control Físico`, `CSV`, `Grupos`, selectores de fecha) no se partan en múltiples líneas desalineadas en pantallas de `360px–412px`.

---

## 3. Correcciones en Modo Horizontal (Landscape - Móviles Girados y Tablets)

### 3.1. Optimización del Punto de Venta en Horizontal (`src/views/POS.tsx` y `src/index.css`)
- **Cabecera Ultra-Compacta en Horizontal (`max-height: 540px` y `orientation: landscape`)**:
  - Reducir paddings y márgenes verticales del bloque fijo superior de `POS.tsx` en modo horizontal, integrando las pestañas de tickets, el buscador y las categorías en un diseño compacto para liberar hasta un **35% más de altura útil** para la grilla de productos.
- **Vista Dividida (Catálogo + Carrito Lateral) en Horizontal**:
  - Habilitar la vista dividida lateral no solo en `lg:` (`>= 1024px`), sino también en dispositivos en orientación horizontal con ancho suficiente (`min-width: 720px` y `orientation: landscape`), mostrando el catálogo a la izquierda y el panel del carrito compacto (`w-[290px] xl:w-[360px]`) a la derecha, y ocultando automáticamente la barra flotante inferior cuando el panel lateral está visible.

### 3.2. Adaptación de Modales y Tablas para Pantallas de Baja Altura (`src/index.css`, `POS.tsx`, `Inventory.tsx`, `CajasView.tsx`, `CuentasPorCobrarView.tsx`, `ExtraViews.tsx`)
- **Modales con Estructura `max-h-[92dvh]` y Cuerpo Scrollable Independiente**:
  - En los modales de **Cobro / Finalizar Venta** (`POS.tsx`), **Ingreso de Stock y Edición de Producto** (`Inventory.tsx`), **Liquidación y Ajuste de Caja** (`CajasView.tsx`), **Registro de Abonos** (`CuentasPorCobrarView.tsx`) y **Devoluciones** (`ExtraViews.tsx`), asegurar que el encabezado y pie de botones usen `shrink-0` con padding compacto en horizontal, y que el contenedor central tenga `flex-1 min-h-0 overflow-y-auto touch-momentum`.
  - En modo horizontal de baja altura, disponer los campos de los formularios de modales en 2 columnas para evitar desplazamientos largos cuando se abre el teclado virtual.
- **Tablas y Listados con Scroll Horizontal/Vertical Suave**:
  - Asegurar que todas las tablas de datos (`Inventory`, `CajasView`, `CuentasPorCobrarView`, `AuditoriaView`) tengan `overflow-x-auto` con encabezados fijos (`sticky top-0`) y celdas numéricas con `tabular-nums whitespace-nowrap` para evitar cortes o textos encimados.

---

## 4. Verificación y Pruebas
1. **Validación de Compilación y Tipado**:
   - Ejecutar `compile_applet` y `lint_applet` verificando `0` errores de TypeScript y CSS.
2. **Validación de Integridad del Sistema**:
   - Ejecutar `node scripts/verify_zero_defect_suite.cjs` para confirmar que ninguna mejora visual altera la lógica de negocio ni las 13 suites / 30 escenarios certificados.
