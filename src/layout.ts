/**
 * Layout shared by every backend.
 *
 *   base (a Drive folder / Gmail root label / nothing in memory)
 *     bucket-a            -> a folder inside the base
 *       folder/key.txt    -> nested folders inside a bucket
 *     bucket-b
 *
 * The base itself is addressable as the reserved bucket id below, so objects can
 * live "in the main one" without belonging to any bucket.
 */
export const BASE_BUCKET = '_root';

export const BUCKET_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export function assertBucketName(bucket: string): void {
  if (bucket === BASE_BUCKET) throw new Error('The base folder is not a bucket');
  if (!BUCKET_RE.test(bucket)) {
    throw new Error('Bucket names: lowercase letters, numbers, dot, dash, underscore (max 63 chars)');
  }
}
