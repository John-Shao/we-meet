import { protocol } from "electron";
import {
  VIEWER_CSP,
  VIEWER_SCHEME,
  VIEWER_SCHEME_PRIVILEGES,
  ViewerAssetError,
  readViewerAsset,
} from "./viewer-assets";

export function registerViewerScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: VIEWER_SCHEME, privileges: VIEWER_SCHEME_PRIVILEGES },
  ]);
}

export function installViewerProtocol(bundleDir: string): void {
  protocol.handle(VIEWER_SCHEME, async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, {
        status: 405,
        headers: {
          "Content-Security-Policy": VIEWER_CSP,
          "Cache-Control": "no-store",
        },
      });
    }
    try {
      const asset = await readViewerAsset(bundleDir, request.url);
      return new Response(
        request.method === "HEAD" ? null : Uint8Array.from(asset.body),
        {
          status: 200,
          headers: asset.headers,
        },
      );
    } catch (error) {
      const status = error instanceof ViewerAssetError ? 403 : 404;
      return new Response(status === 403 ? "Forbidden" : "Not Found", {
        status,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Security-Policy": VIEWER_CSP,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    }
  });
}
