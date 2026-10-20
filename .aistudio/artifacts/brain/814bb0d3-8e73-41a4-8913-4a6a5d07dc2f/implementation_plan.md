# GTR666 — Corrección Puntual de Históricos Financieros y Tipo de Cambio

Plan de corrección quirúrgica para garantizar la inmutabilidad y consistencia de precios vendidos, costos históricos, monedas, tipos de cambio y utilidades en el sistema de punto de venta en producción GTR666 (`robymetalero-hue/GTR666`).

---

## Decisiones Críticas y Confirmaciones del Usuario

> [!IMPORTANT]
> A continuación se resumen los criterios comerciales y monetarios confirmados por el usuario para resolver las divergencias detectadas:

- **Costos históricos faltantes en ventas antiguas**: Los registros anteriores que carezcan de costo unitario en `sale_items.cost` se **excluyen del cálculo de utilidad neta** en `/api/dashboard`, en lugar de proyectar silenciosamente el `products.price_cost` vigente ni inventar costos ficticios.
- **Moneda y tasa en devoluciones**: En devoluciones de ventas realizadas en dólares (`USD`), el reembolso se efectúa en la **moneda original utilizando el tipo de cambio histórico registrado en la venta (`sales.exchange_rate`)**, reflejando la deducción adecuada en bolivianos en el saldo de caja (`cash_accounts`).
- **Sincronización de ventas offline**: Al sincronizarse una venta originada en modo offline, se **asigna la tasa oficial del servidor al momento de la sincronización** y se almacena como snapshot permanente e inalterable.
- **Redondeo comercial y precios POS**: Se preserva estrictamente el redondeo comercial a Bs 0,50 para pagos en efectivo en bolivianos y los precios de lista originales en USD. No se modifican esquemas de base de datos ni comprobantes emitidos.

---

## 1. Alcance y Objetivos de la Corrección

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                        FLUJO DE INMUTABILIDAD FINANCIERA                         │
└───────────────────────────────────────────────────────────────────────────────────┘

 [Venta Online POS] ────► Validación vs. Settings Server ────► Snapshot: sales.exchange_rate
 [Venta Offline]    ────► Asignación Tasa Oficial al Sync ───► Snapshot: sales.exchange_rate
                                                                      │
         ┌────────────────────────────────────────────────────────────┴──────────────────────────┐
         ▼                                                            ▼                          ▼
 ┌───────────────┐                                            ┌───────────────┐          ┌───────────────┐
 │ Cajas & Heals │                                            │   Dashboard   │          │  Devoluciones │
 ├───────────────┤                                            ├───────────────┤          ├───────────────┤
 │ Convierte USD │                                            │ Utilidad real │          │ Reembolso a   │
 │ con s.rate    │                                            │ items - desc  │          │ tasa original │
 └───────────────┘                                            │ - devueltos   │          │ sin mutar sale│
                                                              └───────────────┘          └───────────────┘
```

1. **Inmutabilidad de ventas y auditoría**: Ninguna venta previa mutará su total, moneda o tipo de cambio ante modificaciones futuras en `/api/settings/exchange-rate` o `/api/products`.
2. **Caja y Arqueos Coherentes**: Eliminar reconversiones arbitrarias con la tasa vigente en `selfHealCashAccounts()` y `CajasView.tsx`, asegurando que cada movimiento USD use el tipo de cambio del ticket asociado.
3. **Métricas Consolidadas sin Mezcla de Divisas**: En vistas analíticas (`ExtraViews.tsx`), sumar ventas en bolivianos consolidando cada ticket USD con su respectiva tasa histórica antes de acumular.
4. **Métricas de Utilidad Verídicas**: Excluir registros antiguos sin costo, descontar `sales.discount` e incorporar devoluciones sin inventar costos actuales.

---

## 2. Puntos Críticos y Modificaciones por Módulo

### 1. Tipo de Cambio y Caja (`server.ts` & `src/views/CajasView.tsx`)
- **`server.ts` (`selfHealCashAccounts`)**:
  - Reemplazar la conversión global `amtInBs = m.currency === 'USD' ? (m.amount * currentRate) : m.amount` por un `LEFT JOIN sales s ON m.sale_id = s.id` para obtener `s.exchange_rate`.
  - Si un movimiento USD tiene ticket asociado, utilizar `s.exchange_rate`. Si es un movimiento manual sin venta, utilizar la tasa guardada en el propio movimiento o registro histórico, evitando revaluar con la tasa actual.
  - No sobrescribir arbitrariamente saldos auditados ni generar disparidades artificiales.
- **`src/views/CajasView.tsx` (`calculateMethodTotals`)**:
  - En la función `calculateMethodTotals()`, no aplicar `exchangeRate` global del contexto a movimientos USD. Emplear `m.sale_exchange_rate || m.exchange_rate || 6.96` para calcular el desglose por método en Bs.

### 2. Registro de Ventas (`server.ts` - `POST /api/sales`)
- **Validación de tasa oficial**:
  - Leer la tasa de cambio vigente oficial de la tabla `settings` (`exchange_rate`).
  - Para ventas online, verificar que la tasa enviada por el cliente coincida con la oficial del servidor (tolerancia de centésimas). Si no se envía o difiere por desactualización, fijar la tasa oficial del servidor.
  - Para ventas offline recibidas en cola de sincronización, asignar la tasa oficial vigente al momento de sincronizar y registrarla permanentemente en `sales.exchange_rate`.
  - Asegurar que la tasa guardada quede congelada como snapshot para toda la vida del registro.

### 3. Historial de Ventas y Analítica (`src/views/ExtraViews.tsx`)
- **Consolidación en `VentasView` (Líneas 409-418)**:
  - `totalEarnings`: Convertir cada venta en USD con `s.currency === 'USD' ? (s.total * (s.exchange_rate || 1)) : s.total` antes de sumar.
  - `totalDiscounts`: Convertir descuentos en USD con `s.exchange_rate`.
  - `totalCapital`: Sumar costos de items convirtiendo a Bs con la tasa del ticket respectivo.
- **Consolidación en `AnalisisView` (Líneas 2395-2450)**:
  - `cashTotal`, `cardTotal`, `transferTotal`, `totalRevenue`, `salesByDay` y `hourlySales`: computar el monto en bolivianos de cada venta aplicando `s.total * s.exchange_rate` si `s.currency === 'USD'`.
  - Mantener intactas las divisas y montos nominales en los comprobantes y tablas de tickets individuales.

### 4. Utilidades en Dashboard (`server.ts` - `/api/dashboard`)
- **Cálculo de utilidad histórica en `todayProfit`, `periodProfitRow`, `prevProfitRow` y `topProducts`**:
  - Excluir del cómputo de ganancia aquellos `sale_items` donde `si.cost IS NULL` o `si.cost = 0` para ventas antiguas sin costo registrado (según confirmación del usuario), en lugar de usar `COALESCE(si.cost, p.price_cost, 0)` que distorsiona el histórico con precios del inventario actual.
  - Incorporar la deducción del descuento otorgado (`sales.discount`), el cual estaba omitido en las utilidades.
  - Deducir las devoluciones registradas en `sale_returns` para el período evaluado.

### 5. Devoluciones Monetarias (`server.ts` - `POST /api/sales/refund`)
- **Conversión de reembolso coherente con la venta original**:
  - Obtener `originalSale.currency` y `originalSale.exchange_rate`.
  - Si la venta fue en USD, registrar el movimiento de caja en `USD` por el monto nominal devuelto (`-totalRefundAmount`).
  - Al descontar del saldo acumulado de caja del cajero (`cash_accounts.current_balance`, que opera en BOB), descontar el monto equivalente convertido con `originalSale.exchange_rate`, impidiendo el descuadre donde se restaban dólares directamente de una bolsa en bolivianos.

### 6. Historiales Visuales en Inventario (`src/views/Inventory.tsx`)
- **Trazabilidad auditada y logs**:
  - En el modal de trazabilidad de tickets (`traceTicketDetails`), usar `traceTicketDetails.exchange_rate` de la propia venta para cualquier conversión referencial, nunca la tasa vigente del contexto global.
  - En `renderProductHistoryLogs`, no reconvertir precios históricos de salidas de inventario (`log.price`) multiplicándolos por el tipo de cambio del día actual. Presentar la divisa y valor original de la operación.

---

## 3. Plan de Pruebas y Verificación en Base Aislada

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                    MATRIZ DE PRUEBAS EN ENTORNO AISLADO                          │
└───────────────────────────────────────────────────────────────────────────────────┘

 1. Venta A (Tasa 10.00) ──► Registrar en USD ──► Modificar Tasa a 11.00 ──► Venta A intacta
 2. Venta B (Tasa 11.00) ──► Registrar en BOB ──► Modificar Tasa a 12.00 ──► Ventas A y B intactas
 3. Devolución Parcial   ──► Reembolsar Venta A ──► Verificar descuento en caja a Tasa 10.00
 4. Dashboard KPIs       ──► Verificar que ventas sin costo queden excluidas de utilidades
 5. Cajas & Arqueo       ──► Desglose de métodos cuadra sin mutar por variaciones de tasa
```

1. **Prueba de inmutabilidad multi-tasa (10, 11 y 12)**:
   - Configurar tipo de cambio en 10.00 BOB/USD y registrar Venta 1 ($10 USD).
   - Modificar precios de catálogo y cambiar tipo de cambio a 11.00 BOB/USD. Registrar Venta 2 ($10 USD).
   - Cambiar tipo de cambio a 12.00 BOB/USD. Registrar Venta 3 (100 BOB).
   - Comprobar que Venta 1 conserva `exchange_rate = 10.00`, equivalente 100 BOB; Venta 2 conserva `exchange_rate = 11.00`, equivalente 110 BOB.
2. **Prueba de devolución en divisas**:
   - Devolver 1 unidad de la Venta 1 ($10 USD).
   - Verificar que `cash_accounts.current_balance` deduce exactamente 100 BOB (a tasa 10), no 120 BOB ni 10 BOB.
3. **Prueba de exclusión de costo nulo**:
   - Insertar un registro histórico de prueba con `cost = NULL`.
   - Verificar que `/api/dashboard` no use el costo actual de catálogo ni arroje márgenes distorsionados.
4. **Verificación de build y compilación**:
   - Ejecutar `tsc --noEmit` y `npm run build` sin advertencias ni regresiones.
