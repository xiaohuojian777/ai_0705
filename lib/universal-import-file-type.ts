import type { SupportedImportFileType } from "@/lib/universal-import-engine";

export function detectImportFileTypeFromName(fileName: string): SupportedImportFileType | null {
  const normalizedName = fileName.trim().toLowerCase();

  if (normalizedName.endsWith(".xlsx") || normalizedName.endsWith(".xls")) {
    return "excel";
  }

  if (normalizedName.endsWith(".doc") || normalizedName.endsWith(".docx")) {
    return "word";
  }

  if (normalizedName.endsWith(".pdf")) {
    return "pdf";
  }

  return null;
}

export function resolveImportFileType(fileName: string, fallback: SupportedImportFileType): SupportedImportFileType {
  return detectImportFileTypeFromName(fileName) ?? fallback;
}
