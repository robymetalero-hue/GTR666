# Plan de Implementación: Mejoras de Interfaz, Usabilidad y Legibilidad (M01 - M10) — GTR666

## 1. Visión General y Alcance
El objetivo es elevar la legibilidad, agilidad operativa y experiencia de usuario de **GTR666** en dispositivos móviles (vertical y horizontal corto), tablets y computadoras de escritorio, sin alterar la lógica de negocio, contratos de API, permisos, transacciones ni bases de datos.

Se aplican las tres decisiones clave del usuario:
- **Favoritos**: Pestaña destacada al inicio del carrusel de categorías en el POS.
- **Tickets térmicos en 58 mm**: Desglose detallado en dos líneas (Línea 1: Nombre envuelto; Línea 2: `cant. × P.Unit = Subtotal`).
- **Carrito en móvil**: Minimizado con badge flotante y notificación rápida para permitir escaneo ágil y continuo sin interrumpir el catálogo.

---

## 2. Desglose de Cambios por Módulo (M01 - M10)

### M01. POS Adaptable y Descripciones Legibles (`src/views/POS.tsx`)
- **Problema**: Tarjetas con `h-7`/`h-8` rígido y `line-clamp-2` que cortan nombres largos (ej. modelos y capacidades); toques en imagen agregan accidentalmente productos al carrito.
- **Acciones**:
  1. Reemplazar alturas fijas por `min-h-[2.5rem]` y `break-words` permitiendo 2 a 3 líneas completas de texto.
  2. Implementar `e.stopPropagation()` al hacer clic en fotos, botones de detalle o estrellas de favoritos para evitar agregados no intencionales.
  3. Asegurar contenedores con `min-w-0` y scroll vertical fluido sin desbordamiento horizontal en pantallas desde 320 px hasta 412 px y 800×360 px (horizontal corto).
  4. Mantener la paginación inicial de 48 artículos y los tres modos de vista (`grid`, `compact-grid`, `list`).

### M02. Panel de Cobro Más Claro y Acción Accesible (`src/views/POS.tsx`)
- **Problema**: El modal de cobro tiene botones y campos pequeños, y en celulares con teclado en pantalla la acción principal queda inaccesible.
- **Acciones**:
  1. Reorganizar la ventana en 3 bloques visuales claros:
     - **Resumen destacado**: Total a Pagar en BOB grande (28–32 px), con indicador de moneda explícito.
     - **Entrada de pago**: Campo de Efectivo Recibido y Cambio/Vuelto (20–24 px) en color verde/esmeralda distinguible.
     - **Métodos y datos**: Selector de método (Efectivo, QR, Transferencia, Crédito) con campos contextuales.
  2. Estructura con `max-h-[90vh]`, encabezado fijo, cuerpo con scroll independiente y pie de acción fijo accesible incluso con teclado virtual abierto.
  3. Conservar 100% de la lógica de descuentos, puntos, abonos y `clientOperationId`.

### M03. Carrito Más Fácil de Revisar y Editar (`src/views/POS.tsx`)
- **Problema**: Botones `+` y `-` con áreas táctiles reducidas; la barra móvil del POS choca con la barra de navegación del shell en ciertas resoluciones.
- **Acciones**:
  1. Aumentar el tamaño táctil de los controles a un mínimo de 44×44 px (`touch-target`), separando claramente el botón de eliminar del de incrementar cantidad.
  2. Nombre del producto con espacio amplio y visualización clara de tipo de precio (unitario, mayorista, manual).
  3. Respetar la decisión del usuario: en pantallas móviles el carrito se mantiene como barra/badge flotante inferior interactivo con contador en tiempo real, permitiendo seguir escaneando sin obstrucciones.
  4. Ajustar el offset inferior de la barra móvil coordinándose con la visibilidad real del shell (`landscape-hide`).

### M04. Confirmación de Escaneo Sincronizada con el Resultado Real (`src/views/POS.tsx` y `src/components/BarcodeScannerModal.tsx`)
- **Problema (UI21)**: Cuando se escanea un producto agotado o sin stock, el modal confirmaba éxito con beep a pesar de que el carrito rechazaba la operación.
- **Acciones**:
  1. Modificar `addToCart` para devolver un resultado estructurado `{ success: boolean, reason?: string, quantity?: number }`.
  2. En `BarcodeScannerModal.tsx`: invocar feedback de éxito (sonido/vibración) **únicamente** si `addToCart` devuelve `success: true`.
  3. En caso de stock agotado o límite alcanzado, emitir sonido/notificación de advertencia sin confirmar falso agregado.
  4. Mantener intacto el cooldown de cámara (1500 ms) y permitir escaneos secuenciales rápidos desde lectores USB de código de barras.

### M05. Favoritos del Cajero (`src/views/POS.tsx` y `src/utils/posUiPreferences.ts`)
- **Problema**: No existe forma de fijar los artículos de alta rotación para acceder a ellos sin tipear en el buscador.
- **Acciones**:
  1. Crear el utilitario `posUiPreferences.ts` para persistir arrays de `product_id` en `localStorage` bajo claves seguras por usuario (`gtr_favs_<userId>`).
  2. Agregar pestaña destacada "★ Favoritos" al inicio del carrusel de categorías en el POS.
  3. Añadir botón de estrella accesible en cada tarjeta de producto (marcar/desmarcar con un solo toque sin alterar el carrito ni emitir llamadas de red).
  4. Filtrar reactivamente los IDs favoritos contra el catálogo activo en memoria (`products`), descartando productos inexistentes o eliminados.

### M06. Filtros de Inventario Combinables (`src/views/Inventory.tsx`)
- **Problema**: El selector de categorías se mezcla con el estado de stock impidiendo filtrar simultáneamente, por ejemplo, "Memorias" que estén "Sin stock".
- **Acciones**:
  1. Separar el estado en dos controles independientes:
     - **Categoría**: "Todas", "Memorias", "Cargadores", etc.
     - **Disponibilidad**: "Todos", "Disponibles (>0)", "Bajo stock (<= alarma)", "Sin stock (<=0)".
  2. Permitir la combinación simultánea de Categoría + Estado de Stock + Búsqueda de texto (`filterAndRankProducts`).
  3. Añadir botón "Restablecer filtros" y contador dinámico de artículos filtrados vs total disponible.

### M07. Pedidos y Entregas con Información y Scroll Claros (`src/views/CuentasPorCobrarView.tsx`)
- **Problema**: La pestaña de pedidos pendientes sufre de scrolls anidados rígidos (`max-h: 62vh`) dificultando la lectura de destinos largos y la finalización en Android.
- **Acciones**:
  1. Eliminar cajas de scroll anidadas y permitir flujo natural con scroll principal en la tarjeta.
  2. Envolver nombres de clientes, destinos y transportadoras largas (`break-words`).
  3. Agrupar botones de acción: Ver documentos / Orden de almacén, Editar pedido, Registrar abono y Finalizar entrega, destacando la acción principal según el estado.

### M08. Historial y Detalle de Ticket Más Directos (`src/views/ExtraViews.tsx`)
- **Problema**: En dispositivos móviles, revisar los artículos de una venta pasada y reimprimir requiere maniobras complejas.
- **Acciones**:
  1. Optimizar el modal de detalle de venta en `HistorialVentasView`: cabecera con ticket #, fecha, cajero, método y tabla limpia de artículos.
  2. Botones de acción directos: Reimprimir PDF, Descargar Imagen de Comprobante y Compartir WhatsApp.
  3. Asegurar que al cerrar el detalle se conserve la posición de scroll y la lista de ventas previamente paginada.

### M09. Ticket Térmico Coherente en 58 mm y 80 mm (`src/views/POS.tsx`, `src/views/ExtraViews.tsx`, `src/views/ConfiguracionesView.tsx`, `src/views/CuentasPorCobrarView.tsx`)
- **Problema**: Varios generadores fijaban rígidamente `width = 80`, ignorando la configuración guardada de 58 mm; los textos largos se solapaban en comprobantes angostos.
- **Acciones**:
  1. Leer y respetar la opción de ancho de ticket (`58` u `80` mm) desde las configuraciones del sistema.
  2. Implementar para 58 mm el formato en dos líneas por artículo:
     - Línea 1: Nombre completo envuelto con `doc.splitTextToSize`.
     - Línea 2: `[cantidad] × Bs [precio_unitario] = Bs [subtotal]`.
  3. Calcular dinámicamente la altura del PDF (`doc.internal.pageSize`) sumando las líneas reales generadas, garantizando que tickets con 30 o 40 ítems nunca se corten ni solapen.
  4. Sincronizar la vista previa de `ConfiguracionesView` con el motor de impresión real.

### M10. Consistencia Visual, Modo Oscuro, RGB y Accesibilidad (`src/index.css`)
- **Problema**: Algunos botones con tema RGB activo pierden visibilidad en estado `disabled` o de error; textos pequeños (<12 px) en pantallas de alta densidad.
- **Acciones**:
  1. Estandarizar tamaños de fuente para lectura de operaciones a 13–14 px.
  2. Asegurar que clases como `disabled:opacity-40`, `cursor-not-allowed` y colores de advertencia prevalezcan incluso ante temas RGB con `!important`.
  3. Respetar media query `prefers-reduced-motion` para usuarios que requieren menor movimiento en transiciones.

---

## 3. Plan de Verificación y Aceptación
1. **Verificación Estática y de Tipos**:
   - Ejecutar `compile_applet` para garantizar cero errores de TypeScript y Vite.
2. **Pruebas Funcionales No Regresivas**:
   - Correr toda la suite de pruebas del servidor y seguridad:
     - `tests/test_audit_c227fa0_fixes.cjs`
     - `tests/check_kiosk_v2.cjs`
     - `tests/test_all_six_points.cjs`
     - `tests/txt_critical_fixes_runner.cjs`
     - `tests/audit_cycle_runner.cjs`
3. **Validación de la Matriz de Interfaz (V01-V10, C01-C07, P01-P07, E01-E04, F01-F06, H01-H05, T01-T07, A01-A04)**:
   - Crear un runner de pruebas automatizado para verificar:
     - Resolución del caso UI21 (agotado en escáner sin falso positivo).
     - Persistencia y aislamiento de favoritos por usuario.
     - Combinación de filtros de inventario (categoría + estado de stock).
     - Formato de 58 mm en dos líneas y respeto de `ticketWidth`.
