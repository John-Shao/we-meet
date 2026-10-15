import type { DesktopCapturerSource, Display, MessageBoxOptions } from "electron";

const PAGE_SIZE = 6;
const label = (value: string) => value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, 120);

/** Native paginated selection. Names are display text, never source identities. */
export async function chooseCaptureSource(options: {
  sources: DesktopCapturerSource[]; displays: Display[]; fullScreenOnly: boolean;
  isCurrent: () => boolean; ask: (options: MessageBoxOptions) => Promise<{ response: number }>;
}): Promise<DesktopCapturerSource | undefined> {
  const screens = options.sources.filter(source => source.id.startsWith("screen:"));
  const windows = options.fullScreenOnly ? [] : options.sources.filter(source => source.id.startsWith("window:"));
  const sources = [...screens, ...windows];
  if (!sources.length || new Set(sources.map(source => source.id)).size !== sources.length) return;
  const pages = Math.ceil(sources.length / PAGE_SIZE);
  let page = 0;
  while (options.isCurrent()) {
    const entries = sources.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const labels = entries.map(source => {
      if (source.id.startsWith("window:")) return `窗口：${label(source.name)}`;
      const display = options.displays.find(d => String(d.id) === source.display_id);
      if (!display) return `屏幕 ${label(source.display_id || source.id)}：${label(source.name)}`;
      const { x, y, width, height } = display.bounds;
      return `屏幕 ${display.id}：${label(display.label || source.name)}（${width}×${height} DIP，缩放 ${Math.round(display.scaleFactor * 100)}%，位置 ${x}, ${y}）`;
    });
    const buttons = ["取消", ...entries.map((_, index) => `选择 ${index + 1}`)];
    const previous = page > 0 ? buttons.push("上一页") - 1 : -1;
    const next = page + 1 < pages ? buttons.push("下一页") - 1 : -1;
    const result = await options.ask({
      title: options.fullScreenOnly ? "选择允许远程操作的整个屏幕" : "选择要共享的屏幕或窗口",
      message: options.fullScreenOnly ? "请选择一个完整屏幕。共享成功后，还需要在本机确认是否授权远程操作。" : "仅共享你选择的内容。停止共享请使用会议页面中的按钮。",
      detail: `第 ${page + 1} / ${pages} 页，共 ${sources.length} 项\n\n${labels.map((name, index) => `${index + 1}. ${name}`).join("\n\n")}`,
      buttons, cancelId: 0, defaultId: 0, noLink: true,
    });
    if (!options.isCurrent() || !Number.isInteger(result.response) || result.response <= 0 || result.response >= buttons.length) return;
    if (result.response === previous) { page--; continue; }
    if (result.response === next) { page++; continue; }
    return entries[result.response - 1];
  }
}
