import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Session } from "electron";
import { assetPath, isApi, sameOrigin } from "./policy";
import type { DesktopAuth } from "./auth";

/** Preserve the web origin in an isolated session; serve packaged UI locally.
 * API calls use the native account. No OS/DNS/TLS override is used.
 */
export function installRenderer(
  session: Session,
  root: string,
  origin: string,
  auth: DesktopAuth,
  network: (online: boolean) => void,
  apiFetch: typeof fetch = fetch,
  externalFetch?: (request: Request) => Promise<Response>,
) {
  session.protocol.handle(
    new URL(origin).protocol.slice(0, -1),
    async (request) => {
      if (!sameOrigin(request.url, origin)) {
        // Electron fetch forwards headers but omits Request.referrer. Preserve
        // Chromium's original referrer; never invent a trusted source for CSRF.
        const headers = new Headers(request.headers);
        if (!headers.has("referer") && request.referrer &&
            /^https?:\/\//.test(request.referrer)) {
          headers.set("referer", request.referrer);
        }
        if (externalFetch) return externalFetch(new Request(request, { headers }));
        return session.fetch(request, { headers, bypassCustomProtocolHandlers: true });
      }
      const url = new URL(request.url);
      if (isApi(url.pathname)) {
        const initiator = (request as Request & { initiatorOrigin?: string })
          .initiatorOrigin;
        if (
          (initiator !== undefined && initiator !== origin) ||
          (request.headers.has("origin") &&
            request.headers.get("origin") !== origin)
        )
          return new Response("Forbidden", { status: 403 });
        const epoch = auth.epoch;
        try {
          const headers = new Headers(request.headers);
          headers.delete("authorization");
          headers.delete("cookie");
          const access = await auth.access();
          if (epoch !== auth.epoch) return new Response(null, { status: 401 });
          if (access) headers.set("authorization", `Bearer ${access}`);
          // Electron net.fetch rejects manual redirects. Node fetch preserves the
          // 30x response so Chromium can follow it WITHOUT the native bearer header.
          const deadline = new AbortController();
          const timer = setTimeout(() => deadline.abort(), 120000);
          let response: Response;
          try {
            response = await apiFetch(request, {
              headers,
              credentials: "omit",
              redirect: "manual",
              signal: AbortSignal.any([request.signal, deadline.signal]),
            });
          } finally {
            // Limit connection/header waiting, not a live response body (SSE or
            // a large download). Renderer cancellation still stops the stream.
            clearTimeout(timer);
          }
          if (epoch !== auth.epoch) return new Response(null, { status: 401 });
          network(true);
          // Writes are not replayed after 401. An explicit user retry is required.
          const responseHeaders = new Headers(response.headers);
          // Node fetch has already decoded the body. Native auth owns the account;
          // API responses must not create a second Django cookie login alongside it.
          responseHeaders.delete("content-encoding");
          responseHeaders.delete("content-length");
          responseHeaders.delete("set-cookie");
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
          });
        } catch {
          network(false);
          return Response.json(
            { detail: "服务连接失败，请检查网络后重试。" },
            { status: 503 },
          );
        }
      }
      if (!["GET", "HEAD"].includes(request.method))
        return new Response(null, { status: 405 });
      const candidate = assetPath(root, url.pathname);
      if (url.pathname !== "/" && !candidate)
        return new Response(null, { status: 400 });
      if (
        candidate &&
        (await stat(candidate)
          .then((s) => s.isFile())
          .catch(() => false))
      ) {
        return session.fetch(pathToFileURL(candidate).href, {
          bypassCustomProtocolHandlers: true,
        });
      }
      if (
        path.extname(url.pathname) &&
        !request.headers.get("accept")?.includes("text/html")
      )
        return new Response(null, { status: 404 });
      return session.fetch(pathToFileURL(path.join(root, "index.html")).href, {
        bypassCustomProtocolHandlers: true,
      });
    },
  );
}
