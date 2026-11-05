export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export type ParamValue = string | number | boolean | undefined | null;
export type Params = Record<string, ParamValue | ParamValue[]>;

/** A Proxmox response with `data` and the other top level fields (for example `total` or `changes`). */
export interface ApiEnvelope<T> {
  data: T;
  /** Every top level field of the response except `data`. Untrusted Proxmox data. */
  meta: Record<string, unknown>;
}

export interface ProxmoxClient {
  readonly alias: string;
  readonly readOnly: boolean;
  request<T = unknown>(method: HttpMethod, path: string, params?: Params): Promise<T>;
  get<T = unknown>(path: string, params?: Params): Promise<T>;
  /**
   * GET that also returns the top level fields next to `data`, such as
   * `total` of task logs and lists or `changes` of the node network.
   */
  getEnvelope<T = unknown>(path: string, params?: Params): Promise<ApiEnvelope<T>>;
  post<T = unknown>(path: string, params?: Params): Promise<T>;
  put<T = unknown>(path: string, params?: Params): Promise<T>;
  delete<T = unknown>(path: string, params?: Params): Promise<T>;
  /**
   * The API schema that the host serves at /pve-docs/api-viewer/apidoc.js,
   * parsed as JSON (never evaluated) and cached per client.
   */
  apiSchema(): Promise<unknown[]>;
}

export interface HostInfo {
  alias: string;
  description?: string;
  url: string;
  readOnly: boolean;
  isDefault: boolean;
}

export interface HostRegistry {
  list(): HostInfo[];
  aliases(): string[];
  defaultAlias(): string | undefined;
  /** Throws a helpful error listing the known aliases when the alias is unknown. */
  client(alias?: string): Promise<ProxmoxClient>;
}
