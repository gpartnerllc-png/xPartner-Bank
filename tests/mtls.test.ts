import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.ts';
import { TransactionService } from '../src/modules/transactions.ts';
import { DEMO_MERCHANT_ID, DEMO_TERMINAL_ID } from '../src/modules/seed.ts';
import { devTokenFor } from '../src/domain/vault.ts';
import { SlidingWindowLimiter } from '../src/api/security.ts';
import {
  certificateFingerprint,
  normalizeFingerprint,
  resolveTerminal,
  terminalSerialFromCertificate,
  type PeerCertificate,
} from '../src/api/cert.ts';
import { authorizeSecureCheckout, buildMtlsApp } from '../src/api/mtls.ts';
import { testConfig, testDb } from './helpers.ts';

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

const DEMO_CERT: PeerCertificate = {
  subject: { CN: 'XP-TAP-0001' },
  fingerprint256: 'a1:b2:c3:d4:e5:f6:07:18',
};

test('mtls: configuração exige os três caminhos de certificado', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'test', MTLS_KEY_PATH: './certs/key.pem' }), /MTLS_CERT_PATH/);
  const config = testConfig({
    MTLS_KEY_PATH: './certs/server-key.pem',
    MTLS_CERT_PATH: './certs/server-cert.pem',
    MTLS_CA_PATH: './certs/bank-ca-cert.pem',
    MTLS_PORT: '9443',
  });
  assert.equal(config.mtls?.port, 9443);
  assert.equal(config.mtls?.requestCert, true);
  assert.equal(config.mtls?.rejectUnauthorized, true);
});

test('mtls: CN vira serial, fingerprint normaliza e terminal é resolvido', () => {
  assert.equal(terminalSerialFromCertificate(DEMO_CERT), 'XP-TAP-0001');
  assert.equal(terminalSerialFromCertificate({ subject: { CN: 'terminal:XP-POS-0002' } }), 'XP-POS-0002');
  assert.equal(errorCode(() => terminalSerialFromCertificate({ subject: {} })), 'UNAUTHORIZED');
  assert.equal(normalizeFingerprint('A1:B2:C3:D4:E5:F6:07:18'), 'a1b2c3d4e5f60718');
  assert.equal(certificateFingerprint(DEMO_CERT), 'a1b2c3d4e5f60718');

  const db = testDb();
  const terminal = resolveTerminal(db, DEMO_CERT);
  assert.equal(terminal.id, DEMO_TERMINAL_ID);
  assert.equal(terminal.merchantId, DEMO_MERCHANT_ID);

  assert.equal(
    errorCode(() => resolveTerminal(db, { subject: { CN: 'XP-TAP-0001' }, fingerprint256: 'deadbeefdeadbeef' })),
    'FORBIDDEN',
  );
  assert.equal(errorCode(() => resolveTerminal(db, { subject: { CN: 'UNKNOWN-9999' } })), 'UNAUTHORIZED');
});

test('mtls: checkout autoriza venda real, repete idempotente e recusa payload divergente', () => {
  const config = testConfig();
  const db = testDb();
  const transactions = new TransactionService(db, config);
  const deps = { config, db, transactions, limiter: new SlidingWindowLimiter(100) };
  const body = {
    amountCents: 5_000,
    method: 'CREDIT',
    paymentToken: devTokenFor('visa', '4242', 'mtls-checkout'),
    description: 'Venda segura mTLS',
  };
  const rawBody = JSON.stringify(body);

  const first = authorizeSecureCheckout(deps, {
    cert: DEMO_CERT,
    body,
    idempotencyKey: 'mtls-key-0001',
    rawBody,
  });
  assert.equal(first.statusCode, 201);
  assert.equal(first.replayed, false);
  assert.equal(first.payload.secured_by, 'mTLS');
  const transaction = first.payload.transaction as { id: string; status: string };
  assert.equal(transaction.status, 'APPROVED');

  const replay = authorizeSecureCheckout(deps, {
    cert: DEMO_CERT,
    body,
    idempotencyKey: 'mtls-key-0001',
    rawBody,
  });
  assert.equal(replay.replayed, true);
  assert.equal((replay.payload.transaction as { id: string }).id, transaction.id);

  assert.equal(
    errorCode(() =>
      authorizeSecureCheckout(deps, {
        cert: DEMO_CERT,
        body: { ...body, amountCents: 9_900 },
        idempotencyKey: 'mtls-key-0001',
        rawBody: JSON.stringify({ ...body, amountCents: 9_900 }),
      }),
    ),
    'CONFLICT',
  );

  assert.equal(
    errorCode(() =>
      authorizeSecureCheckout(deps, {
        cert: { subject: { CN: 'XP-TAP-0001' }, fingerprint256: 'deadbeefdeadbeef' },
        body,
        idempotencyKey: 'mtls-key-0002',
        rawBody,
      }),
    ),
    'FORBIDDEN',
  );
});

interface TlsResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function httpsJson(
  port: number,
  body: string,
  options: { key?: Buffer; cert?: Buffer; ca?: Buffer; idempotencyKey?: string } = {},
): Promise<TlsResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/secure-checkout',
        method: 'POST',
        ca: options.ca,
        key: options.key,
        cert: options.cert,
        rejectUnauthorized: true,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'idempotency-key': options.idempotencyKey ?? 'tls-key-0001',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('mtls: handshake TLS real aprova terminal com certificado e rejeita sem certificado', async (t) => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
  } catch {
    t.skip('openssl indisponível para gerar certificados de teste');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'xp-mtls-'));
  try {
    const file = (name: string): string => join(dir, name);
    const openssl = (...args: string[]): void => {
      execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
    };

    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca-key.pem', '-out', 'ca-cert.pem',
      '-days', '1', '-subj', '/CN=XPARTNER Test CA');

    writeFileSync(
      file('server.ext'),
      'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n',
    );
    openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server-key.pem', '-out', 'server.csr',
      '-subj', '/CN=localhost');
    openssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca-cert.pem', '-CAkey', 'ca-key.pem',
      '-CAcreateserial', '-out', 'server-cert.pem', '-days', '1', '-extfile', 'server.ext');

    writeFileSync(file('client.ext'), 'basicConstraints=CA:FALSE\nextendedKeyUsage=clientAuth\n');
    openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'client-key.pem', '-out', 'client.csr',
      '-subj', '/CN=XP-TAP-0001');
    openssl('x509', '-req', '-in', 'client.csr', '-CA', 'ca-cert.pem', '-CAkey', 'ca-key.pem',
      '-CAcreateserial', '-out', 'client-cert.pem', '-days', '1', '-extfile', 'client.ext');

    openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'unknown-key.pem', '-out', 'unknown.csr',
      '-subj', '/CN=UNKNOWN-9999');
    openssl('x509', '-req', '-in', 'unknown.csr', '-CA', 'ca-cert.pem', '-CAkey', 'ca-key.pem',
      '-CAcreateserial', '-out', 'unknown-cert.pem', '-days', '1', '-extfile', 'client.ext');

    const clientCertPem = readFileSync(file('client-cert.pem'), 'utf8');
    const clientFingerprint = normalizeFingerprint(new X509Certificate(clientCertPem).fingerprint256);
    assert.ok(clientFingerprint);

    const config = testConfig({
      MTLS_KEY_PATH: file('server-key.pem'),
      MTLS_CERT_PATH: file('server-cert.pem'),
      MTLS_CA_PATH: file('ca-cert.pem'),
      MTLS_PORT: '8443',
    });
    const db = testDb();
    db.prepare('UPDATE terminals SET cert_fingerprint = ? WHERE id = ?').run(clientFingerprint, DEMO_TERMINAL_ID);
    const transactions = new TransactionService(db, config);
    const app = buildMtlsApp({
      config,
      db,
      transactions,
      limiter: new SlidingWindowLimiter(100),
      logger: false,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;

    const ca = readFileSync(file('ca-cert.pem'));
    const body = JSON.stringify({
      amountCents: 7_500,
      method: 'DEBIT',
      paymentToken: devTokenFor('master', '5123', 'mtls-tls'),
      description: 'Venda TLS mutual',
    });

    try {
      const ok = await httpsJson(port, body, {
        key: readFileSync(file('client-key.pem')),
        cert: readFileSync(file('client-cert.pem')),
        ca,
      });
      assert.equal(ok.status, 201);
      const payload = JSON.parse(ok.body) as { secured_by: string; status: string };
      assert.equal(payload.secured_by, 'mTLS');
      assert.equal(payload.status, 'APPROVED');

      const replay = await httpsJson(port, body, {
        key: readFileSync(file('client-key.pem')),
        cert: readFileSync(file('client-cert.pem')),
        ca,
      });
      assert.equal(replay.status, 201);
      assert.equal(replay.headers['x-idempotent-replayed'], 'true');

      const unknown = await httpsJson(port, body, {
        key: readFileSync(file('unknown-key.pem')),
        cert: readFileSync(file('unknown-cert.pem')),
        ca,
        idempotencyKey: 'tls-key-9999',
      });
      assert.equal(unknown.status, 401);
      assert.match(unknown.body, /UNAUTHORIZED/);

      await assert.rejects(
        httpsJson(port, body, { ca, idempotencyKey: 'tls-key-0002' }),
        /certificate required|socket hang up|ECONNRESET|EPIPE|SSL/i,
      );
    } finally {
      await app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
