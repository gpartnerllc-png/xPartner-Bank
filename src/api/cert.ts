import type { FastifyRequest } from 'fastify';
import type { Db } from '../kernel/db.ts';
import { Errors } from '../kernel/errors.ts';
import { constantTimeEqualHex, sha256Hex } from '../kernel/crypto.ts';

export interface PeerCertificate {
  subject?: { CN?: string };
  fingerprint256?: string;
  raw?: Buffer;
}

interface TlsSocketLike {
  getPeerCertificate?: (detailed?: boolean) => PeerCertificate;
}

/** Extrai o certificado apresentado pelo terminal na conexão TLS. */
export function peerCertificate(request: FastifyRequest): PeerCertificate | undefined {
  const socket = (request.raw as { socket?: TlsSocketLike }).socket;
  if (!socket?.getPeerCertificate) return undefined;
  try {
    const cert = socket.getPeerCertificate(true);
    if (!cert || !cert.subject?.CN) return undefined;
    return cert;
  } catch {
    return undefined;
  }
}

/**
 * O CN do certificado é o serial do terminal. Aceita os prefixos
 * `terminal:` e `device:` para CAs que exigem um namespace no subject.
 */
export function terminalSerialFromCertificate(cert: PeerCertificate | undefined): string {
  const cn = cert?.subject?.CN?.trim();
  if (!cn) throw Errors.unauthorized('Certificado mTLS sem CN (serial do terminal).');
  const serial = cn.replace(/^(terminal|device):/i, '').trim();
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(serial)) {
    throw Errors.unauthorized('CN do certificado não é um serial de terminal válido.');
  }
  return serial;
}

/** Normaliza SHA-256 (`AA:BB:...`) para hex minúsculo sem separadores. */
export function normalizeFingerprint(value: string | undefined | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/[^0-9a-f]/gi, '').toLowerCase();
  return normalized.length >= 16 ? normalized : null;
}

/** Fingerprint SHA-256 do certificado; cai para o DER bruto quando o runtime não informa. */
export function certificateFingerprint(cert: PeerCertificate | undefined): string | null {
  const declared = normalizeFingerprint(cert?.fingerprint256);
  if (declared) return declared;
  if (cert?.raw?.length) return sha256Hex(Buffer.from(cert.raw));
  return null;
}

export function fingerprintsMatch(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  return constantTimeEqualHex(left, right);
}

export interface TerminalIdentity {
  id: string;
  merchantId: string;
  serial: string;
  certFingerprint: string | null;
  fingerprint: string | null;
}

interface TerminalRow {
  id: string;
  merchant_id: string;
  serial: string;
  status: string;
  cert_fingerprint: string | null;
}

/**
 * Resolve o terminal pelo CN, exige status ACTIVE e confere o fingerprint
 * registrado. `requireFingerprint` fecha a porta para terminais sem
 * fingerprint cadastrado (recomendado em produção).
 */
export function resolveTerminal(
  db: Db,
  cert: PeerCertificate | undefined,
  options: { requireFingerprint?: boolean } = {},
): TerminalIdentity {
  const serial = terminalSerialFromCertificate(cert);
  const row = db
    .prepare('SELECT id, merchant_id, serial, status, cert_fingerprint FROM terminals WHERE serial = ?')
    .get(serial) as TerminalRow | undefined;
  if (!row) throw Errors.unauthorized('Certificado não corresponde a um terminal cadastrado.');
  if (row.status !== 'ACTIVE') throw Errors.forbidden('Terminal bloqueado ou inativo.');

  const fingerprint = certificateFingerprint(cert);
  const registered = normalizeFingerprint(row.cert_fingerprint);
  if (registered) {
    if (!fingerprint) throw Errors.unauthorized('Não foi possível calcular o fingerprint do certificado.');
    if (!fingerprintsMatch(registered, fingerprint)) {
      throw Errors.forbidden('Fingerprint do certificado não confere com o terminal.');
    }
  } else if (options.requireFingerprint) {
    throw Errors.forbidden('Terminal sem fingerprint de certificado registrado.');
  }

  return {
    id: row.id,
    merchantId: row.merchant_id,
    serial: row.serial,
    certFingerprint: registered,
    fingerprint,
  };
}
