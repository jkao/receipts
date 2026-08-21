import { safeStorage } from "electron";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppSettings, SettingsView } from "../shared/types";

const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 1,
  baseFolder: null,
  defaultRateMinor: 4500,
};

export class SettingsStore {
  private readonly settingsPath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(userDataDirectory: string) {
    this.settingsPath = path.join(userDataDirectory, "settings.json");
  }

  async getView(): Promise<SettingsView> {
    const settings = await this.read();
    return {
      baseFolder: settings.baseFolder,
      hasOpenAiKey: Boolean(settings.openaiApiKeyEncrypted),
      defaultRateMinor: settings.defaultRateMinor,
    };
  }

  async setBaseFolder(baseFolder: string): Promise<SettingsView> {
    const trimmed = baseFolder.trim();
    if (!trimmed) {
      throw new Error("Choose a base folder.");
    }
    const resolved = path.resolve(trimmed);
    await fs.mkdir(resolved, { recursive: true });
    const metadata = await fs.lstat(resolved);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Choose an ordinary folder, not a symbolic link.");
    }
    await this.update((settings) => ({ ...settings, baseFolder: resolved }));
    return this.getView();
  }

  async setDefaultRate(defaultRateMinor: number): Promise<SettingsView> {
    if (!Number.isSafeInteger(defaultRateMinor) || defaultRateMinor < 0) {
      throw new Error("Default rate must be a non-negative amount in cents.");
    }
    await this.update((settings) => ({ ...settings, defaultRateMinor }));
    return this.getView();
  }

  async saveOpenAiKey(apiKey: string): Promise<SettingsView> {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error("Enter an API key.");
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("macOS secure storage is unavailable; the key was not saved.");
    }
    const encrypted = safeStorage.encryptString(trimmed).toString("base64");
    await this.update((settings) => ({
      ...settings,
      openaiApiKeyEncrypted: encrypted,
    }));
    return this.getView();
  }

  async deleteOpenAiKey(): Promise<SettingsView> {
    await this.update((settings) => {
      const next = { ...settings };
      delete next.openaiApiKeyEncrypted;
      return next;
    });
    return this.getView();
  }

  async getOpenAiKey(): Promise<string | null> {
    const settings = await this.read();
    if (!settings.openaiApiKeyEncrypted) {
      return null;
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("macOS secure storage is unavailable.");
    }
    try {
      return safeStorage.decryptString(Buffer.from(settings.openaiApiKeyEncrypted, "base64"));
    } catch {
      throw new Error("The saved API key could not be decrypted. Enter it again.");
    }
  }

  async getBaseFolder(): Promise<string> {
    const settings = await this.read();
    if (!settings.baseFolder) {
      throw new Error("Choose a base folder in Settings first.");
    }
    return settings.baseFolder;
  }

  async read(): Promise<AppSettings> {
    try {
      const contents = await fs.readFile(this.settingsPath, "utf8");
      const parsed = JSON.parse(contents) as Partial<AppSettings>;
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        schemaVersion: 1,
        baseFolder: typeof parsed.baseFolder === "string" ? parsed.baseFolder : null,
        defaultRateMinor:
          Number.isSafeInteger(parsed.defaultRateMinor) && Number(parsed.defaultRateMinor) >= 0
            ? Number(parsed.defaultRateMinor)
            : DEFAULT_SETTINGS.defaultRateMinor,
        openaiApiKeyEncrypted:
          typeof parsed.openaiApiKeyEncrypted === "string"
            ? parsed.openaiApiKeyEncrypted
            : undefined,
      };
    } catch (error) {
      if (isMissingFile(error)) {
        return { ...DEFAULT_SETTINGS };
      }
      throw new Error("Could not read app settings.", { cause: error });
    }
  }

  private async update(updater: (settings: AppSettings) => AppSettings): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const current = await this.read();
      await this.write(updater(current));
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  private async write(settings: AppSettings): Promise<void> {
    const directory = path.dirname(this.settingsPath);
    const temporaryPath = `${this.settingsPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.mkdir(directory, { recursive: true });
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(temporaryPath, this.settingsPath);
      await fs.chmod(this.settingsPath, 0o600);
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
