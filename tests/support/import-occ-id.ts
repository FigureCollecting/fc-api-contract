// HMAC-SHA256 over the import copy's name, and the MAC spelled as an RFC 9562 version 8 uuid,
// written independently of src so the golden ids check the package's formatter, not themselves.
import { createHmac } from 'node:crypto';

export function importOccMac(keyHex: string, name: string): Uint8Array {
  return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(name, 'utf8').digest();
}

export function uuidV8(mac: Uint8Array): string {
  const b = Buffer.from(mac.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
