import { Context } from "cordis";
import { describe, expect, it } from "vitest";

describe("pinned Cordis runtime contract", () => {
  it("activates a plugin and awaits its disposer in workerd", async () => {
    const context = new Context();
    const events: string[] = [];
    const fiber = context.plugin(() => {
      events.push("activate");
      return async () => {
        await Promise.resolve();
        events.push("dispose");
      };
    });

    await fiber;
    expect(events).toEqual(["activate"]);
    await fiber.dispose();
    expect(events).toEqual(["activate", "dispose"]);
  });

  it("resolves disposal even when a plugin disposer throws", async () => {
    const context = new Context();
    const fiber = context.plugin(() => () => {
      throw new Error("cleanup failed");
    });

    await fiber;
    await expect(fiber.dispose()).resolves.toBeUndefined();
    expect(fiber.dispose()).toBeUndefined();
  });
});
