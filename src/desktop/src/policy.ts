import path from "node:path";

export interface DesktopConfig {
  serviceOrigin: string;
  issuer: string;
  clientId: string;
}

export const CALLBACK = "online.we-meet.desktop://oauth/callback";
export const DEFAULT_CONFIG: DesktopConfig = {
  serviceOrigin: "https://meet.we-meet.online",
  issuer: "https://id.we-meet.online/realms/meet",
  clientId: "desktop",
};

export function validateConfig(
  value: DesktopConfig,
  development = false,
): DesktopConfig {
  const secure = (raw: string) => {
    const url = new URL(raw);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(
          development &&
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost"].includes(url.hostname)
        ))
    )
      throw new Error("Invalid service configuration");
    return url;
  };
  const service = secure(value.serviceOrigin);
  if (
    service.pathname !== "/" ||
    !/^[a-zA-Z0-9._-]{1,100}$/.test(value.clientId)
  ) {
    throw new Error("Invalid service configuration");
  }
  const issuer = secure(value.issuer);
  return {
    serviceOrigin: service.origin,
    issuer: issuer.href.replace(/\/$/, ""),
    clientId: value.clientId,
  };
}

export function sameOrigin(raw: string, origin: string): boolean {
  try {
    const u = new URL(raw);
    return !u.username && !u.password && u.origin === origin;
  } catch {
    return false;
  }
}

export function externalUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      ["https:", "http:", "mailto:"].includes(u.protocol) &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}

/** Decode once, reject Windows separators, drive names, ADS and traversal. */
export function assetPath(root: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return;
  }
  if (
    /[\\:\x00]/.test(decoded) ||
    decoded.split("/").some((p) => p === ".." || p === ".")
  )
    return;
  const target = path.resolve(root, "." + decoded);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    return;
  return target;
}

export function isApi(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname.startsWith("/media/");
}

/** Callback codes are accepted only for a live, matching, single-use attempt. */
export function callbackCode(raw: string, state: string): string {
  const u = new URL(raw);
  if (
    u.origin !== "null" ||
    u.protocol !== "online.we-meet.desktop:" ||
    u.host !== "oauth" ||
    u.pathname !== "/callback" ||
    u.hash ||
    u.username ||
    u.password ||
    u.searchParams.getAll("state").length !== 1 ||
    u.searchParams.get("state") !== state ||
    u.searchParams.getAll("code").length !== 1 ||
    !u.searchParams.get("code") ||
    u.searchParams.has("error")
  )
    throw new Error("Invalid login callback");
  return u.searchParams.get("code")!;
}
