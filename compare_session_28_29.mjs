import fs from 'fs';

const logs = JSON.parse(fs.readFileSync('inventory_count_system_logs.json', 'utf8'));
const products = JSON.parse(fs.readFileSync('firestore_products.json', 'utf8'));
const sales = JSON.parse(fs.readFileSync('firestore_sales.json', 'utf8'));
const saleItems = JSON.parse(fs.readFileSync('firestore_sale_items.json', 'utf8'));
const arrivals = JSON.parse(fs.readFileSync('firestore_arrivals.json', 'utf8'));

const prodMap = new Map();
products.forEach(p => prodMap.set(String(p.id), p));

// --- Extract Session 28 items ---
// Session 28: started 2026-10-17 13:45:28, completed 2026-10-17 14:10:58, approved 2026-10-17 14:49:58
const s28Logs = logs.filter(l => {
  const ts = l._tx_timestamp || l.created_at || '';
  return ts.includes('2026-10-17') && (l.event_type === 'INVENTORY_COUNT_ITEM_REVIEWED');
});

const s28Items = new Map();
s28Logs.forEach(l => {
  const pid = String(l.entity_id || l.related_product_id);
  let phys = l.quantity_after;
  if (phys === null || phys === undefined) {
    try {
      const parsed = JSON.parse(l.after_data || '{}');
      phys = parsed.physical_quantity;
    } catch {}
  }
  s28Items.set(pid, {
    product_id: pid,
    product_name: l.entity_name,
    physical: Number(phys),
    log_time: l._tx_timestamp || l.created_at
  });
});

console.log(`Session 28 unique items counted: ${s28Items.size}`);

// --- Extract Session 29 items ---
// Session 29: started 2026-10-23 14:09:30, completed 2026-10-23 14:59:26
const s29Logs = logs.filter(l => {
  const ts = l._tx_timestamp || l.created_at || '';
  return ts >= '2026-10-23T14:00:00' && ts <= '2026-10-23T15:10:00' && (l.event_type === 'INVENTORY_COUNT_ITEM_REVIEWED');
});

const s29Items = new Map();
s29Logs.forEach(l => {
  const pid = String(l.entity_id || l.related_product_id);
  let phys = l.quantity_after;
  if (phys === null || phys === undefined) {
    try {
      const parsed = JSON.parse(l.after_data || '{}');
      phys = parsed.physical_quantity;
    } catch {}
  }
  s29Items.set(pid, {
    product_id: pid,
    product_name: l.entity_name,
    physical: Number(phys),
    log_time: l._tx_timestamp || l.created_at
  });
});

console.log(`Session 29 unique items counted: ${s29Items.size}`);

// --- Sales between Session 28 (Oct 17 14:49:58) and Session 29 (Oct 23 14:59:26) ---
const salesBetween = sales.filter(s => {
  const d = s.created_at || '';
  return d >= '2026-10-17 14:50:00' && d <= '2026-10-23 15:00:00';
});
const saleIdsBetween = new Set(salesBetween.map(s => String(s.id)));

const itemsSoldBetween = new Map(); // pid -> total sold
saleItems.forEach(si => {
  if (saleIdsBetween.has(String(si.sale_id))) {
    const pid = String(si.product_id);
    const qty = Number(si.quantity || 0);
    itemsSoldBetween.set(pid, (itemsSoldBetween.get(pid) || 0) + qty);
  }
});

// --- Arrivals between Session 28 and Session 29 ---
const arrivalsBetween = arrivals.filter(a => {
  const d = a.created_at || '';
  return d >= '2026-10-17 14:50:00' && d <= '2026-10-23 15:00:00';
});
const itemsArrivedBetween = new Map(); // pid -> total arrived
arrivalsBetween.forEach(a => {
  const pid = String(a.product_id);
  const qty = Number(a.quantity || 0);
  itemsArrivedBetween.set(pid, (itemsArrivedBetween.get(pid) || 0) + qty);
});

// --- Compare each item in Session 29 ---
const report = [];
let totalDifference = 0;
let diffCount = 0;

s29Items.forEach((it29, pid) => {
  const prod = prodMap.get(pid) || {};
  const currentStock = Number(prod.stock ?? 0);
  const it28 = s28Items.get(pid);
  const counted28 = it28 ? it28.physical : null;
  const sold = itemsSoldBetween.get(pid) || 0;
  const arrived = itemsArrivedBetween.get(pid) || 0;

  // Theoretical expected stock at time of session 29 based on session 28 ledger:
  // Expected = Counted_in_28 + Arrived - Sold
  const expectedFromLedger = counted28 !== null ? (counted28 + arrived - sold) : null;
  
  // What POS had as live_stock / system_stock during session 29:
  // In session 29, difference = physical - expected
  // Let's compute difference vs current stock or vs expected:
  const diffVsCurrentStock = it29.physical - currentStock;

  const entry = {
    product_id: pid,
    sku: prod.sku || 'N/A',
    name: prod.name || it29.product_name,
    category: prod.category || 'N/A',
    was_in_session_28: it28 !== undefined,
    counted_session_28: counted28,
    sold_between_28_and_29: sold,
    arrived_between_28_and_29: arrived,
    expected_from_ledger: expectedFromLedger,
    counted_session_29: it29.physical,
    current_product_stock: currentStock,
    diff_vs_current: diffVsCurrentStock
  };

  report.push(entry);
});

// Filter items where counted_session_29 != expected_from_ledger OR diff_vs_current != 0
const discrepancies = report.filter(r => {
  if (r.expected_from_ledger !== null && r.counted_session_29 !== r.expected_from_ledger) return true;
  if (!r.was_in_session_28 && r.counted_session_29 !== 0) return true;
  if (r.diff_vs_current !== 0) return true;
  return false;
});

console.log(`\n=== DISCREPANCIES DETECTED: ${discrepancies.length} ===`);
discrepancies.forEach(d => {
  console.log(`SKU: ${d.sku} | ID: ${d.product_id} | Name: ${d.name}`);
  console.log(`  S28 Counted: ${d.counted_session_28} | Sold: ${d.sold_between_28_and_29} | Arrived: ${d.arrived_between_28_and_29} | Expected Ledger: ${d.expected_from_ledger}`);
  console.log(`  S29 Counted: ${d.counted_session_29} | Current Stock: ${d.current_product_stock} | Diff vs Stock: ${d.diff_vs_current}`);
});

// Products in 29 but not in 28
const phantomProducts = report.filter(r => !r.was_in_session_28);
console.log(`\n=== PRODUCTS IN S29 BUT NOT IN S28 (${phantomProducts.length} items) ===`);
phantomProducts.forEach(p => {
  console.log(`SKU: ${p.sku} | ID: ${p.product_id} | Name: ${p.name} | S29 Counted: ${p.counted_session_29} | Current Stock: ${p.current_product_stock}`);
});

fs.writeFileSync('audit_comparison_report.json', JSON.stringify({ discrepancies, phantomProducts, fullReport: report }, null, 2));
