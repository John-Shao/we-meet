import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const MARKER = "wemeet-clipboard-source-v1:";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_TTL_MS = 5 * 60 * 1000;
const signingKey = randomBytes(32);

export interface ClipboardProvenance {
  derived: boolean;
  sources: string[];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sign(payload: string): string {
  return createHmac("sha256", signingKey).update(payload).digest("base64url");
}

export function createClipboardHtml(
  text: string,
  versionId: string | null,
  nowMs = Date.now(),
): string {
  if (!UUID_V4.test(versionId ?? "")) {
    return `<!doctype html><meta charset="utf-8"><pre>${escapeHtml(text)}</pre>`;
  }
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      version_id: versionId,
      content_hash: createHash("sha256").update(text).digest("hex"),
      expires_at: nowMs + TOKEN_TTL_MS,
    }),
  ).toString("base64url");
  const token = `${payload}.${sign(payload)}`;
  return `<!doctype html><meta charset="utf-8"><pre>${escapeHtml(text)}</pre><!--${MARKER}${token}-->`;
}

export function readClipboardProvenance(
  html: string,
  text: string,
  nowMs = Date.now(),
): ClipboardProvenance {
  const tokens = html.split(MARKER);
  if (tokens.length === 1) return { derived: true, sources: [] };
  if (tokens.length !== 2 || !tokens[1].endsWith("-->")) {
    return { derived: true, sources: [] };
  }
  try {
    const token = tokens[1].slice(0, -3);
    const parts = token.split(".");
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0])) {
      throw new Error("invalid token");
    }
    const expected = Buffer.from(sign(parts[0]), "base64url");
    const actual = Buffer.from(parts[1], "base64url");
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected) ||
      Buffer.from(parts[0], "base64url").toString("base64url") !== parts[0]
    ) {
      throw new Error("invalid token");
    }
    const value: unknown = JSON.parse(
      Buffer.from(parts[0], "base64url").toString("utf8"),
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("invalid token");
    }
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !==
        "content_hash,expires_at,v,version_id" ||
      record.v !== 1 ||
      typeof record.version_id !== "string" ||
      !UUID_V4.test(record.version_id) ||
      typeof record.content_hash !== "string" ||
      record.content_hash !== createHash("sha256").update(text).digest("hex") ||
      typeof record.expires_at !== "number" ||
      !Number.isSafeInteger(record.expires_at) ||
      record.expires_at <= nowMs ||
      record.expires_at > nowMs + TOKEN_TTL_MS
    ) {
      throw new Error("invalid token");
    }
    return { derived: true, sources: [record.version_id] };
  } catch {
    return { derived: true, sources: [] };
  }
}
