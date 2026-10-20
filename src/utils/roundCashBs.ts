/**
 * Redondeo comercial de cobros en BOLIVIANOS a incrementos de Bs. 0,50.
 * [0,00..0,24] -> 0,00; [0,25..0,74] -> 0,50; [0,75..0,99] -> 1,00.
 * No utilizar para precios/costos en USD, tipo de cambio ni cantidades.
 */
export function roundCashBs(amount: number): number {
  if (!Number.isFinite(amount)) return 0;
  return Math.round((amount + Number.EPSILON) * 2) / 2;
}
