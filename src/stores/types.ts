/** The ``store`` values VALP's hash report accepts. */
export type StoreKind = 'redberry' | 'vercel-blob' | 'gcs' | 'azure-blob' | 's3';

/** What a store may need besides the path and bytes (the Redberry store names the run to VALP). */
export interface PutMeta {
  agentId: string;
  traceId: string;
  /** Lowercase hex SHA-256 of ``bytes``. */
  sha256: string;
  size: number;
}

/**
 * Where a run's bytes go. ``put`` must create the object or fail: it never overwrites. It throws
 * ``StoreConflictError`` when an object is already at ``path``, and any other error when the write failed.
 */
export interface Store {
  readonly kind: StoreKind;
  put(path: string, bytes: Uint8Array, meta: PutMeta): Promise<PutResult>;
}

export interface PutResult {
  /** Where the object is, if the store says (private: not readable without credentials). */
  url?: string;
  /** True when the object was already there and the store guarantees it holds these exact bytes. */
  existing?: boolean;
}

export class StoreConflictError extends Error {
  constructor(path: string, detail?: string) {
    super(`an object already exists at ${path}${detail ? ` (${detail})` : ''}`);
    this.name = 'StoreConflictError';
  }
}
