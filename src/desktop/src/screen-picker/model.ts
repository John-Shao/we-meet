import { randomUUID } from "node:crypto";
import type { ScreenPickerItem } from "./bridge";

/** Structural subset of Electron's NativeImage so display text and tokens can be
 * unit-tested without a running Electron process. */
export type CaptureImage = {
  isEmpty(): boolean;
  toJPEG(quality: number): Buffer;
  toDataURL(): string;
};

export type CaptureSource = {
  id: string;
  name: string;
  display_id: string;
  thumbnail?: CaptureImage | null;
  appIcon?: CaptureImage | null;
};

export type CaptureDisplay = {
  id: number;
  label?: string;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
};

export type PickerEntry<T extends CaptureSource> = {
  item: ScreenPickerItem;
  source: T;
};

const clean = (value: unknown) =>
  typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120)
    : "";

function thumbnailUrl(image?: CaptureImage | null) {
  try {
    if (!image || image.isEmpty()) return undefined;
    const jpeg = image.toJPEG(78);
    return jpeg.length ? `data:image/jpeg;base64,${jpeg.toString("base64")}` : undefined;
  } catch {
    return undefined;
  }
}

function iconUrl(image?: CaptureImage | null) {
  try {
    if (!image || image.isEmpty()) return undefined;
    const url = image.toDataURL();
    return url.startsWith("data:image/") ? url : undefined;
  } catch {
    return undefined;
  }
}

function resolution(display: CaptureDisplay) {
  const width = Math.round(display.bounds.width * display.scaleFactor);
  const height = Math.round(display.bounds.height * display.scaleFactor);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? `${width} × ${height}`
    : "";
}

/** Names are display text, never source identities. Each call issues fresh opaque
 * tokens; only main resolves them back to DesktopCapturerSource instances. */
export function buildPickerEntries<T extends CaptureSource>(
  sources: readonly T[],
  displays: readonly CaptureDisplay[],
  options: { excludeId?: string; token?: () => string } = {},
): { screens: PickerEntry<T>[]; windows: PickerEntry<T>[] } {
  const nextToken = options.token ?? randomUUID;
  const seen = new Set<string>();
  const usable = sources.filter((source) => {
    if (!source || typeof source.id !== "string" || !source.id) return false;
    if (source.id === options.excludeId || seen.has(source.id)) return false;
    seen.add(source.id);
    return true;
  });
  const screenSources = usable.filter((source) => source.id.startsWith("screen:"));
  const windowSources = usable.filter((source) => source.id.startsWith("window:"));
  const byDisplay = new Map<string, T>();
  for (const source of screenSources) {
    if (source.display_id && !byDisplay.has(source.display_id))
      byDisplay.set(source.display_id, source);
  }
  const screens: PickerEntry<T>[] = [];
  const used = new Set<string>();
  for (const display of displays) {
    const source = byDisplay.get(String(display.id));
    if (!source || used.has(source.id)) continue;
    used.add(source.id);
    screens.push({
      source,
      item: {
        token: nextToken(),
        title: `桌面 ${screens.length + 1}`,
        subtitle:
          [clean(display.label), resolution(display)].filter(Boolean).join(" · ") ||
          undefined,
        thumbnail: thumbnailUrl(source.thumbnail),
      },
    });
  }
  for (const source of screenSources) {
    if (used.has(source.id)) continue;
    used.add(source.id);
    screens.push({
      source,
      item: {
        token: nextToken(),
        title: `桌面 ${screens.length + 1}`,
        subtitle: clean(source.name) || undefined,
        thumbnail: thumbnailUrl(source.thumbnail),
      },
    });
  }
  return {
    screens,
    windows: windowSources.map((source) => ({
      source,
      item: {
        token: nextToken(),
        title: clean(source.name) || "未命名窗口",
        thumbnail: thumbnailUrl(source.thumbnail),
        icon: iconUrl(source.appIcon),
      },
    })),
  };
}
