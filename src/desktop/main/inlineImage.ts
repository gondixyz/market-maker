/** The largest image inlined, in bytes; a bigger one shows the window's placeholder instead. */
export const MAX_IMAGE_BYTES = 1_000_000;

/**
 * The image at `url` as a `data:` URL, so the window shows it without loading anything remote:
 * its CSP allows images from itself and `data:` only. Throws for a URL that is not http(s), a
 * failed download, a body that is not an image, or one over `MAX_IMAGE_BYTES`.
 *
 * IMPLEMENTATION NOTE: `fetch`'s `Response.headers.get('content-type')` is the served media type,
 * and `arrayBuffer()` the body (https://developer.mozilla.org/en-US/docs/Web/API/Response). An
 * image an `<img>` shows, SVG included, runs no script
 * (https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image).
 */
export const inlineImage = async (url: string, download: typeof fetch = fetch) => {
  const { protocol } = new URL(url);
  if (protocol !== 'https:' && protocol !== 'http:') throw new Error(`not a web URL: ${url}`);
  const response = await download(url);
  if (!response.ok) throw new Error(`the image answered ${response.status}`);
  const type = response.headers.get('content-type')?.split(';')[0].trim() ?? '';
  if (!type.startsWith('image/')) throw new Error(`not an image: ${type}`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('the image is too large');
  return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
};
