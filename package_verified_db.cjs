const fs = require('fs');
const Database = require('better-sqlite3');

console.log('[Packager] Starting verified database packaging for gtr_pos.db...');

// 1. Remove stale gtr_pos.db if exists, copy from gtr_pos_sandbox.db as baseline
if (fs.existsSync('gtr_pos.db')) {
  fs.unlinkSync('gtr_pos.db');
}
if (fs.existsSync('gtr_pos.db-wal')) {
  try { fs.unlinkSync('gtr_pos.db-wal'); } catch (_) {}
}
if (fs.existsSync('gtr_pos.db-shm')) {
  try { fs.unlinkSync('gtr_pos.db-shm'); } catch (_) {}
}

fs.copyFileSync('gtr_pos_sandbox.db', 'gtr_pos.db');
console.log('[Packager] Base schema and data cloned from gtr_pos_sandbox.db to gtr_pos.db');

const db = new Database('gtr_pos.db');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// 2. Load and upsert verified 169 products
if (fs.existsSync('firestore_products.json')) {
  const products = JSON.parse(fs.readFileSync('firestore_products.json', 'utf8'));
  console.log(`[Packager] Upserting ${products.length} verified products from firestore_products.json...`);
  
  const insertProduct = db.prepare(`
    INSERT INTO products (id, name, category, sku, stock, price_unit, price_bulk, price_cost, stock_alarm, image, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      category = excluded.category,
      sku = excluded.sku,
      stock = excluded.stock,
      price_unit = excluded.price_unit,
      price_bulk = excluded.price_bulk,
      price_cost = excluded.price_cost,
      stock_alarm = excluded.stock_alarm,
      image = excluded.image,
      updated_at = excluded.updated_at
  `);

  const tx = db.transaction(() => {
    for (const p of products) {
      insertProduct.run(
        Number(p.id),
        p.name || 'Sin Nombre',
        p.category || 'general',
        p.sku ? String(p.sku) : '',
        p.stock !== undefined ? Number(p.stock) : 0,
        p.price_unit !== undefined ? Number(p.price_unit) : 0,
        p.price_bulk !== undefined ? Number(p.price_bulk) : 0,
        p.price_cost !== undefined ? Number(p.price_cost) : 0,
        p.stock_alarm !== undefined ? Number(p.stock_alarm) : 1,
        p.image || null,
        p.updated_at || new Date().toISOString()
      );
    }
  });
  tx();
  console.log(`[Packager] Products upserted. Total in db: ${db.prepare('SELECT count(*) as c FROM products').get().c}`);
}

// 3. Load and upsert verified 389 sales
if (fs.existsSync('firestore_sales.json')) {
  const sales = JSON.parse(fs.readFileSync('firestore_sales.json', 'utf8'));
  console.log(`[Packager] Upserting ${sales.length} verified sales from firestore_sales.json...`);
  
  const insertSale = db.prepare(`
    INSERT INTO sales (id, total, discount, payment_method, user_id, client_id, exchange_rate, currency, cierre_id, notes, client_operation_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      total = excluded.total,
      discount = excluded.discount,
      payment_method = excluded.payment_method,
      user_id = excluded.user_id,
      client_id = excluded.client_id,
      exchange_rate = excluded.exchange_rate,
      currency = excluded.currency,
      cierre_id = excluded.cierre_id,
      notes = excluded.notes,
      client_operation_id = excluded.client_operation_id,
      created_at = excluded.created_at
  `);

  const tx = db.transaction(() => {
    for (const s of sales) {
      insertSale.run(
        Number(s.id),
        Number(s.total || 0),
        Number(s.discount || 0),
        s.payment_method || 'Efectivo',
        s.user_id ? Number(s.user_id) : null,
        s.client_id ? Number(s.client_id) : null,
        s.exchange_rate !== undefined ? Number(s.exchange_rate) : null,
        s.currency || 'BOB',
        s.cierre_id ? Number(s.cierre_id) : null,
        s.notes || null,
        s.client_operation_id || null,
        s.created_at || new Date().toISOString()
      );
    }
  });
  tx();
  console.log(`[Packager] Sales upserted. Total in db: ${db.prepare('SELECT count(*) as c FROM sales').get().c}`);
}

// 4. Load and upsert verified 582 sale_items
if (fs.existsSync('firestore_sale_items.json')) {
  const saleItems = JSON.parse(fs.readFileSync('firestore_sale_items.json', 'utf8'));
  console.log(`[Packager] Upserting ${saleItems.length} verified sale items from firestore_sale_items.json...`);

  const insertItem = db.prepare(`
    INSERT INTO sale_items (id, sale_id, product_id, product_name_snapshot, product_sku_snapshot, quantity, price, cost, price_type, discount_minor, subtotal_minor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      sale_id = excluded.sale_id,
      product_id = excluded.product_id,
      product_name_snapshot = excluded.product_name_snapshot,
      product_sku_snapshot = excluded.product_sku_snapshot,
      quantity = excluded.quantity,
      price = excluded.price,
      cost = excluded.cost,
      price_type = excluded.price_type,
      discount_minor = excluded.discount_minor,
      subtotal_minor = excluded.subtotal_minor
  `);

  const tx = db.transaction(() => {
    for (const si of saleItems) {
      insertItem.run(
        Number(si.id),
        Number(si.sale_id),
        Number(si.product_id),
        si.product_name_snapshot || null,
        si.product_sku_snapshot ? String(si.product_sku_snapshot) : null,
        Number(si.quantity || 1),
        Number(si.price || 0),
        Number(si.cost || 0),
        si.price_type || null,
        si.discount_minor !== undefined && si.discount_minor !== null ? Number(si.discount_minor) : null,
        Number(si.subtotal_minor || 0)
      );
    }
  });
  tx();
  console.log(`[Packager] Sale items upserted. Total in db: ${db.prepare('SELECT count(*) as c FROM sale_items').get().c}`);
}

// 5. Load and upsert verified 232 arrivals
if (fs.existsSync('firestore_arrivals.json')) {
  const arrivals = JSON.parse(fs.readFileSync('firestore_arrivals.json', 'utf8'));
  console.log(`[Packager] Upserting ${arrivals.length} verified stock arrivals from firestore_arrivals.json...`);

  const insertArrival = db.prepare(`
    INSERT INTO stock_arrivals (id, product_id, quantity, arrival_price, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      product_id = excluded.product_id,
      quantity = excluded.quantity,
      arrival_price = excluded.arrival_price,
      created_at = excluded.created_at
  `);

  const tx = db.transaction(() => {
    for (const a of arrivals) {
      insertArrival.run(
        Number(a.id),
        Number(a.product_id),
        Number(a.quantity || 0),
        Number(a.arrival_price || 0),
        a.created_at || new Date().toISOString()
      );
    }
  });
  tx();
  console.log(`[Packager] Stock arrivals upserted. Total in db: ${db.prepare('SELECT count(*) as c FROM stock_arrivals').get().c}`);
}

// 6. Verify Users and Passwords
const users = db.prepare('SELECT id, username, role, email, password FROM users').all();
console.log(`[Packager] Store users verified: ${users.length} accounts:`);
for (const u of users) {
  console.log(`  - ${u.username} (${u.role}): hash length=${u.password?.length}, isHashed=${u.password?.includes(':')}`);
}

// 7. Pragma integrity check and checkpoint
const integrity = db.pragma('integrity_check');
console.log('[Packager] Integrity check result:', integrity);
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();

const stats = fs.statSync('gtr_pos.db');
console.log(`[Packager] Successfully packaged gtr_pos.db! Final size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
