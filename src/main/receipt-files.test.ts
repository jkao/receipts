import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  managedReceiptFilename,
  mimeTypeForPath,
  resolveInside,
  sha256File,
  sortableReceiptFilename,
  writeJsonAtomic,
} from "./receipt-files";

describe("receipt file helpers", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-files-test-"));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("maps supported extensions without caring about case", () => {
    expect(mimeTypeForPath("receipt.PDF")).toBe("application/pdf");
    expect(mimeTypeForPath("photo.HEIC")).toBe("image/heic");
    expect(mimeTypeForPath("notes.txt")).toBeNull();
  });

  it("creates sanitized managed filenames", () => {
    expect(managedReceiptFilename("/tmp/Whole Foods #42.JPG", "abcdef0123456789")).toBe(
      "r_abcdef012345__whole-foods-42.jpg"
    );
  });

  it("creates date-first merchant filenames with lexically sortable sequences", () => {
    expect(
      sortableReceiptFilename(
        "/tmp/camera upload.PDF",
        "2026-01-12",
        "  Whôle Foods #42 / Market  ",
        1
      )
    ).toBe("2026-01-12-whole-foods-42-market-001.pdf");
    expect(sortableReceiptFilename("receipt.HEIC", "2026-01-12", "Whole Foods", 12)).toBe(
      "2026-01-12-whole-foods-012.heic"
    );
  });

  it("does not invent sortable names without a valid date and merchant", () => {
    expect(sortableReceiptFilename("receipt.jpg", "2026-02-30", "Whole Foods", 1)).toBeNull();
    expect(sortableReceiptFilename("receipt.jpg", null, "Whole Foods", 1)).toBeNull();
    expect(sortableReceiptFilename("receipt.jpg", "2026-01-12", null, 1)).toBeNull();
    expect(sortableReceiptFilename("receipt.jpg", "2026-01-12", "東京", 1)).toBeNull();
    expect(sortableReceiptFilename("receipt.jpg", "2026-01-12", "Whole Foods", 0)).toBeNull();
  });

  it("hashes and atomically writes files", async () => {
    const input = path.join(directory, "input.jpg");
    await fs.writeFile(input, "receipt");
    expect(await sha256File(input)).toMatch(/^[a-f0-9]{64}$/);

    const jsonPath = path.join(directory, "debug", "result.json");
    await writeJsonAtomic(jsonPath, { ok: true });
    expect(JSON.parse(await fs.readFile(jsonPath, "utf8"))).toEqual({
      ok: true,
    });
    expect((await fs.stat(jsonPath)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(path.dirname(jsonPath))).sort()).toEqual(["result.json"]);
  });

  it("rejects paths outside an invoice directory", () => {
    expect(resolveInside(directory, "receipts/a.jpg")).toBe(
      path.join(directory, "receipts", "a.jpg")
    );
    expect(() => resolveInside(directory, "../outside.jpg")).toThrow(/escapes/);
  });

  it("rejects existing symbolic-link components inside an invoice", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-outside-"));
    try {
      await fs.symlink(outside, path.join(directory, "receipts"));
      expect(() => resolveInside(directory, "receipts/a.jpg")).toThrow(/symbolic link/);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
