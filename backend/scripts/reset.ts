// Clears sessions (keeps the product + 3D model cache) so the headset opens a fresh room: npm run reset
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../src/config.js';
const file = path.join(DATA_DIR, 'db.json');
if (!fs.existsSync(file)) { console.log('nothing to reset'); process.exit(0); }
const db = JSON.parse(fs.readFileSync(file, 'utf8'));
const n = Object.keys(db.sessions ?? {}).length;
db.sessions = {};
fs.writeFileSync(file, JSON.stringify(db));
console.log(`removed ${n} session(s); kept ${Object.keys(db.products ?? {}).length} cached products. Restart the server.`);
