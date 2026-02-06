import path from "node:path";

export function canAccessJobAttachment(args: {
  requesterRole: "CONSUMER" | "PROVIDER" | "ADMIN" | string;
  requesterUserId: number;
  jobConsumerId: number;
  requesterHasBidOnJob: boolean;
}): boolean {
  const { requesterRole, requesterUserId, jobConsumerId, requesterHasBidOnJob } = args;

  if (requesterRole === "ADMIN") return true;
  if (requesterUserId === jobConsumerId) return true;
  if (requesterRole === "PROVIDER" && requesterHasBidOnJob) return true;
  return false;
}

export function resolveDiskPathInsideUploadsDir(uploadsDir: string, diskPath: string): string {
  if (!diskPath || typeof diskPath !== "string") {
    throw new Error("Invalid diskPath");
  }

  // Do not allow absolute paths in DB
  if (path.isAbsolute(diskPath)) {
    throw new Error("Invalid diskPath");
  }

  const uploadsAbs = path.resolve(uploadsDir);
  const candidate = path.resolve(uploadsAbs, diskPath);
  const rel = path.relative(uploadsAbs, candidate);

  // If candidate escapes uploadsDir, relative will start with ..
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Invalid diskPath");
  }

  return candidate;
}

export function shouldInlineContentType(mimeType: string | null | undefined): boolean {
  const mt = String(mimeType || "").toLowerCase();
  if (mt.startsWith("image/")) return true;
  if (mt === "application/pdf") return true;
  return false;
}

export function sanitizeFilenameForHeader(name: string | null | undefined): string {
  const raw = (name ?? "attachment").toString().trim() || "attachment";
  // Remove CR/LF and quotes to avoid header injection / broken headers
  return raw.replace(/[\r\n"]/g, "_");
}
