import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { AppConfig } from '../config.ts';
import type { EventBus } from '../kernel/bus.ts';
import { deriveSecret, verifyToken } from '../kernel/crypto.ts';
import { log } from '../kernel/logger.ts';

interface HubEvent {
  type: string;
  data: Record<string, unknown>;
  at: string;
}

/**
 * Push em tempo real por estabelecimento. A maquininha e o dashboard abrem
 * um WebSocket persistente e recebem o evento fiscal assim que a SEFAZ responde.
 */
export class NotificationHub {
  private wss: WebSocketServer | undefined;
  private clients = new Map<string, Set<WebSocket>>();
  private heartbeat: NodeJS.Timeout | undefined;
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  attach(server: Server): void {
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }
      const token = url.searchParams.get('token') ?? '';
      let merchantId = '';
      try {
        const claims = verifyToken(token, deriveSecret(this.config.masterKey, 'token'));
        merchantId = claims.merchantId;
      } catch {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss?.handleUpgrade(request, socket, head, (ws) => {
        const set = this.clients.get(merchantId) ?? new Set<WebSocket>();
        set.add(ws);
        this.clients.set(merchantId, set);
        ws.send(JSON.stringify({ type: 'hello', data: { merchantId }, at: new Date().toISOString() }));
        ws.on('close', () => {
          set.delete(ws);
          if (set.size === 0) this.clients.delete(merchantId);
        });
        ws.on('error', () => set.delete(ws));
        log.debug('ws.connected', { merchantId, clients: set.size });
      });
    });

    this.heartbeat = setInterval(() => {
      for (const set of this.clients.values()) {
        for (const client of set) {
          if (client.readyState === WebSocket.OPEN) client.ping();
        }
      }
    }, 30_000);
    this.heartbeat.unref();
  }

  start(bus: EventBus): void {
    bus.subscribe('transactions.approved', 'notifications', (envelope) => {
      const payload = envelope.payload as Record<string, unknown>;
      this.notify(String(payload.merchantId), 'transaction.approved', {
        transactionId: payload.transactionId,
        amountCents: payload.amountCents,
        method: payload.method,
        terminalId: payload.terminalId,
        nsu: payload.nsu,
      });
    });

    bus.subscribe('fiscal.issued', 'notifications', (envelope) => {
      const payload = envelope.payload as Record<string, unknown>;
      this.notify(String(payload.merchantId), 'fiscal.issued', {
        transactionId: payload.transactionId,
        terminalId: payload.terminalId,
        status: payload.status,
        contingency: payload.contingency,
        protocol: payload.protocol,
        qrCodeUrl: payload.qrCodeUrl,
        accessKey: payload.accessKey,
      });
    });

    bus.subscribe('settlement.paid', 'notifications', (envelope) => {
      const payload = envelope.payload as Record<string, unknown>;
      this.notify(String(payload.merchantId), 'settlement.paid', {
        transactionId: payload.transactionId,
        netCents: payload.netCents,
        mode: payload.mode,
      });
    });
  }

  notify(merchantId: string, type: string, data: Record<string, unknown>): void {
    const set = this.clients.get(merchantId);
    if (!set || set.size === 0) return;
    const event: HubEvent = { type, data, at: new Date().toISOString() };
    const serialized = JSON.stringify(event);
    for (const client of set) {
      if (client.readyState === WebSocket.OPEN) client.send(serialized);
    }
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const set of this.clients.values()) {
      for (const client of set) client.terminate();
    }
    this.clients.clear();
    this.wss?.close();
    this.wss = undefined;
  }
}
