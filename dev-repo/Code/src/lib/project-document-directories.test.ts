import { describe, expect, it } from "vitest";
import {
  isProjectDocumentFolderName,
  PROJECT_DOCUMENT_DIRECTORIES,
  PROJECT_DOCUMENT_FOLDER_NAMES,
} from "@/lib/project-document-directories";

describe("project document directory template", () => {
  it("keeps the imported 16-stage, 82-folder hierarchy", () => {
    expect(PROJECT_DOCUMENT_DIRECTORIES).toHaveLength(16);
    expect(PROJECT_DOCUMENT_FOLDER_NAMES).toHaveLength(82);
    expect(new Set(PROJECT_DOCUMENT_FOLDER_NAMES).size).toBe(82);
  });

  it("only accepts folders from the configured hierarchy", () => {
    expect(isProjectDocumentFolderName("1.1《项目可行性研究报告》")).toBe(true);
    expect(isProjectDocumentFolderName("临时目录")).toBe(false);
  });
});
