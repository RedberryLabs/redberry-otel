// Vercel Blob, in the customer's own (private) Blob store. The options are the ones the spike proved
// on @vercel/blob 2.8.2: a private object, at exactly the given path, and a second put of the same path
// refused ("This blob already exists"). That is no-overwrite, not immutability: anyone holding the
// store's read-write token can delete and re-put. The tamper evidence is the signed hash VALP keeps.
import type { put as blobPut } from '@vercel/blob';
import { StoreConflictError, type Store } from './types';

type PutFn = typeof blobPut;

export interface VercelBlobOptions {
  /** Blob read-write token; default: @vercel/blob's own default (``BLOB_READ_WRITE_TOKEN``). */
  token?: string;
  /** For tests: a stand-in for @vercel/blob's ``put``. */
  put?: PutFn;
}

/** @deprecated In-process hashing is replaced by sending spans to the Redberry ingest service in your cloud: use redberryExporter() or init(). */
export function vercelBlob(options: VercelBlobOptions = {}): Store {
  let putFn: Promise<PutFn> | undefined;
  const load = (): Promise<PutFn> =>
    (putFn ??= options.put
      ? Promise.resolve(options.put)
      : import('@vercel/blob').then((m) => m.put, (e: unknown) => {
          putFn = undefined;
          throw new Error(`vercelBlob() needs the @vercel/blob package installed: ${String(e)}`);
        }));
  return {
    kind: 'vercel-blob',
    async put(path, bytes) {
      const put = await load();
      try {
        const r = await put(path, new Blob([bytes.slice().buffer as ArrayBuffer]), {
          access: 'private',
          addRandomSuffix: false,
          allowOverwrite: false,
          contentType: 'application/gzip',
          ...(options.token ? { token: options.token } : {}),
        });
        return { url: r.url };
      } catch (e) {
        if (/already exists/i.test(String((e as Error)?.message ?? e))) throw new StoreConflictError(path, 'vercel-blob');
        throw e;
      }
    },
  };
}
