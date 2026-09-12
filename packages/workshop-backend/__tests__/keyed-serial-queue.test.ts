import { describe, expect, it } from "vitest";
import { KeyedSerialQueue } from "../src/keyed-serial-queue.js";

describe("KeyedSerialQueue", () => {
  it("finishes an in-flight state mutation before uninstall for the same plugin", async () => {
    const queue = new KeyedSerialQueue();
    const events: string[] = [];
    let releaseMutation!: () => void;
    const mutationStarted = new Promise<void>(resolve => {
      void queue.run("example.kanban", async () => {
        events.push("mutation:start");
        resolve();
        await new Promise<void>(release => { releaseMutation = release; });
        events.push("mutation:commit");
      });
    });
    await mutationStarted;

    const uninstall = queue.run("example.kanban", () => {
      events.push("uninstall:tombstone");
    });
    const unrelated = queue.run("example.notes", () => {
      events.push("unrelated:commit");
    });
    await unrelated;
    expect(events).toEqual(["mutation:start", "unrelated:commit"]);

    releaseMutation();
    await uninstall;
    expect(events).toEqual([
      "mutation:start",
      "unrelated:commit",
      "mutation:commit",
      "uninstall:tombstone",
    ]);
  });

  it("continues after a failed operation", async () => {
    const queue = new KeyedSerialQueue();
    await expect(queue.run("example.kanban", () => {
      throw new Error("failed mutation");
    })).rejects.toThrow("failed mutation");
    await expect(queue.run("example.kanban", () => "recovered")).resolves.toBe("recovered");
  });
});
