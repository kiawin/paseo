export type FilePreviewRenderKind = "markdown" | "html" | "csv";

export function isRenderedMarkdownFile(filePath: string): boolean {
  const normalizedPath = filePath.trim().toLowerCase();
  return normalizedPath.endsWith(".md") || normalizedPath.endsWith(".markdown");
}

function isRenderedHtmlFile(filePath: string): boolean {
  const normalizedPath = filePath.trim().toLowerCase();
  return normalizedPath.endsWith(".html") || normalizedPath.endsWith(".htm");
}

function isRenderedCsvFile(filePath: string): boolean {
  const normalizedPath = filePath.trim().toLowerCase();
  return (
    normalizedPath.endsWith(".csv") ||
    normalizedPath.endsWith(".tsv") ||
    normalizedPath.endsWith(".tab")
  );
}

export function filePreviewRenderKind(filePath: string): FilePreviewRenderKind | null {
  if (isRenderedMarkdownFile(filePath)) return "markdown";
  if (isRenderedHtmlFile(filePath)) return "html";
  if (isRenderedCsvFile(filePath)) return "csv";
  return null;
}
