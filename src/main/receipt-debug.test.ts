import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ReceiptDebug } from "../shared/types";
import {
  MAX_RECEIPT_DEBUG_BYTES,
  readReceiptDebugFile,
  ReceiptDebugValidationError,
  validateReceiptDebug,
} from "./receipt-debug";

describe("receipt debug persistence", () => {
  let folder: string;
  let filename: string;

  beforeEach(async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-debug-test-"));
    filename = path.join(folder, "receipt.json");
  });

  afterEach(async () => {
    await fs.rm(folder, { recursive: true, force: true });
  });

  it("reads a structurally valid debug record for the expected receipt", async () => {
    const debug = receiptDebug();
    await fs.writeFile(filename, JSON.stringify(debug));

    await expect(readReceiptDebugFile(filename, debug.receiptId)).resolves.toEqual(debug);
  });

  it("rejects malformed nested data and non-canonical scan timestamps", () => {
    expect(() =>
      validateReceiptDebug({
        ...receiptDebug(),
        extraction: { ...receiptDebug().extraction, items: [{ lineTotal: 42 }] },
      })
    ).toThrow(/description must be a string or null/);

    expect(() =>
      validateReceiptDebug({
        ...receiptDebug(),
        scannedAt: "2026-08-21T12:00:00Z",
      })
    ).toThrow(/canonical ISO-8601/);

    expect(() =>
      validateReceiptDebug({
        ...receiptDebug(),
        usage: { inputTokens: -1 },
      })
    ).toThrow(/non-negative safe integer/);
  });

  it("rejects debug data belonging to a different receipt", async () => {
    await fs.writeFile(filename, JSON.stringify(receiptDebug()));

    await expect(readReceiptDebugFile(filename, "another-receipt")).rejects.toThrow(
      /do not belong to the selected receipt/
    );
  });

  it("rejects oversized files before parsing them", async () => {
    await fs.writeFile(filename, Buffer.alloc(MAX_RECEIPT_DEBUG_BYTES + 1, 0x20));

    await expect(readReceiptDebugFile(filename)).rejects.toBeInstanceOf(
      ReceiptDebugValidationError
    );
    await expect(readReceiptDebugFile(filename)).rejects.toThrow(/2 MiB limit/);
  });

  it("returns null for missing details and refuses symbolic links", async () => {
    await expect(readReceiptDebugFile(filename)).resolves.toBeNull();

    const outside = path.join(folder, "outside.json");
    await fs.writeFile(outside, JSON.stringify(receiptDebug()));
    await fs.symlink(outside, filename);
    await expect(readReceiptDebugFile(filename)).rejects.toThrow(/ordinary file/);
  });
});

function receiptDebug(): ReceiptDebug {
  return {
    receiptId: "receipt-1",
    provider: "openai",
    model: "test-model",
    scannedAt: "2026-08-21T12:00:00.000Z",
    extraction: {
      merchant: "Market",
      date: "2026-08-20",
      currency: "USD",
      subtotal: "9.00",
      tax: "1.00",
      tip: null,
      adjustments: [],
      total: "10.00",
      items: [
        {
          description: "Groceries",
          quantity: "1",
          unitPrice: "9.00",
          lineTotal: "9.00",
        },
      ],
    },
    validationWarnings: ["Verify the total."],
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  };
}
