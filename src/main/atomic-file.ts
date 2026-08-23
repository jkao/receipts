import { randomUUID } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";

export interface AtomicWriteFileOptions {
  mode: number;
  retainBackup?: boolean;
}

export interface AtomicWriteFileResult {
  /** Whether the containing directory acknowledged the rename durability barrier. */
  directorySynced: boolean;
}

export function isErrno(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    !Array.isArray(error) &&
    "code" in error &&
    error.code === code
  );
}

export async function fileExists(filename: string): Promise<boolean> {
  try {
    await fs.access(filename, fsConstants.F_OK);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

export async function syncDirectory(directory: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
    return true;
  } catch (error) {
    // Directory fsync is not available on every platform/filesystem. The files
    // themselves have already been synced, so only ignore those platform cases.
    if (
      !isErrno(error, "EINVAL") &&
      !isErrno(error, "ENOTSUP") &&
      !isErrno(error, "EISDIR") &&
      !isErrno(error, "EBADF")
    ) {
      throw error;
    }
    return false;
  } finally {
    await handle?.close();
  }
}

export async function atomicWriteFile(
  filename: string,
  contents: string | Buffer,
  options: AtomicWriteFileOptions
): Promise<AtomicWriteFileResult> {
  const directory = path.dirname(filename);
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(directory, { recursive: true });

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let renamed = false;
  try {
    handle = await fs.open(temporary, "wx", options.mode);
    await handle.chmod(options.mode);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;

    if (options.retainBackup && (await fileExists(filename))) {
      const previous = await fs.readFile(filename);
      await atomicWriteFile(`${filename}.bak`, previous, { mode: options.mode });
    }

    await fs.rename(temporary, filename);
    renamed = true;
    // The rename is the caller-visible commit point. Report an uncertain
    // directory barrier separately: callers with multi-file protocols can stop
    // advancing without misreporting this already-visible write as rolled back.
    try {
      return { directorySynced: await syncDirectory(directory) };
    } catch {
      return { directorySynced: false };
    }
  } finally {
    await handle?.close();
    if (!renamed) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
