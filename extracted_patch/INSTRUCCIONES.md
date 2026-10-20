# GTR666 — Redondeo comercial de cobros en bolivianos (parche acotado)

**Base verificada:** `robymetalero-hue/GTR666`, rama `main`, commit `f8ce7687d9f993a2650adb26c6537aba45702f49` (archivo `src/views/POS.tsx` SHA Git `3f0322536734335c57d9ae50ea451eb03cc3d605`; `server.ts` SHA `5d71a0d147a4241b83adaaeb5c8949698c410985`).

## Regla solicitada

Redondear el precio **en Bs al mostrarlo/cobrarlo desde POS** al múltiplo de Bs 0,50 más cercano:

- fracción 0,00–0,24 → 0,00
- fracción 0,25–0,74 → 0,50
- fracción 0,75–0,99 → sumar 1,00.

Ejemplos: Bs 10,20 → 10,00; 10,25 → 10,50; 10,74 → 10,50; 10,75 → 11,00.

## Alcance deliberadamente restringido

El parche toca solo `server.ts` (validación de precios/totales de POS), `src/views/POS.tsx` y **añade** `src/utils/roundCashBs.ts` más `tests/test_roundCashBs.ts`. No toca esquema de base de datos, inventario, costos USD, tipo de cambio, Kárdex, Firestore, caja ni ventas históricas. La función `roundBs` general del resto de la aplicación conserva dos decimales. El POS redondea los precios BOB, descuentos y total final; USD utiliza precios USD originales con dos decimales, sin redondeo BOB.

**Advertencia:** Los recibos históricos y flujos de ventas pendientes/offline tienen rutas propias; no afirmar que todos están validados sin pruebas de integración. El parche aplica el cálculo a las ventas nuevas desde el POS. La modificación no arregla por sí sola otras vulnerabilidades de seguridad encontradas en GTR666.

## Aplicación únicamente en rama de pruebas

```bash
git checkout main
git pull --ff-only
git rev-parse HEAD   # confirmar f8ce7687...; si no coincide, volver a revisar compatibilidad
git checkout -b fix/redondeo-bolivianos-050
git apply --check GTR666_redondeo_Bs050_solo_POS.patch
git apply GTR666_redondeo_Bs050_solo_POS.patch
```

Si `git apply --check` falla, **NO** reescribir archivos completos, no forzar el parche ni aplicarlo a producción. Revisar diferencias del commit actualizado y adaptar únicamente los hunks incompatibles.

## Pruebas mínimas

```bash
node --experimental-strip-types tests/test_roundCashBs.ts  # Node 22.16+
npm run lint
npm run build
```

Pruebas de integración con SQLite **aislada**, usuarios vendedor/admin y stock ficticio:

1. Confirmar todos los límites de redondeo: 0,20→0,00; 0,25→0,50; 0,74→0,50; 0,75→1,00.
2. Producto unitario en Bs y precio por mayor convertido desde USD; visualización, carrito, ticket, caja y backend consistentes.
3. Total con varios productos y cantidades, descuento fijo, descuento porcentual y canje de puntos.
4. Cambio a USD: precios, importes de venta, descuentos, ticket y servidor usan centavos USD sin aplicar Bs 0,50.
5. Vendedor no puede introducir un precio BOB no redondeado mediante petición a `/api/sales`.
6. Venta online, venta de contingencia offline aprobada, registro de caja, impresión/reimpresión de tickets y redondeo del vuelto.
7. No cambia ninguna venta pasada ni precios/costos de producto almacenados en SQLite.
8. Si se encuentra un caso que no cuadra en ticket, cotización USD o centavos, detener despliegue y documentar el escenario.

**Estado real:** comprobada sintaxis TS/TSX de las piezas cambiadas, comprobados 19 ejemplos del algoritmo y verificado `git apply --check` contra el POS idéntico a GitHub y bloques de servidor reconstruidos a partir de GitHub. **No ejecutadas** compilación completa, pruebas HTTP, pagos, pruebas Android ni despliegue, por carecer de una instancia completa con dependencias y base de datos de pruebas. Las 26 pruebas de seguridad anteriores no demuestran este redondeo.

El conector GitHub rechazó crear una rama (`403 Resource not accessible by integration`). Por eso se entrega un parche aplicable manualmente: **no se ha modificado GitHub ni producción**.
