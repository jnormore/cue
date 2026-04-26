/**
 * Tiny extension → MIME map for serving agent-uploaded artifacts.
 * Covers the common web cases without a dependency. Unknown
 * extensions fall through to `application/octet-stream`.
 *
 * Extension matching is case-insensitive on the dotted suffix.
 * Multi-part extensions (e.g. `.tar.gz`) match the last segment.
 */
const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "application/javascript",
  mjs: "application/javascript",
  css: "text/css",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/vnd.microsoft.icon",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  wasm: "application/wasm",
  xml: "application/xml",
};

export const DEFAULT_MIME = "application/octet-stream";

export function detectMimeType(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0 || dot === path.length - 1) return DEFAULT_MIME;
  const ext = path.slice(dot + 1).toLowerCase();
  return TYPES[ext] ?? DEFAULT_MIME;
}
