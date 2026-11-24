// Create a service admin (superadmin) account on the public domain, or promote
// an existing account.  Usage: node scripts/create-admin.js <username> <password> [name]
import { config } from '../src/config.js';
import { db, ensurePublicTenant } from '../src/db.js';
import { createUser } from '../src/auth.js';

const [username, password, name] = process.argv.slice(2);
if (!username) { console.error('Usage: node scripts/create-admin.js <username> <password> [name]'); process.exit(1); }
ensurePublicTenant(config.primaryDomain, config.serviceName);
const email = username.includes('@') ? username.toLowerCase() : `${username.toLowerCase()}@${config.primaryDomain}`;
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
if (existing) {
  db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(existing.id);
  console.log(`Promoted ${email} to service admin.`);
} else {
  const u = createUser({ username, password, name: name || 'Administrator', isAdmin: true });
  console.log(`Created service admin ${u.email}.`);
}
