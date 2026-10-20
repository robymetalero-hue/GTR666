/** Pruebas unitarias del redondeo comercial en Bs. sin base de datos. */
import assert from 'node:assert/strict';
import { roundCashBs } from '../src/utils/roundCashBs.ts';

const cases: Array<[number, number]> = [
  [0, 0], [0.15, 0], [0.20, 0], [0.24, 0],
  [0.25, 0.5], [0.26, 0.5], [0.50, 0.5], [0.74, 0.5],
  [0.75, 1], [0.76, 1], [0.99, 1],
  [10.20, 10], [10.25, 10.5], [10.74, 10.5], [10.75, 11],
  [125.24, 125], [125.25, 125.5], [125.74, 125.5], [125.75, 126]
];
for (const [input, expected] of cases) {
  assert.equal(roundCashBs(input), expected, `Bs. ${input} => Bs. ${expected}`);
}
console.log(`PASS: ${cases.length} pruebas de redondeo de bolivianos`);
