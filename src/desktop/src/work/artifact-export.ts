export type ArtifactExportStatus = "exported" | "cancelled";

export class ArtifactExportError extends Error {
  constructor(public readonly code: "file_exists" | "export_failed") {
    super(code);
    this.name = "ArtifactExportError";
  }
}

interface SaveDialogOptions {
  defaultPath: string;
  filters: Array<{ name: string; extensions: string[] }>;
}

interface SaveDialogResult {
  canceled: boolean;
  filePath?: string;
}

export async function exportArtifactVersion(
  versionId: string,
  content: { format: "text/plain" | "text/markdown"; text: string },
  selectSavePath: (options: SaveDialogOptions) => Promise<SaveDialogResult>,
  writeFile: (filePath: string, text: string) => void,
): Promise<ArtifactExportStatus> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      versionId,
    ) ||
    (content.format !== "text/plain" && content.format !== "text/markdown") ||
    typeof content.text !== "string" ||
    content.text.includes("\x00") ||
    new TextEncoder().encode(content.text).length > 1024 * 1024
  ) {
    throw new ArtifactExportError("export_failed");
  }
  const extension = content.format === "text/markdown" ? "md" : "txt";
  const selection = await selectSavePath({
    defaultPath: `${versionId}.${extension}`,
    filters: [
      {
        name: content.format === "text/markdown" ? "Markdown" : "文本",
        extensions: [extension],
      },
    ],
  });
  if (selection.canceled || !selection.filePath) return "cancelled";
  try {
    writeFile(selection.filePath, content.text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ArtifactExportError("file_exists");
    }
    throw new ArtifactExportError("export_failed");
  }
  return "exported";
}
