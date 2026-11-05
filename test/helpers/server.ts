import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { KeyPair } from './certs.js';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export type Handler = (req: RecordedRequest, res: ServerResponse) => void;

export interface TestServer {
  url: string;
  port: number;
  requests: RecordedRequest[];
  /** TLS connections accepted. */
  connections: number;
  /** TCP connections accepted (counted before any TLS handshake). */
  tcpConnections: number;
  /** Application bytes received over TLS from clients (after decryption). */
  bytesReceived: number;
  close(): Promise<void>;
}

/** Local HTTPS server that records every request and answers through `handler`. */
export async function startServer(pair: KeyPair, handler: Handler): Promise<TestServer> {
  const state = {
    requests: [] as RecordedRequest[],
    connections: 0,
    tcpConnections: 0,
    bytesReceived: 0,
  };
  const server = https.createServer({ key: pair.key, cert: pair.cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      state.requests.push(recorded);
      handler(recorded, res);
    });
  });
  server.on('secureConnection', (socket: TLSSocket) => {
    state.connections++;
    socket.on('data', (chunk: Buffer) => {
      state.bytesReceived += chunk.length;
    });
  });
  server.on('connection', () => {
    state.tcpConnections++;
  });
  // Clients that fail the pin check close right after the handshake.
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `https://127.0.0.1:${port}`,
    port,
    get requests() {
      return state.requests;
    },
    get connections() {
      return state.connections;
    },
    get tcpConnections() {
      return state.tcpConnections;
    },
    get bytesReceived() {
      return state.bytesReceived;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  statusMessage?: string,
): void {
  const text = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) };
  if (statusMessage !== undefined) res.writeHead(status, statusMessage, headers);
  else res.writeHead(status, headers);
  res.end(text);
}
