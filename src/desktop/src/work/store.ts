/** The shell-side device record (M2 ruling: safeStorage-encrypted file, the session-v1.enc
 * pattern). GW21's Broker holds the certificate IN MEMORY, so a restart needs the shell to
 * re-deliver it; without this file the 0058 renewal-window gate (a live certificate more than
 * an hour from expiry refuses renewal) would deadlock the device for up to 23 hours.
 * The record is bound to the account and service that paired it: a mismatch reads as absent,
 * never as another account's device. Tokens are NOT here — they stay in DesktopAuth's store. */
export interface DeviceRecord {
  issuer: string;
  clientId: string;
  serviceOrigin: string;
  subject: string;
  orgId: string;
  deviceId: string;
  container: string;
  certificatePem: string;
  certSerial: string;
  certNotAfter: string;
}
export interface DeviceStoreIo {
  read(): string | undefined;
  write(value: string): void;
  clear(): void;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseDeviceRecord(raw: string | undefined): DeviceRecord | undefined {
  if (!raw) return undefined;
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw) as Record<string, unknown>; } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = ["issuer", "clientId", "serviceOrigin", "subject", "orgId", "deviceId", "container",
    "certificatePem", "certSerial", "certNotAfter"];
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) return undefined;
  for (const key of keys) if (typeof value[key] !== "string" || !(value[key] as string)) return undefined;
  const record = value as unknown as DeviceRecord;
  if (!uuid.test(record.deviceId) ||
    !/^[1-9][0-9]{0,38}$/.test(record.certSerial) ||
    !record.certificatePem.includes("-----BEGIN CERTIFICATE-----") ||
    Number.isNaN(Date.parse(record.certNotAfter))) return undefined;
  return record;
}

export class DeviceStore {
  constructor(private readonly io: DeviceStoreIo,
    private readonly binding: { issuer: string; clientId: string; serviceOrigin: string; subject: string }) {}
  load(): DeviceRecord | undefined {
    const record = parseDeviceRecord(this.io.read());
    if (!record) return undefined;
    if (record.issuer !== this.binding.issuer || record.clientId !== this.binding.clientId ||
      record.serviceOrigin !== this.binding.serviceOrigin || record.subject !== this.binding.subject) {
      return undefined;
    }
    return record;
  }
  save(record: DeviceRecord) {
    this.io.write(JSON.stringify(record));
  }
  clear() {
    this.io.clear();
  }
}