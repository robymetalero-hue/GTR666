const { initializeApp } = require('firebase/app');
const { getFirestore, collection, getDocs, terminate } = require('firebase/firestore');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8'));
const app = initializeApp(config);
const db = getFirestore(app, config.firestoreDatabaseId);

async function run() {
  try {
    const snap = await getDocs(collection(db, 'inventory_count_items'));
    console.log('Total items in inventory_count_items:', snap.size);
    const countIds = new Set();
    const countIdTypes = new Set();
    const itemsByCount = {};
    snap.docs.forEach(d => {
      const data = d.data();
      countIds.add(data.inventory_count_id);
      countIdTypes.add(typeof data.inventory_count_id);
      const cid = String(data.inventory_count_id);
      if (!itemsByCount[cid]) itemsByCount[cid] = [];
      itemsByCount[cid].push({ docId: d.id, ...data });
    });
    console.log('Distinct inventory_count_id values:', Array.from(countIds));
    console.log('Types of inventory_count_id:', Array.from(countIdTypes));
    for (const cid of Object.keys(itemsByCount)) {
      console.log('Count ID ' + cid + ': ' + itemsByCount[cid].length + ' items');
      if (cid === '28' || cid === '29') {
        fs.writeFileSync('items_' + cid + '.json', JSON.stringify(itemsByCount[cid], null, 2));
      }
    }
  } catch (e) {
    console.error(e);
  } finally {
    await terminate(db);
    process.exit(0);
  }
}
run();
