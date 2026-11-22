// The public address of a derivative (catalog.proto ProductImage.url): the public media base, a slash
// and the derivative_id. One check, so the client that pushes a photo pick and the server that accepts
// it agree on which addresses are public images (sync.proto rule 6 PHOTO PICK).

/** The most characters a public image address has (schemas/photo-pick.schema.json `url`). */
export const PUBLIC_IMAGE_URL_MAX_LENGTH = 512;

/**
 * The form of a public image address, as the photo-pick schema's `url` pattern writes it: https, a
 * lowercase host with an optional port, path segments of unreserved characters that never start with
 * a dot, and a last segment of 64 lowercase hex characters. No credentials, query, fragment,
 * percent-encoding or dot segment can match.
 */
export const PUBLIC_IMAGE_URL_PATTERN = '^https://[a-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)*/[0-9a-f]{64}$';

const FORM = new RegExp(PUBLIC_IMAGE_URL_PATTERN);
const DERIVATIVE_ID = /^[0-9a-f]{64}$/;

/**
 * Whether `value` is the address of a derivative on `mediaBase`: a string in the form above, at most
 * PUBLIC_IMAGE_URL_MAX_LENGTH characters, and exactly `<mediaBase>/<64 lowercase hex>`. Exact, not a
 * prefix: another host, port or path, a path above or below the base, is not on it. `mediaBase` is
 * the server's MEDIA_PUBLIC_BASE_URL (the build's, on a client) read as the coordinator and the spine
 * read it, with trailing slashes trimmed and nothing else; an empty one (images off) holds no address.
 */
export function isPublicImageUrl(value: unknown, mediaBase: string): value is string {
  if (typeof value !== 'string' || typeof mediaBase !== 'string') return false;
  if (value.length > PUBLIC_IMAGE_URL_MAX_LENGTH || !FORM.test(value)) return false;
  let end = mediaBase.length;
  while (end > 0 && mediaBase[end - 1] === '/') end--;
  const prefix = `${mediaBase.slice(0, end)}/`;
  return value.startsWith(prefix) && DERIVATIVE_ID.test(value.slice(prefix.length));
}
