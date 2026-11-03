import type { Db, DbStatement } from '../../../src/kernel/db.ts';

interface SqlCursorLike {
  toArray(): Array<Record<string, unknown>>;
  rowsWritten?: number;
}

export interface SqlStorageLike {
  exec(query: string, ...bindings: unknown[]): SqlCursorLike;
}

function bind(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return Number(value);
  return value;
}

const READ_USER_VERSION = /^\s*PRAGMA\s+user_version\s*;?\s*$/i;
const WRITE_USER_VERSION = /^\s*PRAGMA\s+user_version\s*=\s*(\d+)\s*;?\s*$/i;

class DoStatement implements DbStatement {
  constructor(
    private readonly sql: string,
    private readonly storage: SqlStorageLike,
  ) {}

  run(...params: any[]) {
    const cursor = this.storage.exec(this.sql, ...params.map(bind));
    return { changes: cursor.rowsWritten ?? 0, lastInsertRowid: 0 };
  }

  get(...params: any[]) {
    const rows = this.storage.exec(this.sql, ...params.map(bind)).toArray();
    return rows[0];
  }

  all(...params: any[]) {
    return this.storage.exec(this.sql, ...params.map(bind)).toArray();
  }
}

/**
 * O SQLite de Durable Object não aceita BEGIN/COMMIT explícitos: cada lote é
 * serializado pelo próprio objeto. As transações do domínio viram no-op aqui.
 * O autorizador do runtime também bloqueia PRAGMA, então a versão do schema é
 * guardada em merchant_meta e exposta pelo mesmo contrato de migração.
 */
const TRANSACTION_STATEMENT = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

export class DoDb implements Db {
  private userVersion: number;

  constructor(private readonly storage: SqlStorageLike) {
    this.userVersion = this.readUserVersion();
  }

  private readUserVersion(): number {
    try {
      const rows = this.storage.exec("SELECT value FROM merchant_meta WHERE key = 'user_version'").toArray();
      return Number(rows[0]?.value ?? 0) || 0;
    } catch {
      return 0;
    }
  }

  prepare(sql: string): DbStatement {
    if (READ_USER_VERSION.test(sql)) {
      const version = this.userVersion;
      return {
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
        get: () => ({ user_version: version }),
        all: () => [{ user_version: version }],
      };
    }
    return new DoStatement(sql, this.storage);
  }

  exec(sql: string): void {
    if (TRANSACTION_STATEMENT.test(sql)) return;
    const version = WRITE_USER_VERSION.exec(sql);
    if (version) {
      this.userVersion = Number(version[1]);
      this.storage.exec(
        `INSERT INTO merchant_meta (key, value) VALUES ('user_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        String(this.userVersion),
      );
      return;
    }
    this.storage.exec(sql);
  }

  close(): void {}
}
