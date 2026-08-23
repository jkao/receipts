import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { atomicWriteFile, fileExists, isErrno, syncDirectory } from "./atomic-file";

describe("atomic file utilities", () => {
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-atomic-file-"));
  });

  afterEach(async () => {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("atomically replaces a file with the requested mode and retains its prior contents", async () => {
    const filename = path.join(temporaryDirectory, "nested", "invoice.json");
    const initialWrite = await atomicWriteFile(filename, "old contents", { mode: 0o600 });
    const replacement = await atomicWriteFile(filename, "new contents", {
      mode: 0o600,
      retainBackup: true,
    });

    expect(initialWrite.directorySynced).toBe(true);
    expect(replacement.directorySynced).toBe(true);
    await expect(fs.readFile(filename, "utf8")).resolves.toBe("new contents");
    await expect(fs.readFile(`${filename}.bak`, "utf8")).resolves.toBe("old contents");
    expect((await fs.stat(filename)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(`${filename}.bak`)).mode & 0o777).toBe(0o600);
  });

  it("removes its unpredictable temporary file when replacement fails", async () => {
    const filename = path.join(temporaryDirectory, "occupied");
    await fs.mkdir(filename);

    await expect(atomicWriteFile(filename, "contents", { mode: 0o600 })).rejects.toThrow();
    await expect(fs.readdir(temporaryDirectory)).resolves.toEqual(["occupied"]);
  });

  it("distinguishes missing files from other access failures", async () => {
    await expect(fileExists(path.join(temporaryDirectory, "missing"))).resolves.toBe(false);
    await expect(fileExists(temporaryDirectory)).resolves.toBe(true);
    expect(isErrno(Object.assign(new Error("missing"), { code: "ENOENT" }), "ENOENT")).toBe(true);
    expect(isErrno(new Error("missing"), "ENOENT")).toBe(false);
  });

  it("reports when the filesystem cannot provide a directory durability barrier", async () => {
    const open = vi
      .spyOn(fs, "open")
      .mockRejectedValueOnce(Object.assign(new Error("unsupported"), { code: "ENOTSUP" }));

    try {
      await expect(syncDirectory(temporaryDirectory)).resolves.toBe(false);
    } finally {
      open.mockRestore();
    }
  });
});
