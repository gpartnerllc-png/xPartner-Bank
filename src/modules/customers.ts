import type { Db } from '../kernel/db.ts';
import { audit, nowIso, tx } from '../kernel/db.ts';
import { AppError, Errors } from '../kernel/errors.ts';
import { newId } from '../kernel/ids.ts';
import {
  assertDocument,
  assertEmail,
  assertPhone,
  maskDocument,
  normalizeName,
} from '../domain/documents.ts';
import type { PersonKind } from '../domain/documents.ts';

export interface CustomerRow {
  id: string;
  merchant_id: string;
  kind: PersonKind;
  name: string;
  document: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  uf: string | null;
  status: string;
  metadata: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateCustomerInput {
  merchantId: string;
  name: string;
  document: string;
  email?: string;
  phone?: string;
  city?: string;
  uf?: string;
  metadata?: unknown;
  now?: number;
}

function publicCustomer(row: CustomerRow) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    documentMasked: maskDocument(row.document),
    email: row.email,
    phone: row.phone,
    city: row.city,
    uf: row.uf,
    status: row.status,
    metadata: row.metadata ? (JSON.parse(row.metadata) as unknown) : null,
    archivedAt: row.archived_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function optionalText(value: string | undefined, maxLength: number): string | null {
  const text = value?.trim();
  return text ? text.slice(0, maxLength) : null;
}

export class CustomerService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  create(input: CreateCustomerInput) {
    const now = input.now ?? Date.now();
    const createdAt = nowIso(now);
    const merchant = this.db
      .prepare("SELECT id, status FROM merchants WHERE id = ?")
      .get(input.merchantId) as { id: string; status: string } | undefined;
    if (!merchant) throw Errors.notFound('Estabelecimento não encontrado.');
    if (merchant.status !== 'ACTIVE') throw new AppError('MERCHANT_INACTIVE', 'Estabelecimento inativo.', 409);

    const { document, kind } = assertDocument(input.document, 'documento do cliente');
    const name = normalizeName(input.name);
    const email = input.email ? assertEmail(input.email) : null;
    const phone = input.phone ? assertPhone(input.phone) : null;
    const city = optionalText(input.city, 60);
    const uf = optionalText(input.uf, 2)?.toUpperCase() ?? null;

    const id = newId('cus', now);
    try {
      this.db
        .prepare(
          `INSERT INTO customers
             (id, merchant_id, kind, name, document, email, phone, city, uf, status, metadata, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
        )
        .run(
          id,
          input.merchantId,
          kind,
          name,
          document,
          email,
          phone,
          city,
          uf,
          input.metadata === undefined ? null : JSON.stringify(input.metadata),
          createdAt,
          createdAt,
        );
    } catch (error) {
      if (String(error).includes('UNIQUE')) {
        const existing = this.db
          .prepare('SELECT * FROM customers WHERE merchant_id = ? AND document = ?')
          .get(input.merchantId, document) as CustomerRow | undefined;
        if (existing?.archived_at) {
          this.db
            .prepare(
              `UPDATE customers
                  SET name = ?, email = ?, phone = ?, city = ?, uf = ?, status = 'ACTIVE',
                      metadata = NULL, archived_at = NULL, updated_at = ?
                WHERE id = ?`,
            )
            .run(name, email, phone, city, uf, createdAt, existing.id);
          audit(this.db, 'merchant', 'CUSTOMER_RESTORED', existing.id, { kind, name });
          return publicCustomer(this.getRow(existing.id));
        }
        throw new AppError('CUSTOMER_EXISTS', 'Já existe um cliente com este documento.', 409, {
          customerId: existing?.id,
        });
      }
      throw error;
    }

    audit(this.db, 'merchant', 'CUSTOMER_CREATED', id, { kind, name });
    return publicCustomer(this.getRow(id));
  }

  update(
    merchantId: string,
    customerId: string,
    patch: { name?: string; email?: string | null; phone?: string | null; city?: string | null; uf?: string | null; status?: string },
  ) {
    const row = this.ensureCustomer(merchantId, customerId);
    if (patch.status && !['ACTIVE', 'BLOCKED'].includes(patch.status)) {
      throw new AppError('INVALID_STATUS', 'Status de cliente inválido.', 422);
    }
    const updatedAt = nowIso();
    tx(this.db, () => {
      this.db
        .prepare(
          `UPDATE customers
              SET name = ?, email = ?, phone = ?, city = ?, uf = ?, status = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          patch.name === undefined ? row.name : normalizeName(patch.name),
          patch.email === undefined ? row.email : patch.email ? assertEmail(patch.email) : null,
          patch.phone === undefined ? row.phone : patch.phone ? assertPhone(patch.phone) : null,
          patch.city === undefined ? row.city : optionalText(patch.city ?? undefined, 60),
          patch.uf === undefined ? row.uf : optionalText(patch.uf ?? undefined, 2)?.toUpperCase() ?? null,
          patch.status ?? row.status,
          updatedAt,
          customerId,
        );
      audit(this.db, 'merchant', 'CUSTOMER_UPDATED', customerId, { fields: Object.keys(patch) });
    });
    return publicCustomer(this.getRow(customerId));
  }

  archive(merchantId: string, customerId: string) {
    const row = this.ensureCustomer(merchantId, customerId);
    if (row.archived_at) throw new AppError('CUSTOMER_ARCHIVED', 'Cliente já removido da base.', 409);
    const archivedAt = nowIso();
    const countOf = (sql: string) =>
      (this.db.prepare(sql).get(customerId) as { total: number }).total;
    const preserved = {
      boletos: countOf('SELECT COUNT(*) AS total FROM boletos WHERE customer_id = ?'),
      subscriptions: countOf('SELECT COUNT(*) AS total FROM subscriptions WHERE customer_id = ?'),
    };
    const metadata = {
      ...(row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {}),
      archivedName: row.name,
    };
    tx(this.db, () => {
      this.db
        .prepare(
          `UPDATE customers
              SET name = ?, email = NULL, phone = NULL, city = NULL, uf = NULL,
                  status = 'BLOCKED', metadata = ?, archived_at = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(`Cliente removido · ${customerId.slice(-6)}`, JSON.stringify(metadata), archivedAt, archivedAt, customerId);
      audit(this.db, 'merchant', 'CUSTOMER_ARCHIVED', customerId, preserved);
    });
    return { customer: publicCustomer(this.getRow(customerId)), preserved };
  }

  list(merchantId: string, options: { limit?: number; search?: string; includeArchived?: boolean } = {}) {
    const limit = Math.min(100, Math.max(1, options.limit ?? 50));
    const search = options.search?.trim();
    const archivedFilter = options.includeArchived ? '' : 'AND archived_at IS NULL';
    const rows = search
      ? (this.db
          .prepare(
            `SELECT * FROM customers
              WHERE merchant_id = ? ${archivedFilter} AND (name LIKE ? OR document LIKE ?)
              ORDER BY name ASC LIMIT ?`,
          )
          .all(merchantId, `%${search}%`, `%${search.replace(/\D/g, '')}%`, limit) as unknown as CustomerRow[])
      : (this.db
          .prepare(`SELECT * FROM customers WHERE merchant_id = ? ${archivedFilter} ORDER BY name ASC LIMIT ?`)
          .all(merchantId, limit) as unknown as CustomerRow[]);
    return rows.map(publicCustomer);
  }

  get(merchantId: string, customerId: string) {
    const row = this.ensureCustomer(merchantId, customerId);
    const boletos = this.db
      .prepare(
        `SELECT id, our_number, amount_cents, due_date, status, created_at
           FROM boletos WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10`,
      )
      .all(customerId) as Array<{
      id: string;
      our_number: string;
      amount_cents: number;
      due_date: string;
      status: string;
      created_at: string;
    }>;
    return { customer: publicCustomer(row), boletos };
  }

  getRow(customerId: string): CustomerRow {
    const row = this.db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) as CustomerRow | undefined;
    if (!row) throw Errors.notFound('Cliente não encontrado.');
    return row;
  }

  ensureCustomer(merchantId: string, customerId: string): CustomerRow {
    const row = this.getRow(customerId);
    if (row.merchant_id !== merchantId) throw Errors.forbidden('Cliente não pertence ao estabelecimento.');
    return row;
  }

  count(merchantId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS total FROM customers WHERE merchant_id = ? AND archived_at IS NULL")
      .get(merchantId) as { total: number };
    return row.total;
  }
}

export { publicCustomer };
