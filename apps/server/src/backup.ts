// Консистентная копия БД: node dist/backup.js <куда>   (источник — DATABASE_URL)
import Database from 'better-sqlite3';

const dest = process.argv[2];
if (!dest) { console.error('usage: backup.js <dest.db>'); process.exit(1); }
const db = new Database(process.env.DATABASE_URL ?? './data/planb.db', { readonly: true });
await db.backup(dest);
db.close();
console.log('backup written');
