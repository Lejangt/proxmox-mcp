import {
  InMemoryTransport,
  type JSONRPCMessage,
  type McpServer,
} from '@modelcontextprotocol/server';

type Json = Record<string, unknown>;

export interface Harness {
  /** Sends a request and resolves with its result, rejects with the JSON-RPC error. */
  request(method: string, params?: Json): Promise<Json>;
  callTool(name: string, args?: Json): Promise<Json>;
  /** Server to client requests received so far. */
  incoming: Array<{ method: string; params: Json }>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  capabilities?: Json;
  /** Answers server to client requests such as elicitation/create. */
  onRequest?: (method: string, params: Json) => Json;
}

/**
 * Minimal MCP client over an in-memory transport: no client package is needed
 * and the 2025-era handshake is exercised exactly as stdio clients do it.
 */
export async function connect(server: McpServer, opts: HarnessOptions = {}): Promise<Harness> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  const incoming: Harness['incoming'] = [];
  let nextId = 1;

  clientSide.onmessage = (msg: JSONRPCMessage) => {
    const m = msg as unknown as Json;
    if (typeof m.method === 'string' && m.id !== undefined) {
      const params = (m.params ?? {}) as Json;
      incoming.push({ method: m.method, params });
      const result = opts.onRequest ? opts.onRequest(m.method, params) : {};
      void clientSide.send({ jsonrpc: '2.0', id: m.id, result } as unknown as JSONRPCMessage);
      return;
    }
    if (typeof m.id === 'number') {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (!p) return;
      if (m.error) p.reject(new Error(JSON.stringify(m.error)));
      else p.resolve(m.result as Json);
    }
  };

  await server.connect(serverSide);
  await clientSide.start();

  const request = (method: string, params: Json = {}): Promise<Json> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      void clientSide.send({ jsonrpc: '2.0', id, method, params } as unknown as JSONRPCMessage);
    });

  await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: opts.capabilities ?? {},
    clientInfo: { name: 'test-client', version: '0.0.0' },
  });
  await clientSide.send({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  } as unknown as JSONRPCMessage);

  return {
    request,
    callTool: (name, args = {}) => request('tools/call', { name, arguments: args }),
    incoming,
    close: () => clientSide.close(),
  };
}

export function textOf(result: Json): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content.map((c) => c.text).join('\n');
}
