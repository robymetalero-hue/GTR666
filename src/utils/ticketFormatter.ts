// Helper de geometría y formateo para tickets térmicos (M09)
// Soporta anchos de 58 mm y 80 mm con cálculo dinámico de altura y desglose en 2 líneas para 58 mm

import type { jsPDF } from 'jspdf';

export interface TicketItemData {
  name: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  currency: 'BOB' | 'USD';
  sku?: string;
}

export function calculateDynamicTicketHeight(
  items: Array<{ name: string }>,
  options: {
    width: number;
    ml?: number;
    headerLines?: number;
    hasClient?: boolean;
    hasNotes?: boolean;
    notesLines?: number;
    hasPaymentMethod?: boolean;
    footerLines?: number;
  }
): number {
  const width = options.width || 80;
  const is58mm = width <= 62;
  const ml = options.ml || (is58mm ? 4 : 6);
  const printableWidth = width - (ml * 2);

  // Base lines: logo, title, date, cashier, dividers, total, footer
  let lineCount = 10;
  lineCount += options.headerLines || 3;
  if (options.hasClient) lineCount += 2;
  if (options.hasPaymentMethod) lineCount += 2;
  if (options.hasNotes) lineCount += (options.notesLines || 2) + 1;
  lineCount += options.footerLines || 3;

  // Item lines
  items.forEach(it => {
    const maxCharsPerLine = is58mm ? 24 : 36;
    const nameLen = (it.name || '').length;
    const nameLines = Math.max(1, Math.ceil(nameLen / maxCharsPerLine));
    // In 58mm, add 1 extra line for the quantity × price = subtotal row
    lineCount += is58mm ? (nameLines + 1) : nameLines;
  });

  const lineHeightMm = is58mm ? 3.8 : 4.2;
  return Math.max(is58mm ? 100 : 120, Math.round(lineCount * lineHeightMm) + 25);
}

export function drawTicketItem(
  doc: jsPDF,
  item: TicketItemData,
  startY: number,
  options: {
    width: number;
    ml: number;
    mr: number;
    font: string;
    fontSize?: number;
    showSku?: boolean;
  }
): number {
  const { width, ml, mr, font } = options;
  const is58mm = width <= 62;
  let y = startY;
  const baseFontSize = options.fontSize || (is58mm ? 8 : 8.5);

  const currSymbol = item.currency === 'USD' ? '$' : 'Bs.';
  const unitPriceStr = `${currSymbol} ${item.unitPrice.toFixed(2)}`;
  const subtotalStr = `${currSymbol} ${item.subtotal.toFixed(2)}`;

  if (is58mm) {
    // FORMATO 58 MM EN 2 LÍNEAS (Recomendado):
    // Línea 1: Nombre envuelto completo
    doc.setFont(font, "bold");
    doc.setFontSize(baseFontSize);
    const maxNameWidth = mr - ml;
    const wrappedName = doc.splitTextToSize(item.name || 'Producto', maxNameWidth);
    
    wrappedName.forEach((line: string) => {
      doc.text(line, ml, y);
      y += 3.6;
    });

    // Línea 2: Desglose [CANT] × [P.UNIT] = [SUBTOTAL]
    doc.setFont(font, "normal");
    doc.setFontSize(baseFontSize - 0.5);
    const detailText = `${item.quantity} × ${unitPriceStr}`;
    doc.text(detailText, ml + 2, y);

    doc.setFont(font, "bold");
    doc.text(subtotalStr, mr, y, { align: 'right' });
    y += 4.0;
  } else {
    // FORMATO 80 MM TABULAR
    doc.setFontSize(baseFontSize);
    doc.setFont(font, "bold");
    doc.text(`${item.quantity}x`, ml, y);

    doc.setFont(font, "normal");
    const detailX = ml + 9;
    const colPriceX = mr;
    const maxNameWidth = mr - detailX - 22;
    const wrappedName = doc.splitTextToSize(item.name || 'Producto', maxNameWidth);

    const firstLine = wrappedName[0] || "";
    doc.text(firstLine, detailX, y);

    doc.setFont(font, "bold");
    doc.text(subtotalStr, colPriceX, y, { align: 'right' });
    y += 4.0;

    if (wrappedName.length > 1) {
      doc.setFont(font, "normal");
      for (let i = 1; i < wrappedName.length; i++) {
        doc.text(wrappedName[i], detailX, y);
        y += 3.6;
      }
    }
  }

  return y;
}
