import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const VIEWER_SCHEME = "wemeet-local";
export const VIEWER_HOST = "viewer";
export const VIEWER_SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true,
  stream: true,
  bypassCSP: false,
  allowServiceWorkers: false,
  codeCache: false,
} as const;

export const VIEWER_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const MAX_VIEWER_ASSET_BYTES = 8 * 1024 * 1024;
const VIEWER_MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
} as const;

export class ViewerAssetError extends Error {}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export async function resolveViewerAsset(
  bundleDir: string,
  rawUrl: string,
): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ViewerAssetError("invalid viewer URL");
  }
  if (
    url.protocol !== VIEWER_SCHEME + ":" ||
    url.hostname !== VIEWER_HOST ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ViewerAssetError("viewer URL is outside the local bundle");
  }
  if (/%2f|%5c/i.test(url.pathname))
    throw new ViewerAssetError("encoded path separator");
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    throw new ViewerAssetError("invalid viewer path encoding");
  }
  if (
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    !decoded.startsWith("/")
  ) {
    throw new ViewerAssetError("invalid viewer path");
  }
  const segments = decoded.slice(1).split("/");
  if (segments.some((segment) => segment === ".." || segment === ".")) {
    throw new ViewerAssetError("viewer path traversal");
  }
  const extension = path.extname(decoded).toLowerCase();
  if (!Object.hasOwn(VIEWER_MIME, extension))
    throw new ViewerAssetError("viewer asset type is not allowed");

  const root = await realpath(bundleDir);
  const candidate = path.resolve(root, "." + path.posix.normalize(decoded));
  if (!inside(root, candidate))
    throw new ViewerAssetError("viewer asset escapes bundle");
  const realCandidate = await realpath(candidate);
  if (!inside(root, realCandidate))
    throw new ViewerAssetError("viewer symlink escapes bundle");
  const info = await lstat(realCandidate);
  if (!info.isFile() || info.isSymbolicLink())
    throw new ViewerAssetError("viewer asset is not a regular file");
  return realCandidate;
}

export function viewerContentType(file: string): string {
  return VIEWER_MIME[
    path.extname(file).toLowerCase() as keyof typeof VIEWER_MIME
  ];
}

export function viewerSecurityHeaders(file: string): Record<string, string> {
  return {
    "Content-Type": viewerContentType(file),
    "Content-Security-Policy": VIEWER_CSP,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  };
}

export async function readViewerAsset(
  bundleDir: string,
  rawUrl: string,
): Promise<{ body: Buffer; headers: Record<string, string> }> {
  const file = await resolveViewerAsset(bundleDir, rawUrl);
  const info = await stat(file);
  if (info.size > MAX_VIEWER_ASSET_BYTES)
    throw new ViewerAssetError("viewer asset exceeds size limit");
  return { body: await readFile(file), headers: viewerSecurityHeaders(file) };
}
