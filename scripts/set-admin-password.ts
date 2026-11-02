import { openDb, migrate } from '../src/kernel/db.ts';
import { hashPassword } from '../src/modules/bank-auth.ts';

const email = (process.env.BANK_ADMIN_EMAIL ?? 'bank@droppfy.com').trim().toLowerCase();
const password = process.env.BANK_ADMIN_PASSWORD ?? '';
if (password.length < 10) {
  console.error('Defina BANK_ADMIN_PASSWORD (mínimo 10 caracteres).');
  process.exit(1);
}

const db = openDb(process.env.DB_PATH ?? '.data/xpartner.db');
migrate(db);

const user = db
  .prepare('SELECT id, name, role FROM bank_users WHERE lower(email) = ?')
  .get(email) as { id: string; name: string; role: string } | undefined;
if (!user) {
  console.error(`Usuário ${email} não encontrado no banco.`);
  process.exit(1);
}

const now = new Date().toISOString();
db.exec('BEGIN IMMEDIATE');
try {
  db.prepare(
    `UPDATE bank_users
        SET password_hash = ?, role = 'ADMIN', status = 'ACTIVE', must_change_password = 0,
            failed_attempts = 0, locked_until = NULL, deleted_at = NULL, updated_at = ?
      WHERE id = ?`,
  ).run(hashPassword(password), now, user.id);
  db.prepare('UPDATE bank_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, user.id);
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

console.log(`Admin master atualizado: ${email} · ${user.id} · hash scrypt, sessões antigas revogadas.`);
