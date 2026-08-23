import { describe, expect, it } from "vitest";
import { KeyedSerialQueue } from "./serial-queue";

describe("KeyedSerialQueue", () => {
  it("serializes one key in call order and remains usable after a rejection", async () => {
    const queue = new KeyedSerialQueue<string>();
    const events: string[] = [];
    let releaseFirst: () => void = () => undefined;
    let markFirstStarted: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });

    const first = queue.run("invoice", async () => {
      events.push("first:start");
      markFirstStarted();
      await firstGate;
      events.push("first:end");
      throw new Error("expected failure");
    });
    const second = queue.run("invoice", async () => {
      events.push("second");
      return 2;
    });
    await firstStarted;
    expect(events).toEqual(["first:start"]);

    releaseFirst();
    await expect(first).rejects.toThrow("expected failure");
    await expect(second).resolves.toBe(2);
    await expect(queue.run("invoice", async () => 3)).resolves.toBe(3);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  it("allows different keys to run independently", async () => {
    const queue = new KeyedSerialQueue<string>();
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted = false;

    const first = queue.run("first", () => firstGate);
    const second = queue.run("second", async () => {
      secondStarted = true;
    });
    await second;
    expect(secondStarted).toBe(true);

    releaseFirst();
    await first;
  });
});
