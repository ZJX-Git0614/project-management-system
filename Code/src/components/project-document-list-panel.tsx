"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  CloudUpload,
  Download,
  FileText,
  Files,
  Folder,
  FolderOpen,
  FolderTree,
  HardDriveUpload,
  LoaderCircle,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { ProjectStatus } from "@/domain/enums";
import type { ProjectDocumentFile } from "@/domain/models";
import { api } from "@/lib/api-client";
import { PROJECT_DOCUMENT_DIRECTORIES } from "@/lib/project-document-directories";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/confirm-provider";
import { usePermission } from "@/lib/use-permission";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";

interface ProjectDocumentListPanelProps {
  projectId: string;
  projectStatus: ProjectStatus;
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatUploadTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function ProjectDocumentListPanel({ projectId, projectStatus }: ProjectDocumentListPanelProps) {
  const confirm = useConfirm();
  const { can } = usePermission();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [documents, setDocuments] = useState<ProjectDocumentFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [expandedStages, setExpandedStages] = useState(
    () => new Set(PROJECT_DOCUMENT_DIRECTORIES.map((directory) => directory.name)),
  );
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const [uploadOpen, setUploadOpen] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [storageProvider, setStorageProvider] = useState<"LOCAL" | "CLOUD" | "BOTH">("LOCAL");
  const [cloudDirectory, setCloudDirectory] = useState("Ceastar-PMS/documents");
  const [uploading, setUploading] = useState(false);
  const [uploadedCount, setUploadedCount] = useState(0);
  const [uploadError, setUploadError] = useState("");
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const isReadOnly = projectStatus === ProjectStatus.COMPLETED || projectStatus === ProjectStatus.VOIDED;
  const canUpload = can("project-documents:create");
  const canDelete = can("project-documents:delete");
  const folderCount = PROJECT_DOCUMENT_DIRECTORIES.reduce(
    (total, directory) => total + directory.children.length,
    0,
  );

  const documentsByFolder = useMemo(() => {
    const grouped = new Map<string, ProjectDocumentFile[]>();
    for (const document of documents) {
      const current = grouped.get(document.directoryKey) ?? [];
      current.push(document);
      grouped.set(document.directoryKey, current);
    }
    return grouped;
  }, [documents]);

  const fetchDocuments = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError("");
      const data = await api.get<ProjectDocumentFile[]>(`/api/projects/${projectId}/documents`);
      setDocuments(data);
      setExpandedFolders((current) => {
        const next = new Set(current);
        data.forEach((document) => next.add(document.directoryKey));
        return next;
      });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "加载文档失败");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void fetchDocuments();
  }, [fetchDocuments]);

  const toggleStage = (name: string) => {
    setExpandedStages((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleFolder = (name: string) => {
    if (!(documentsByFolder.get(name)?.length)) return;
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const resetUpload = () => {
    setSelectedFolder("");
    setSelectedFiles([]);
    setStorageProvider("LOCAL");
    setCloudDirectory("Ceastar-PMS/documents");
    setUploadError("");
    setUploadedCount(0);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleUploadOpenChange = (open: boolean) => {
    if (uploading) return;
    setUploadOpen(open);
    if (!open) resetUpload();
  };

  const openUpload = (provider: "LOCAL" | "CLOUD" | "BOTH") => {
    resetUpload();
    setStorageProvider(provider);
    setUploadOpen(true);
  };

  const handleFileSelection = (fileList: FileList | null) => {
    if (!fileList) return;
    const incomingFiles = Array.from(fileList);
    setSelectedFiles((current) => {
      const knownFiles = new Set(
        current.map((file) => `${file.name}:${file.size}:${file.lastModified}`),
      );
      return [
        ...current,
        ...incomingFiles.filter(
          (file) => !knownFiles.has(`${file.name}:${file.size}:${file.lastModified}`),
        ),
      ];
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
    setUploadError("");
  };

  const handleUpload = async () => {
    if (!selectedFolder) {
      setUploadError("请选择文件需要关联的文件夹");
      return;
    }
    if (!selectedFiles.length) {
      setUploadError("请选择要上传的文件");
      return;
    }
    if (storageProvider !== "LOCAL" && !cloudDirectory.trim()) {
      setUploadError("请填写公司云盘文档目录");
      return;
    }

    setUploading(true);
    setUploadedCount(0);
    setUploadError("");
    let completedCount = 0;

    try {
      for (const file of selectedFiles) {
        const formData = new FormData();
        formData.append("directoryKey", selectedFolder);
        formData.append("storageProvider", storageProvider);
        formData.append("cloudDirectory", cloudDirectory.trim());
        formData.append("file", file);
        await api.upload<ProjectDocumentFile>(`/api/projects/${projectId}/documents`, formData);
        completedCount += 1;
        setUploadedCount(completedCount);
      }
      setExpandedFolders((current) => new Set(current).add(selectedFolder));
      await fetchDocuments();
      setUploadOpen(false);
      resetUpload();
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "上传失败");
      setSelectedFiles(selectedFiles.slice(completedCount));
      await fetchDocuments();
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = async (document: ProjectDocumentFile) => {
    try {
      setDownloadingId(document.id);
      const blob = await api.download(
        `/api/projects/${projectId}/documents/${document.id}/download`,
      );
      const objectUrl = URL.createObjectURL(blob);
      const anchor = window.document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = document.originalName;
      anchor.click();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      alert(error instanceof Error ? error.message : "下载失败");
    } finally {
      setDownloadingId(null);
    }
  };

  const handleDelete = async (document: ProjectDocumentFile) => {
    const accepted = await confirm(`确认删除文件「${document.originalName}」？删除后无法恢复。`);
    if (!accepted) return;

    try {
      setDeletingId(document.id);
      await api.delete(`/api/projects/${projectId}/documents/${document.id}`);
      setDocuments((current) => current.filter((item) => item.id !== document.id));
    } catch (error) {
      alert(error instanceof Error ? error.message : "删除失败");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50 text-muted-foreground">
              <FolderTree className="size-4" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-sm">文档清单管理</CardTitle>
              <CardDescription className="text-xs">
                {PROJECT_DOCUMENT_DIRECTORIES.length} 个阶段、{folderCount} 个文件夹、{documents.length} 个已上传文件
              </CardDescription>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 px-3"
              disabled={isReadOnly || !canUpload}
              onClick={() => openUpload("LOCAL")}
              title={isReadOnly ? "已完成或已作废项目不能上传文件" : canUpload ? "上传到服务器本地" : "无上传权限"}
            >
              <HardDriveUpload />
              上传到本地
            </Button>
            <Button
              size="sm"
              className="h-8 !border-primary/45 !bg-primary/10 !px-3 !text-primary hover:!bg-primary/20"
              disabled={isReadOnly || !canUpload}
              onClick={() => openUpload("CLOUD")}
              title={isReadOnly ? "已完成或已作废项目不能上传文件" : canUpload ? "上传到公司云盘" : "无上传权限"}
            >
              <CloudUpload />
              上传到公司云盘
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loadError && (
          <div className="mb-3 flex items-center justify-between rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <span>{loadError}</span>
            <Button variant="ghost" size="sm" onClick={() => void fetchDocuments()}>
              重试
            </Button>
          </div>
        )}

        <div className="overflow-hidden rounded-md border border-border">
          <div className="grid grid-cols-[minmax(320px,1fr)_110px_160px_44px] border-b border-border bg-muted/70 px-3 py-2 text-xs font-medium text-muted-foreground">
            <div>目录 / 文件名称</div>
            <div className="text-right">数量 / 大小</div>
            <div className="text-right">上传信息</div>
            <div />
          </div>

          {loading ? (
            <div className="flex h-28 items-center justify-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              加载文档...
            </div>
          ) : (
            <div className="divide-y divide-border">
              {PROJECT_DOCUMENT_DIRECTORIES.map((directory) => {
                const isStageExpanded = expandedStages.has(directory.name);
                const stageFileCount = directory.children.reduce(
                  (total, folder) => total + (documentsByFolder.get(folder)?.length ?? 0),
                  0,
                );

                return (
                  <div key={directory.name} className="bg-background">
                    <button
                      type="button"
                      onClick={() => toggleStage(directory.name)}
                      className="grid !w-full grid-cols-[minmax(320px,1fr)_110px_160px_44px] items-center px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50"
                      aria-expanded={isStageExpanded}
                    >
                      <span className="flex min-w-0 items-center gap-2 font-medium">
                        <ChevronRight
                          className={cn(
                            "size-4 shrink-0 text-muted-foreground transition-transform",
                            isStageExpanded && "rotate-90",
                          )}
                        />
                        {isStageExpanded ? (
                          <FolderOpen className="size-4 shrink-0 text-amber-600" />
                        ) : (
                          <Folder className="size-4 shrink-0 text-amber-600" />
                        )}
                        <span className="truncate">{directory.name}</span>
                      </span>
                      <span className="text-right text-xs text-muted-foreground">
                        {directory.children.length} 个文件夹
                      </span>
                      <span className="text-right text-xs text-muted-foreground">
                        {stageFileCount} 个文件
                      </span>
                      <span />
                    </button>

                    {isStageExpanded && (
                      <div className="border-t border-border/70 bg-muted/15">
                        {directory.children.map((folder) => {
                          const folderDocuments = documentsByFolder.get(folder) ?? [];
                          const isFolderExpanded = expandedFolders.has(folder);

                          return (
                            <div key={folder} className="border-b border-border/60 last:border-b-0">
                              <button
                                type="button"
                                onClick={() => toggleFolder(folder)}
                                className={cn(
                                  "grid !w-full grid-cols-[minmax(320px,1fr)_110px_160px_44px] items-center px-3 py-2 text-left text-sm transition-colors hover:bg-muted/45",
                                  folderDocuments.length === 0 && "cursor-default",
                                )}
                                aria-expanded={folderDocuments.length ? isFolderExpanded : undefined}
                              >
                                <span className="flex min-w-0 items-center gap-2 pl-7">
                                  {folderDocuments.length ? (
                                    <ChevronRight
                                      className={cn(
                                        "size-3.5 shrink-0 text-muted-foreground transition-transform",
                                        isFolderExpanded && "rotate-90",
                                      )}
                                    />
                                  ) : (
                                    <span className="size-3.5 shrink-0" />
                                  )}
                                  {isFolderExpanded ? (
                                    <FolderOpen className="size-4 shrink-0 text-amber-500" />
                                  ) : (
                                    <Folder className="size-4 shrink-0 text-amber-500" />
                                  )}
                                  <span className="truncate">{folder}</span>
                                </span>
                                <span className="text-right text-xs text-muted-foreground">
                                  {folderDocuments.length} 个文件
                                </span>
                                <span />
                                <span />
                              </button>

                              {isFolderExpanded && folderDocuments.length > 0 && (
                                <div className="divide-y divide-border/40 border-t border-border/50">
                                  {folderDocuments.map((document, fileIndex) => (
                                    <div
                                      key={document.id}
                                      className={cn(
                                        "grid h-[34px] grid-cols-[minmax(320px,1fr)_110px_160px_44px] items-center px-3 text-sm transition-colors hover:bg-primary/5",
                                        fileIndex % 2 === 0 ? "bg-background/70" : "bg-muted/25",
                                      )}
                                    >
                                      <button
                                        type="button"
                                        onClick={() => void handleDownload(document)}
                                        className="flex min-w-0 items-center gap-2 !border-0 !bg-transparent !py-0 !pl-[5.75rem] !pr-0 text-left !shadow-none hover:!bg-transparent hover:text-primary focus-visible:!shadow-none"
                                        title={`下载 ${document.originalName}`}
                                      >
                                        <span className="h-px w-5 shrink-0 bg-border" aria-hidden="true" />
                                        <FileText className="size-4 shrink-0 text-muted-foreground" />
                                        <span className="truncate">{document.originalName}</span>
                                      </button>
                                      <span className="text-right text-xs text-muted-foreground">
                                        {formatFileSize(document.sizeBytes)}
                                      </span>
                                      <span
                                        className="truncate text-right text-[11px] text-muted-foreground"
                                        title={`${document.uploadedBy} · ${formatUploadTime(document.createdAt)} · ${document.storageProvider === "CLOUD" ? "公司云盘" : document.storageProvider === "BOTH" ? "本地与云盘" : "服务器本地"}`}
                                      >
                                        {document.uploadedBy} · {document.storageProvider === "CLOUD" ? "云盘" : document.storageProvider === "BOTH" ? "双存储" : "本地"}
                                      </span>
                                      <span className="flex justify-end">
                                        {isReadOnly || !canDelete ? (
                                          <Button
                                            variant="ghost"
                                            size="icon"
                                            className="size-7 !min-h-7 !border-0 !bg-transparent !p-0 !shadow-none hover:!bg-muted"
                                            onClick={() => void handleDownload(document)}
                                            disabled={downloadingId === document.id}
                                            title="下载文件"
                                          >
                                            {downloadingId === document.id ? (
                                              <LoaderCircle className="animate-spin" />
                                            ) : (
                                              <Download />
                                            )}
                                          </Button>
                                        ) : (
                                          <Button
                                            variant="ghost"
                                            size="icon"
                                            className="size-7 !min-h-7 !border-0 !bg-transparent !p-0 text-muted-foreground !shadow-none hover:!bg-destructive/10 hover:text-destructive"
                                            onClick={() => void handleDelete(document)}
                                            disabled={deletingId === document.id}
                                            title="删除文件"
                                          >
                                            {deletingId === document.id ? (
                                              <LoaderCircle className="animate-spin" />
                                            ) : (
                                              <Trash2 />
                                            )}
                                          </Button>
                                        )}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </CardContent>

      <Dialog open={uploadOpen} onOpenChange={handleUploadOpenChange}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-base">上传项目文档</DialogTitle>
            <DialogDescription>
              选择文件需要关联的目录。支持一次上传多个文件，单个文件不超过 20 MB。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">关联文件夹</label>
              <Select
                className="!w-full"
                value={selectedFolder}
                onChange={(event) => {
                  setSelectedFolder(event.target.value);
                  setUploadError("");
                }}
                disabled={uploading}
              >
                <option value="">请选择文件夹</option>
                {PROJECT_DOCUMENT_DIRECTORIES.flatMap((directory) =>
                  directory.children.map((folder) => (
                    <option key={folder} value={folder}>
                      {`${directory.name} / ${folder}`}
                    </option>
                  )),
                )}
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">存储位置</label>
              <div className="grid grid-cols-3 overflow-hidden rounded-md border border-border bg-muted/20 p-0.5">
                {([
                  { value: "LOCAL", label: "服务器本地", icon: HardDriveUpload },
                  { value: "CLOUD", label: "公司云盘", icon: CloudUpload },
                  { value: "BOTH", label: "本地与云盘", icon: Files },
                ] as const).map((option) => {
                  const Icon = option.icon;
                  const selected = storageProvider === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={selected}
                      disabled={uploading}
                      onClick={() => {
                        setStorageProvider(option.value);
                        setUploadError("");
                      }}
                      className={cn(
                        "flex h-9 min-w-0 items-center justify-center gap-1.5 rounded px-2 text-xs transition-colors",
                        selected
                          ? "bg-primary text-primary-foreground shadow-sm"
                          : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                      )}
                    >
                      <Icon className="size-3.5 shrink-0" />
                      <span className="truncate">{option.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {storageProvider !== "LOCAL" && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">公司云盘目录</label>
                <input
                  value={cloudDirectory}
                  onChange={(event) => {
                    setCloudDirectory(event.target.value);
                    setUploadError("");
                  }}
                  className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none transition-colors focus:border-primary"
                  placeholder="Ceastar-PMS/documents"
                  disabled={uploading}
                />
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">选择文件（支持多选）</label>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="sr-only"
                onChange={(event) => handleFileSelection(event.target.files)}
                disabled={uploading}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="flex min-h-14 !w-full items-center gap-3 rounded-md border border-dashed border-border bg-muted/15 !px-3 !py-2 text-left text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
                  <Upload className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-foreground">
                    {selectedFiles.length ? "继续添加文件" : "选择文件"}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    可同时选择多个文件，单个文件不超过 20 MB
                  </span>
                </span>
                {selectedFiles.length > 0 && (
                  <span className="shrink-0 rounded bg-primary/10 px-2 py-1 text-xs text-primary">
                    已选 {selectedFiles.length} 个
                  </span>
                )}
              </button>
            </div>

            {selectedFiles.length > 0 && (
              <div className="overflow-hidden rounded-md border border-border">
                <div className="flex items-center justify-between border-b border-border bg-muted/35 px-3 py-1.5 text-xs">
                  <span className="font-medium">待上传文件（{selectedFiles.length}）</span>
                  <button
                    type="button"
                    className="!min-h-0 !border-0 !bg-transparent !p-0 text-[11px] text-muted-foreground !shadow-none hover:!bg-transparent hover:text-destructive"
                    onClick={() => setSelectedFiles([])}
                    disabled={uploading}
                  >
                    清空
                  </button>
                </div>
                <div className="max-h-36 divide-y divide-border/50 overflow-y-auto p-1">
                  {selectedFiles.map((file, index) => (
                    <div key={`${file.name}-${file.size}-${index}`} className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted/50">
                      <FileText className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{file.name}</span>
                      <span className="shrink-0 text-muted-foreground">{formatFileSize(file.size)}</span>
                      <button
                        type="button"
                        className="flex size-5 !min-h-0 items-center justify-center !border-0 !bg-transparent !p-0 text-muted-foreground !shadow-none hover:!bg-transparent hover:text-destructive"
                        onClick={() => setSelectedFiles((files) => files.filter((_, fileIndex) => fileIndex !== index))}
                        disabled={uploading}
                        title="移除文件"
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {uploadError && <div className="text-xs text-destructive">{uploadError}</div>}
          </div>

          <DialogFooter className="border-t border-border pt-4">
            <Button size="sm" variant="outline" onClick={() => handleUploadOpenChange(false)} disabled={uploading}>
              取消
            </Button>
            <Button
              size="sm"
              className={cn(
                "min-w-24 !px-3",
                selectedFolder && selectedFiles.length
                  ? "!border-primary !bg-primary !text-primary-foreground hover:!bg-primary/90"
                  : "!border-border !bg-muted/40 !text-muted-foreground",
              )}
              onClick={() => void handleUpload()}
              disabled={
                uploading
                || !selectedFolder
                || !selectedFiles.length
                || (storageProvider !== "LOCAL" && !cloudDirectory.trim())
              }
            >
              {uploading ? (
                <>
                  <LoaderCircle className="animate-spin" />
                  上传中 {uploadedCount}/{selectedFiles.length}
                </>
              ) : (
                <>
                  <Upload />
                  {selectedFiles.length ? `上传 ${selectedFiles.length} 个文件` : "上传文件"}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
