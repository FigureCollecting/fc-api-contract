// RFC 9562 name-based uuid, version 5 (SHA-1). Test-only: the package ships the namespace and
// the name format, and the coordinator computes the ids; this checks the golden ones.
import { createHash } from 'node:crypto';

export function uuidv5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replaceAll('-', ''), 'hex');
  const hash = createHash('sha1').update(ns).update(name, 'utf8').digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
