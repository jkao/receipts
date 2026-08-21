import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
  decryptString: vi.fn((value: Buffer) => value.toString("utf8").replace(/^encrypted:/, "")),
}));

vi.mock("electron", () => ({ safeStorage: safeStorageMock }));

import { SettingsStore } from "./settings";

describe("SettingsStore", () => {
  let userDataDirectory: string;

  beforeEach(async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    safeStorageMock.encryptString.mockClear();
    safeStorageMock.decryptString.mockClear();
    userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-settings-test-"));
  });

  afterEach(async () => {
    await fs.rm(userDataDirectory, { recursive: true, force: true });
  });

  it("encrypts the API key and writes settings with owner-only permissions", async () => {
    const store = new SettingsStore(userDataDirectory);
    await store.saveOpenAiKey("  fake-unit-test-key  ");

    expect(safeStorageMock.encryptString).toHaveBeenCalledWith("fake-unit-test-key");
    await expect(store.getOpenAiKey()).resolves.toBe("fake-unit-test-key");

    const settingsPath = path.join(userDataDirectory, "settings.json");
    const contents = await fs.readFile(settingsPath, "utf8");
    expect(contents).not.toContain("fake-unit-test-key");
    expect((await fs.stat(settingsPath)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(userDataDirectory)).sort()).toEqual(["settings.json"]);
  });

  it("rejects an empty base-folder value instead of resolving it to cwd", async () => {
    const store = new SettingsStore(userDataDirectory);
    await expect(store.setBaseFolder("   ")).rejects.toThrow("Choose a base folder.");
    await expect(store.getView()).resolves.toMatchObject({ baseFolder: null });
  });

  it("rejects a symbolic link as the configured base-folder root", async () => {
    const store = new SettingsStore(userDataDirectory);
    const target = path.join(userDataDirectory, "target");
    const link = path.join(userDataDirectory, "linked-base");
    await fs.mkdir(target);
    await fs.symlink(target, link, "dir");

    await expect(store.setBaseFolder(link)).rejects.toThrow(/symbolic link/);
    await expect(store.getView()).resolves.toMatchObject({ baseFolder: null });
  });

  it("does not save a key when secure storage is unavailable", async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    const store = new SettingsStore(userDataDirectory);

    await expect(store.saveOpenAiKey("fake-unit-test-key")).rejects.toThrow(
      /secure storage is unavailable/
    );
    await expect(store.getView()).resolves.toMatchObject({
      hasOpenAiKey: false,
    });
  });
});
