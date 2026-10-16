import { createHash, randomUUID } from "node:crypto";
import { canonical } from "./authorization";
import { bytesFromUuid, type NativeDisplay } from "./wire";

type Rect = { x: number; y: number; width: number; height: number };
export type CaptureSource = { id: string; display_id: string };
export type ScreenDisplay = { id: number; bounds: Rect; scaleFactor: number; rotation: number };
export type SourceBinding = Readonly<{
  shareInstanceId: string; sourceId: string; electronDisplayId: string;
  native: Readonly<NativeDisplay>; dipBounds: Readonly<Rect>; scaleMilli: number;
  displayBindingHash: string;
}>;

function rectangle(value: Rect) {
  if (!value || Object.values(value).some(n => !Number.isSafeInteger(n)) ||
    value.width < 1 || value.height < 1 || value.width > 65536 || value.height > 65536) throw new Error("display_mapping_unavailable");
}

/** Main only: all arguments come from Electron/native enumeration, never IPC rects.
 * Convert native pixel rectangles to DIP with screen.screenToDipRect. Electron
 * encloses fractional DIP bounds, so converting them back to pixels can enlarge
 * a monitor (3072x1920 at 175% becomes 3073x1922). Keep the native pixel rectangle
 * authoritative, require one exact DIP match, and reject ambiguous conversions.
 */
export function bindScreenSource(source: CaptureSource, displays: ScreenDisplay[], nativeDisplays: NativeDisplay[],
  coordinates: { toDip: (rect: Rect) => Rect }, shareInstanceId = randomUUID()): SourceBinding {
  bytesFromUuid(shareInstanceId);
  if (!source || !/^screen:[^:\s]+:[^:\s]+$/.test(source.id) || !source.display_id) throw new Error("full_display_required");
  const matches = displays.filter(display => String(display.id) === source.display_id);
  if (matches.length !== 1) throw new Error("display_mapping_unavailable");
  const display = matches[0];rectangle(display.bounds);
  if (!Number.isSafeInteger(display.id) || display.id === -1 || !Number.isFinite(display.scaleFactor) ||
    display.scaleFactor < .5 || display.scaleFactor > 8 || ![0,90,180,270].includes(display.rotation)) throw new Error("display_mapping_unavailable");
  const nativeMatches = nativeDisplays.filter(item => {
    const physical = { x: item.left, y: item.top, width: item.width, height: item.height };rectangle(physical);
    const dip = coordinates.toDip(physical);rectangle(dip);
    return dip.x === display.bounds.x && dip.y === display.bounds.y &&
      dip.width === display.bounds.width && dip.height === display.bounds.height;
  });
  if (nativeMatches.length !== 1) throw new Error("display_mapping_unavailable");
  const native = nativeMatches[0], dpi = Math.round(display.scaleFactor*96);
  if (!native.deviceName || !native.devicePath || native.rotation !== display.rotation || native.dpiX !== dpi || native.dpiY !== dpi ||
      native.deviceName.length > 128 || native.devicePath.length > 4096) throw new Error("display_mapping_unavailable");
  const binding = {
    shareInstanceId, sourceId: source.id, electronDisplayId: source.display_id,
    native: Object.freeze({ left: native.left, top: native.top, width: native.width, height: native.height,
      deviceName: native.deviceName, devicePath: native.devicePath, rotation: native.rotation, dpiX: native.dpiX, dpiY: native.dpiY }),
    dipBounds: Object.freeze({ ...display.bounds }), scaleMilli: Math.round(display.scaleFactor*1000),
  };
  return Object.freeze({ ...binding, displayBindingHash: createHash("sha256").update(canonical({v:1,...binding})).digest("hex") });
}

/** One capture instance per window/login; pending records precede the media callback. */
export class CaptureBindingStore {
  private value?: { binding: SourceBinding; authEpoch: number; deadline: number; trackSid?: string };
  constructor(private readonly now = () => performance.now()) {}
  selected(binding: SourceBinding, authEpoch: number, preparationMs = 60000) {
    if (!Number.isSafeInteger(authEpoch) || !Number.isInteger(preparationMs) || preparationMs < 1 || preparationMs > 60000) throw new Error("invalid_capture_intent");
    this.value = { binding, authEpoch, deadline: this.now()+preparationMs };
  }
  pending(authEpoch: number): SourceBinding | undefined {
    const value = this.current(authEpoch);
    return value && !value.trackSid ? value.binding : undefined;
  }
  // Caller must first validate real track ownership/source with the cloud. The
  // renderer can only refer to a pending share ID, not supply a source/rectangle.
  published(shareInstanceId: string, trackSid: string, authEpoch: number) {
    const value = this.current(authEpoch);
    if (!value || value.binding.shareInstanceId !== shareInstanceId || !/^TR_[A-Za-z0-9_-]{1,120}$/.test(trackSid) ||
      (value.trackSid && value.trackSid !== trackSid)) throw new Error("capture_binding_mismatch");
    value.trackSid = trackSid;
    return { binding: value.binding, trackSid };
  }
  active(authEpoch: number) {
    const value = this.current(authEpoch);
    return value?.trackSid ? { binding: value.binding, trackSid: value.trackSid } : undefined;
  }
  invalidate() { this.value = undefined; }
  private current(authEpoch: number) {
    if (this.value && (authEpoch !== this.value.authEpoch || (!this.value.trackSid && this.now() >= this.value.deadline))) this.invalidate();
    return this.value;
  }
}
