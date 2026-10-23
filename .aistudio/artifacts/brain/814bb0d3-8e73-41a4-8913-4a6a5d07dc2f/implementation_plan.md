# GTR666 — Plan de Implementación: Fase 1 (Navegación General y Usabilidad Responsiva)

Plan quirúrgico para la Fase 1 del proyecto de optimización responsiva en GTR POS (`robymetalero-hue/GTR666`), respetando estrictamente la inmutabilidad de bases de datos, APIs, reglas comerciales, permisos y lógica operativa existente.

---

## Decisiones Confirmadas por el Usuario

1. **Celulares Verticales**:
   - Barra de navegación inferior fija ergonómica para acceso rápido con el pulgar a las vistas principales (Inicio, POS, Historial, Inventario/Cajas, Más).
   - Encabezado superior compacto con branding, estado de conexión (OfflineStatusHUD), cambio de tema y acceso a IA.
2. **Tabletas (768px a 1024px)**:
   - Barra lateral colapsable a barra delgada de iconos (~68px de ancho) con botón de alternar (toggle) para maximizar el área de trabajo en pantallas táctiles medianas sin perder acceso visual.

---

## Alcance Detallado de la Fase 1

### 1. Optimizaciones en `src/index.css`
- **Soporte de Viewport Dinámico (`100dvh`)**:
  - Prevenir saltos de altura y desbordamientos cuando el teclado virtual aparece en iOS/Android.
- **Áreas Táctiles Mínimas (Regla de 44px)**:
  - Garantizar que botones de acción, interruptores y campos de entrada tengan un target táctil mínimo de 44px o clase táctil ergonómica sin inflar visualmente el diseño.
- **Contención de Desplazamiento Horizontal**:
  - Reglas estrictas contra scroll horizontal involuntario en el contenedor principal (`overflow-x: hidden`).
- **Adaptación Paisaje (Landscape) para Móviles**:
  - Clases utilitarias para detectar pantallas de baja altura (`@media (max-height: 500px)`) para reducir alturas de encabezados y márgenes.

### 2. Optimizaciones en `src/App.tsx`
- **Barra de Navegación Inferior (Mobile Bottom Bar)**:
  - Visible en pantallas móviles (`< 768px` o `< lg` cuando no se use sidebar).
  - Incluye accesos directos con micro-animaciones según permisos del usuario:
    - `Inicio`
    - `POS (Punto de Venta)` (botón central destacado)
    - `Historial` (o `CxC` según rol)
    - `Inventario` (o `Cajas` según rol)
    - `Menú / Más` (abre el panel desplegable completo hacia arriba o modal con animación suave).
  - En modo horizontal móvil (`landscape` con altura `< 500px`), se oculta automáticamente o se compacta para priorizar el catálogo y datos.
- **Sidebar Adaptable para Tabletas (`768px - 1024px` y Desktop)**:
  - Estado `sidebarCollapsed` con memoria en `localStorage`.
  - Cuando está colapsada: ancho de `68px`, mostrando los iconos centrados con badges e indicadores activos, ganando casi 200px de espacio horizontal para tablas y catálogos.
  - Cuando está expandida: ancho de `260px` con texto completo y agrupaciones.
  - Botón de alternancia sutil en el pie o encabezado del sidebar.
- **Encabezado Superior Compacto**:
  - Reducción de altura a 44px–48px en móviles y 40px en landscape móvil (`max-height: 500px`).
  - Botones táctiles accesibles con espacio adecuado entre sí (sin superposición de botones de tema, IA y menú).
- **Banners Informativos Adaptables**:
  - El banner de sandbox y avisos administrativos se adaptan con `flex-wrap` y padding compacto para no ocupar más del 15% de la pantalla en dispositivos pequeños.
- **Padding Inferior del Contenido**:
  - En móviles con bottom bar activa, agregar un padding inferior seguro (`pb-16` / `pb-[calc(4rem+env(safe-area-inset-bottom))]`) al contenedor de vistas para que ningún botón de acción (como el total o botón de cobro) quede tapado.

---

## Matriz de Verificación Obligatoria de Fase 1

| Dispositivo / Orientación | Resolución | Aspectos a Verificar |
|---|---|---|
| Celular Compacto (Vertical) | 360 × 800 | Bottom bar ergonómica, header compacto, menú completo abre sin desbordar |
| Celular Estándar (Vertical) | 390 × 844 | Safe-area inferior, navegación fluida entre POS e Inicio, sin scroll horizontal |
| Celular (Horizontal / Landscape) | 800 × 360 | Altura máxima aprovechada, header ultra compacto, sin bloqueos de pantalla |
| Celular Grande (Horizontal) | 844 × 390 | Contenido legible, controles accesibles, navegación utilizable |
| Tableta (Vertical) | 768 × 1024 | Sidebar colapsable en modo compacto de iconos, ganancia de espacio |
| Tableta (Horizontal) | 1024 × 768 | Sidebar expandible/colapsable fluido, área de trabajo amplia |
| Laptop / Desktop | 1366 × 768 | Sidebar estándar, espaciado cómodo, navegación por teclado y mouse |
| Monitor Full HD | 1920 × 1080 | Jerarquía visual nítida, sin estiramientos extraños ni pérdida de escala |

---

## Restricciones Inmutables
- CERO cambios en bases de datos, SQLite, Firestore o endpoints backend.
- CERO cambios en lógica comercial, tipo de cambio, permisos o cálculos matemáticos.
- Verificación limpia con `npm run lint` y `npm run build`.
