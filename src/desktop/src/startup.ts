import type { BrowserWindow } from "electron";

/** Reload/navigation can supersede the initial load; it is not install damage. */
export async function loadInitialPage(
  window: Pick<BrowserWindow, "loadURL">,
  url: string,
): Promise<void> {
  try {
    await window.loadURL(url);
  } catch (error) {
    const failure = error as { code?: string; errno?: number } | null;
    if (failure?.code === "ERR_ABORTED" || failure?.errno === -3) return;
    throw error;
  }
}
