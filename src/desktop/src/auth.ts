import { randomBytes, createHash } from "node:crypto";
import { CALLBACK, callbackCode, DesktopConfig } from "./policy";

interface Tokens {
  access: string;
  refresh: string;
  expiresAt: number;
  subject: string;
}
interface Pending {
  state: string;
  verifier: string;
  nonce: string;
  expiresAt: number;
  generation: number;
}
interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint?: string;
}
export interface AuthStore {
  read(): string | undefined;
  write(value: string): void;
  clear(): void;
}

/** Tokens never cross the preload bridge or enter renderer storage. */
export class DesktopAuth {
  private tokens?: Tokens;
  private pending?: Pending;
  private discovery?: Discovery;
  private generation = 0;
  private refreshing?: Promise<void>;
  constructor(
    private config: DesktopConfig,
    private store: AuthStore,
    private fetcher: typeof fetch = fetch,
    private onSessionExpired: () => void = () => {},
  ) {
    try {
      const saved = JSON.parse(store.read() || "null");
      if (
        saved?.issuer === config.issuer &&
        saved?.clientId === config.clientId &&
        saved?.serviceOrigin === config.serviceOrigin &&
        typeof saved.tokens?.refresh === "string" &&
        typeof saved.tokens?.access === "string" &&
        typeof saved.tokens?.subject === "string" &&
        Number.isFinite(saved.tokens?.expiresAt)
      )
        this.tokens = saved.tokens;
    } catch {
      store.clear();
    }
  }
  get epoch() {
    return this.generation;
  }
  get signedIn() {
    return !!this.tokens;
  }
  get loginPending() {
    return !!this.pending && this.pending.expiresAt > Date.now();
  }
  cancelLogin() {
    this.pending = undefined;
    this.generation++;
  }

  private async discover(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const response = await this.fetcher(
      `${this.config.issuer}/.well-known/openid-configuration`,
      {
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) throw new Error("登录服务暂不可用，请稍后重试。");
    const data = (await response.json()) as Discovery;
    if (data.issuer !== this.config.issuer)
      throw new Error("登录服务配置不匹配。");
    for (const endpoint of [
      data.authorization_endpoint,
      data.token_endpoint,
      data.jwks_uri,
    ]) {
      const url = new URL(endpoint);
      if (
        url.origin !== new URL(this.config.issuer).origin ||
        url.username ||
        url.password ||
        url.hash
      ) {
        throw new Error("登录服务配置不匹配。");
      }
    }
    return (this.discovery = data);
  }

  async begin(): Promise<string> {
    const epoch = this.generation;
    const d = await this.discover();
    if (epoch !== this.generation) throw new Error("登录已取消。");
    const pending = {
      state: randomBytes(32).toString("base64url"),
      verifier: randomBytes(32).toString("base64url"),
      nonce: randomBytes(32).toString("base64url"),
      expiresAt: Date.now() + 300000,
      generation: epoch,
    };
    this.pending = pending;
    const url = new URL(d.authorization_endpoint);
    for (const [key, value] of Object.entries({
      client_id: this.config.clientId,
      redirect_uri: CALLBACK,
      response_type: "code",
      scope: "openid profile email",
      state: pending.state,
      nonce: pending.nonce,
      prompt: "select_account",
      code_challenge: createHash("sha256")
        .update(pending.verifier)
        .digest("base64url"),
      code_challenge_method: "S256",
    }))
      url.searchParams.set(key, value);
    return url.href;
  }

  async complete(raw: string): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.expiresAt < Date.now())
      throw new Error("登录已过期，请重新登录。");
    const code = callbackCode(raw, pending.state);
    this.pending = undefined; // Consume before any asynchronous exchange; duplicates cannot redeem.
    const d = await this.discover();
    const data = await this.exchange(d.token_endpoint, {
      grant_type: "authorization_code",
      code,
      code_verifier: pending.verifier,
      redirect_uri: CALLBACK,
    });
    const { createRemoteJWKSet, jwtVerify } = await import("jose");
    const { payload } = await jwtVerify(
      data.id_token,
      createRemoteJWKSet(new URL(d.jwks_uri)),
      {
        issuer: this.config.issuer,
        audience: this.config.clientId,
        algorithms: ["RS256"],
        requiredClaims: ["sub", "exp", "iat", "nonce"],
      },
    );
    if (
      payload.nonce !== pending.nonce ||
      !payload.sub ||
      (payload.azp && payload.azp !== this.config.clientId)
    )
      throw new Error("登录响应校验失败。");
    this.commit(data, payload.sub, pending.generation, true);
  }

  private async exchange(endpoint: string, fields: Record<string, string>) {
    const response = await this.fetcher(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      body: new URLSearchParams({ ...fields, client_id: this.config.clientId }),
    });
    const data = await response.json();
    if (!response.ok) {
      if (data.error === "invalid_grant") throw new InvalidGrant();
      throw new Error("登录服务暂不可用，请稍后重试。");
    }
    if (
      typeof data.access_token !== "string" ||
      !data.access_token ||
      typeof data.refresh_token !== "string" ||
      !data.refresh_token ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0 ||
      String(data.token_type).toLowerCase() !== "bearer"
    )
      throw new Error("登录响应不完整。");
    return data;
  }

  private commit(
    data: { access_token: string; refresh_token: string; expires_in: number },
    subject: string,
    epoch: number,
    newSession = false,
  ) {
    if (epoch !== this.generation) throw new Error("登录已取消。");
    const tokens = {
      access: data.access_token,
      refresh: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      subject,
    };
    this.store.write(JSON.stringify({ ...this.config, tokens }));
    if (newSession) this.generation++; // Fence requests belonging to the previous account.
    this.tokens = tokens;
  }

  async access(): Promise<string | undefined> {
    if (!this.tokens) return;
    if (this.tokens.expiresAt < Date.now() + 30000) {
      if (!this.refreshing) {
        const previous = this.tokens;
        const epoch = this.generation;
        this.refreshing = (async () => {
          try {
            const d = await this.discover();
            const data = await this.exchange(d.token_endpoint, {
              grant_type: "refresh_token",
              refresh_token: previous.refresh,
            });
            this.commit(data, previous.subject, epoch);
          } catch (error) {
            if (error instanceof InvalidGrant && epoch === this.generation) {
              this.clear();
              this.onSessionExpired();
            } else throw error;
          }
        })().finally(() => {
          this.refreshing = undefined;
        });
      }
      await this.refreshing;
    }
    return this.tokens?.access;
  }

  clear() {
    this.generation++;
    this.pending = undefined;
    this.tokens = undefined;
    this.store.clear();
  }
}
class InvalidGrant extends Error {
  constructor() {
    super("登录已失效，请重新登录。");
  }
}
