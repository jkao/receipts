import crypto from "node:crypto";
import { createReadStream, lstatSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Base64 request encoding can require several times the source file's size in
// live memory. Receipt scans are normally far smaller, so keep a conservative
// local ceiling while the MVP sends inline provider payloads.
export const MAX_RECEIPT_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_RECEIPT_FILE_SIZE_LABEL = "20 MB";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".pdf": "application/pdf",
};

export const SUPPORTED_RECEIPT_EXTENSIONS = Object.freeze(Object.keys(MIME_BY_EXTENSION));

export function mimeTypeForPath(filePath: string): string | null {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? null;
}

export function isSupportedReceipt(filePath: string): boolean {
  return mimeTypeForPath(filePath) !== null;
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

export function managedReceiptFilename(sourcePath: string, sha256: string): string {
  const sourceExtension = path.extname(sourcePath);
  const extension = sourceExtension.toLowerCase();
  const base = path.basename(sourcePath, sourceExtension);
  const sanitized =
    base
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64)
      .toLowerCase() || "receipt";
  return `r_${sha256.slice(0, 12)}__${sanitized}${extension}`;
}

export async function readExtractionInput(sourcePath: string): Promise<{
  buffer: Buffer;
  filename: string;
  mimeType: string;
  cleanup(): Promise<void>;
}> {
  const mimeType = mimeTypeForPath(sourcePath);
  if (!mimeType) {
    throw new Error("Unsupported receipt file type.");
  }

  await assertReceiptFileSize(sourcePath);

  if (mimeType !== "image/heic" && mimeType !== "image/heif") {
    return {
      buffer: await fs.readFile(sourcePath),
      filename: path.basename(sourcePath),
      mimeType,
      cleanup: async () => undefined,
    };
  }

  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-invoice-heic-"));
  const outputPath = path.join(
    temporaryDirectory,
    `${path.basename(sourcePath, path.extname(sourcePath))}.jpg`
  );

  try {
    await execFileAsync("/usr/bin/sips", ["-s", "format", "jpeg", sourcePath, "--out", outputPath]);
    await assertReceiptFileSize(outputPath);
    return {
      buffer: await fs.readFile(outputPath),
      filename: path.basename(outputPath),
      mimeType: "image/jpeg",
      cleanup: () => fs.rm(temporaryDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    throw new Error("Could not convert the HEIC receipt to JPEG.", {
      cause: error,
    });
  }
}

export async function receiptPreviewBytes(
  sourcePath: string
): Promise<{ mimeType: string; bytes: Uint8Array }> {
  const input = await readExtractionInput(sourcePath);
  try {
    return {
      mimeType: input.mimeType,
      bytes: input.buffer,
    };
  } finally {
    await input.cleanup();
  }
}

export async function assertReceiptFileSize(filePath: string): Promise<void> {
  const metadata = await fs.stat(filePath);
  if (metadata.size === 0) {
    throw new Error("The selected file is empty.");
  }
  if (metadata.size > MAX_RECEIPT_FILE_BYTES) {
    throw new Error(
      `The selected receipt exceeds the ${MAX_RECEIPT_FILE_SIZE_LABEL} safe processing limit.`
    );
  }
}

export function resolveInside(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    rejectSymlinkComponents(resolvedRoot, relative);
    return resolved;
  }
  throw new Error("Receipt path escapes its invoice folder.");
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function rejectSymlinkComponents(root: string, relativePath: string): void {
  if (!relativePath) return;

  let current = root;
  for (const component of relativePath.split(path.sep)) {
    current = path.join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error("Receipt path contains a symbolic link.");
      }
    } catch (error) {
      if (isMissingFile(error)) {
        // Once a component is absent, no deeper component can exist yet.
        return;
      }
      throw error;
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
