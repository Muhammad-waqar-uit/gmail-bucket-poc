export const BASE_BUCKET = '_root';

export type StoreMode = 'drive' | 'gmail' | 'memory';

export interface Status {
  mode: StoreMode;
  reason: string;
  base: string;
  /** Link to the base folder in the provider's UI (Drive only). */
  baseUrl?: string;
  baseBucket: string;
  rootLabel: string;
  maxUploadBytes: number;
  chunkBytes: number;
}

export interface ObjectInfo {
  key: string;
  size: number;
  contentType: string;
  etag: string;
  lastModified: string;
  metadata: Record<string, string>;
  /** Provider link, e.g. a Drive webViewLink (absent on Gmail/memory). */
  url?: string;
}

export interface PutResult {
  etag: string;
  size: number;
}

const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/');

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* not json */
    }
    throw new Error(message);
  }
  const contentType = res.headers.get('content-type') ?? '';
  return (contentType.includes('application/json') ? res.json() : res) as Promise<T>;
}

export const bucketPath = (bucket: string) => `/buckets/${encodeURIComponent(bucket)}`;

export const objectPath = (bucket: string, key: string) =>
  `${bucketPath(bucket)}/objects/${encodeKey(key)}`;

export const objectUrl = (bucket: string, key: string, download = false) =>
  `/api${objectPath(bucket, key)}${download ? '?download=1' : ''}`;

export const api = {
  status: () => request<Status>('/status'),

  buckets: async () => (await request<{ buckets: string[] }>('/buckets')).buckets,

  createBucket: (bucket: string) => request<{ ok: true }>(bucketPath(bucket), { method: 'PUT' }),

  deleteBucket: (bucket: string, force = false) =>
    request<{ ok: true }>(`${bucketPath(bucket)}${force ? '?force=1' : ''}`, { method: 'DELETE' }),

  objects: async (bucket: string, prefix: string) => {
    const query = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
    return (await request<{ objects: ObjectInfo[] }>(`${bucketPath(bucket)}${query}`)).objects;
  },

  deleteObject: (bucket: string, key: string) =>
    request<{ ok: true }>(objectPath(bucket, key), { method: 'DELETE' }),

  /** Move or rename an object; omit a key/bucket to keep it. */
  moveObject: (fromBucket: string, fromKey: string, toBucket: string, toKey: string) =>
    request<ObjectInfo>(objectPath(fromBucket, fromKey), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bucket: toBucket, key: toKey }),
    }),

  /** Upload with real progress events (fetch has no upload progress). */
  upload: (bucket: string, key: string, file: File, onProgress?: (ratio: number) => void) =>
    new Promise<PutResult>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `/api${objectPath(bucket, key)}`);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText) as PutResult);
          } catch {
            resolve({ etag: '', size: file.size });
          }
          return;
        }
        let message = xhr.statusText || `upload failed (${xhr.status})`;
        try {
          const body = JSON.parse(xhr.responseText) as { error?: string };
          if (body?.error) message = body.error;
        } catch {
          /* not json */
        }
        reject(new Error(message));
      };
      xhr.onerror = () => reject(new Error('network error'));
      xhr.send(file);
    }),
};

export const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
