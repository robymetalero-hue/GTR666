import fs from 'fs';

const products = JSON.parse(fs.readFileSync('firestore_products.json', 'utf8'));
const allAuditLogs = JSON.parse(fs.readFileSync('firestore_audit_logs.json', 'utf8'));
const arrivals = JSON.parse(fs.readFileSync('firestore_arrivals.json', 'utf8'));
const sales = JSON.parse(fs.readFileSync('firestore_sales.json', 'utf8'));
const saleItems = JSON.parse(fs.readFileSync('firestore_sale_items.json', 'utf8'));
const comparison = JSON.parse(fs.readFileSync('audit_comparison_report.json', 'utf8'));

const diffs = comparison.discrepancies.filter(d => d.diff_vs_current !== 0);

console.log('Generating detailed audit for the 11 difference items...\n');

const detailedAudit = diffs.map(d => {
  const pid = String(d.product_id);
  const prod = products.find(p => String(p.id) === pid);

  // All sales for this product
  const pSaleItems = saleItems.filter(si => String(si.product_id) === pid);
  // Sales between S28 and S29
  const pSalesBetween = d.sold_between_28_and_29;

  // Arrivals
  const pArrivals = arrivals.filter(a => String(a.product_id) === pid);

  // Audit logs
  const pLogs = allAuditLogs.filter(l => String(l.product_id) === pid);

  return {
    product_id: pid,
    sku: d.sku,
    name: d.name,
    category: d.category,
    s28_counted: d.counted_session_28,
    s29_counted: d.counted_session_29,
    current_stock: d.current_product_stock,
    difference: d.diff_vs_current,
    sold_between_28_and_29: pSalesBetween,
    arrived_between_28_and_29: d.arrived_between_28_and_29,
    expected_from_ledger: d.expected_from_ledger,
    recent_sales_details: pSaleItems.slice(-3).map(si => ({ sale_id: si.sale_id, qty: si.quantity })),
    arrivals_count: pArrivals.length,
    audit_logs_count: pLogs.length
  };
});

fs.writeFileSync('detailed_11_differences.json', JSON.stringify(detailedAudit, null, 2));
console.log(JSON.stringify(detailedAudit, null, 2));
