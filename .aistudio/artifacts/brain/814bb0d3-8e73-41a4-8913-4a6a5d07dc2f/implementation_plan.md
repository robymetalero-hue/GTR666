# Plan de Implementación: Redondeo Comercial Estricto a Bs. 0,50 en POS

## Contexto y Decisión
El usuario ha solicitado aplicar de forma estricta la política comercial contenida en el parche `GTR666_redondeo_Bs050_para_AI_Studio_c96e84ca.zip` para **todos los pagos en bolivianos** procesados en el mostrador POS.

La regla de redondeo es:
$$\text{roundCashBs}(x) = \frac{\text{round}((x + \varepsilon) \times 2)}{2}$$
- Fracciones $[0{,}00 \dots 0{,}24] \to 0{,}00$ (ej. Bs. 10,20 $\to$ Bs. 10,00)
- Fracciones $[0{,}25 \dots 0{,}74] \to 0{,}50$ (ej. Bs. 10,25 $\to$ Bs. 10,50; Bs. 10,70 $\to$ Bs. 10,50)
- Fracciones $[0{,}75 \dots 0{,}99] \to 1{,}00$ (ej. Bs. 10,80 $\to$ Bs. 11,00)

Precios y cobros en **USD** continúan operando con centavos estándar (2 decimales exactos).

---

## Fases de Implementación

### Fase 1: Creación de la Utilidad y Pruebas Unitarias
1. **Archivo `src/utils/roundCashBs.ts`**:
   - Crear función pura `roundCashBs(amount: number): number`.
   - Garantizar que devuelva múltiplos exactos de 0,50 para cualquier valor finito y 0 para valores no válidos.
2. **Archivo `tests/test_roundCashBs.ts`**:
   - Incorporar la suite de 19 pruebas de límites de redondeo (0,20 $\to$ 0; 0,25 $\to$ 0,5; 0,74 $\to$ 0,5; 0,75 $\to$ 1, etc.).

### Fase 2: Adaptación del Frontend (`src/views/POS.tsx`)
1. Importar `roundCashBs as roundBs` desde `../utils/roundCashBs`.
2. Aplicar `roundBs` en:
   - Precios mostrados en sugerencias de autocompletado y búsqueda rápida.
   - Cálculo de precio unitario en Bs en el carrito (`getCartItemPriceBs`).
   - Precios personalizados ingresados manualmente en Bs.
   - Cálculo de descuentos en bolivianos (`discountValue`).
   - Cálculo del total del carrito en bolivianos (`total`).
3. Separar `usdSubtotal` y `usdTotal` para preservar los precios exactos en USD del catálogo sin contaminarse con el redondeo de 50 centavos bolivianos.
4. Ajustar la impresión de tickets y modal de confirmación para imprimir el subtotal en USD exacto cuando la venta sea en dólares, y el redondeado en Bs cuando sea en bolivianos.

### Fase 3: Sincronización del Servidor (`server.ts`)
1. Incorporar la función `roundCashBs` en `server.ts`.
2. En `POST /api/sales`:
   - Validar que los precios unitarios y mayoristas en bolivianos coincidan estrictamente con `roundCashBs(unitUSD * currentRate)` o `roundCashBs(bulkUSD * currentRate)`.
   - Rechazar precios con centavos fraccionarios no redondeados en BOB (tolerancia estricta de 0,01).
   - Validar que el total enviado coincida exactamente con `roundCashBs(expectedTotal)` en BOB.
   - Mantener tolerancia de centavos para ventas en USD.

### Fase 4: Verificación y Calidad
1. Ejecutar `tests/test_roundCashBs.ts` para validar los 19 casos de prueba.
2. Actualizar y correr `tests/test_all_six_points.cjs` para asegurar que las ventas legítimas con redondeo a 0,50 se aprueben y las ventas manipuladas se rechacen (cero regresiones).
3. Ejecutar `compile_applet` y `lint_applet` para garantizar que la compilación de TypeScript sea 100% limpia.
4. Mantener los cambios en la rama de pruebas `test-security-patch` sin alterar producción ni publicar reglas de Firestore.
