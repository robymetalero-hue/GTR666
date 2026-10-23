import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, query, where, doc, getDoc } from 'firebase/firestore';
import fs from 'fs';

const config = JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8'));
const app = initializeApp(config);
const db = getFirestore(app, config.firestoreDatabaseId);

async function run() {
  console.log('Connecting to Firestore database:', config.firestoreDatabaseId);

  // 1. Fetch Session 28 and 29 metadata
  const doc28 = await getDoc(doc(db, 'inventory_counts', '28'));
  const data28 = doc28.exists() ? doc28.data() : null;

  const doc29 = await getDoc(doc(db, 'inventory_counts', '29'));
  const data29 = doc29.exists() ? doc29.data() : null;

  fs.writeFileSync('session_28_meta.json', JSON.stringify(data28, null, 2));
  fs.writeFileSync('session_29_meta.json', JSON.stringify(data29, null, 2));
  console.log('Saved session 28 & 29 meta.');

  // 2. Fetch inventory_count_items for 28 and 29
  console.log('Fetching inventory_count_items...');
  const countItemsCol = collection(db, 'inventory_count_items');
  const snapItems = await getDocs(countItemsCol);
  console.log(`Total inventory_count_items in Firestore: ${snapItems.size}`);

  const items28 = [];
  const items29 = [];

  snapItems.forEach(docSnap => {
    const d = docSnap.data();
    d._id = docSnap.id;
    const cid = d.inventory_count_id ?? d.count_id;
    if (cid === 28 || cid === '28') items28.push(d);
    if (cid === 29 || cid === '29') items29.push(d);
  });

  fs.writeFileSync('session_28_items.json', JSON.stringify(items28, null, 2));
  fs.writeFileSync('session_29_items.json', JSON.stringify(items29, null, 2));
  console.log(`Found ${items28.length} items for session 28, ${items29.length} items for session 29.`);

  // 3. Fetch products
  console.log('Fetching all products...');
  const prodCol = collection(db, 'products');
  const prodSnap = await getDocs(prodCol);
  const products = [];
  prodSnap.forEach(p => {
    const pd = p.data();
    pd._id = p.id;
    products.push(pd);
  });
  fs.writeFileSync('firestore_products.json', JSON.stringify(products, null, 2));
  console.log(`Total products in Firestore: ${products.length}`);

  // 4. Fetch sales between 2026-10-17 and 2026-10-23
  console.log('Fetching sales...');
  const salesCol = collection(db, 'sales');
  const salesSnap = await getDocs(salesCol);
  const sales = [];
  salesSnap.forEach(s => {
    const sd = s.data();
    sd._id = s.id;
    sales.push(sd);
  });
  fs.writeFileSync('firestore_sales.json', JSON.stringify(sales, null, 2));
  console.log(`Total sales in Firestore: ${sales.length}`);

  // 5. Fetch sale_items
  console.log('Fetching sale_items...');
  const saleItemsCol = collection(db, 'sale_items');
  const saleItemsSnap = await getDocs(saleItemsCol);
  const saleItems = [];
  saleItemsSnap.forEach(si => {
    const sid = si.data();
    sid._id = si.id;
    saleItems.push(sid);
  });
  fs.writeFileSync('firestore_sale_items.json', JSON.stringify(saleItems, null, 2));
  console.log(`Total sale items in Firestore: ${saleItems.length}`);

  // 6. Fetch stock_arrivals
  console.log('Fetching stock_arrivals...');
  const arrivalsCol = collection(db, 'stock_arrivals');
  const arrivalsSnap = await getDocs(arrivalsCol);
  const arrivals = [];
  arrivalsSnap.forEach(a => {
    const ad = a.data();
    ad._id = a.id;
    arrivals.push(ad);
  });
  fs.writeFileSync('firestore_arrivals.json', JSON.stringify(arrivals, null, 2));
  console.log(`Total stock arrivals in Firestore: ${arrivals.length}`);

  // 7. Fetch inventory_audit_logs
  console.log('Fetching inventory_audit_logs...');
  const auditLogsCol = collection(db, 'inventory_audit_logs');
  const auditSnap = await getDocs(auditLogsCol);
  const auditLogs = [];
  auditSnap.forEach(al => {
    const ald = al.data();
    ald._id = al.id;
    auditLogs.push(ald);
  });
  fs.writeFileSync('firestore_audit_logs.json', JSON.stringify(auditLogs, null, 2));
  console.log(`Total audit logs in Firestore: ${auditLogs.length}`);

  console.log('All Firestore datasets fetched successfully.');
  process.exit(0);
}

run().catch(err => {
  console.error('Fatal error in fetch script:', err);
  process.exit(1);
});
