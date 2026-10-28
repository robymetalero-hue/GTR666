const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Open gtr_pos.db in readonly mode
const db = new Database('./gtr_pos.db', { readonly: true });

console.log("=== INSPECCIÓN DE SOLO LECTURA: gtr_pos.db ===");

// 1. Check Sale #398
const sale398 = db.prepare('SELECT * FROM sales WHERE id = 398').get();
console.log("\n[1] Venta #398:");
console.log(JSON.stringify(sale398, null, 2));

const items398 = db.prepare('SELECT * FROM sale_items WHERE sale_id = 398').all();
console.log(`\nLíneas de Venta #398: Total líneas = ${items398.length}`);
const items398QtySum = items398.reduce((sum, item) => sum + (item.quantity || 0), 0);
console.log(`Suma de cantidades de ítems en #398: ${items398QtySum}`);

// 2. Check Sales >= 399
const salesFrom399 = db.prepare(`
  SELECT s.id, s.created_at, s.total, s.currency, s.exchange_rate,
         s.payment_method, s.user_id, u.username, s.client_id,
         s.client_operation_id, s.cierre_id
  FROM sales s
  LEFT JOIN users u ON u.id = s.user_id
  WHERE s.id >= 399
  ORDER BY s.id
`).all();

console.log(`\n[2] Ventas >= 399 encontradas: ${salesFrom399.length}`);
salesFrom399.forEach(s => {
  console.log(`  ID #${s.id} | Fecha: ${s.created_at} | Total: ${s.total} ${s.currency} | User: @${s.username} (id: ${s.user_id}) | Método: ${s.payment_method} | OperID: ${s.client_operation_id}`);
});

// Check maximum sale ID in table
const maxSale = db.prepare('SELECT MAX(id) as max_id, COUNT(*) as total_sales FROM sales').get();
console.log(`\nTotal ventas en base: ${maxSale.total_sales}, Máximo ID: ${maxSale.max_id}`);

// 3. Inspect items for sales >= 399
const saleIds = salesFrom399.map(s => s.id);
if (saleIds.length > 0) {
  const placeholders = saleIds.map(() => '?').join(',');
  const items = db.prepare(`
    SELECT si.id, si.sale_id, si.product_id, si.quantity, si.price, p.name as product_name, p.sku, p.stock as current_stock
    FROM sale_items si
    LEFT JOIN products p ON p.id = si.product_id
    WHERE si.sale_id IN (${placeholders})
    ORDER BY si.sale_id, si.id
  `).all(...saleIds);
  console.log(`\n[3] Total ítems en ventas >= 399: ${items.length}`);
  items.forEach(it => {
    console.log(`  Sale #${it.sale_id} | Item #${it.id} | Prod #${it.product_id} (${it.sku} - ${it.product_name}) | Cant: ${it.quantity} | Precio: ${it.price} | Stock actual: ${it.current_stock}`);
  });

  // Check returns for these sales
  const returns = db.prepare(`
    SELECT * FROM sale_returns WHERE sale_id IN (${placeholders})
  `).all(...saleIds);
  console.log(`\n[4] Devoluciones asociadas a ventas >= 399: ${returns.length}`);

  // W15: Check cash movements using real cash_accounts schema (seller_id, seller_username, current_balance)
  const cashMovs = db.prepare(`
    SELECT cm.*, ca.id as cash_account_id, ca.seller_username, ca.current_balance
    FROM cash_movements cm
    LEFT JOIN cash_accounts ca ON ca.seller_id = cm.seller_id
    WHERE cm.sale_id IN (${placeholders})
  `).all(...saleIds);
  console.log(`\n[5] Movimientos de caja asociados a ventas >= 399: ${cashMovs.length}`);
  cashMovs.forEach(cm => {
    console.log(`  Mov #${cm.id} | Sale #${cm.sale_id} | Seller #${cm.seller_id} (@${cm.seller_username || 'N/A'}) | Tipo: ${cm.type} | Monto: ${cm.amount} ${cm.currency} | Saldo cuenta: ${cm.current_balance}`);
  });

  // Check accounts receivable
  const credits = db.prepare(`
    SELECT * FROM accounts_receivable WHERE sale_id IN (${placeholders})
  `).all(...saleIds);
  console.log(`\n[6] Cuentas por cobrar asociadas a ventas >= 399: ${credits.length}`);
}

db.close();
