import { describe, expect, it } from "vitest";
import { mergeAvailableVendors } from "./availableVendors";

const vendor = (id: string, supportedResources: { title: string }[] = []) => ({
  id,
  description: { displayName: id },
  supportedResources,
});

describe("mergeAvailableVendors", () => {
  it("lists each vendor once when the lists are disjoint", () => {
    const merged = mergeAvailableVendors([vendor("context")], [vendor("memory")]);
    expect(merged.map(v => v.id)).toEqual(["context", "memory"]);
  });

  it("keeps a single entry for an ambient vendor returned by both lists", () => {
    // memory is ambient (addable) but also advertises resources, so listGatekeeperVendors returns it
    // too — the union must not render two cards for it.
    const merged = mergeAvailableVendors(
      [vendor("memory", [{ title: "Memory bank" }]), vendor("context")],
      [vendor("memory")],
    );
    expect(merged.map(v => v.id)).toEqual(["memory", "context"]);
    // The entry with resources wins, so the connect modal still offers them.
    expect(merged[0].supportedResources).toEqual([{ title: "Memory bank" }]);
  });

  it("dedupes within a single list", () => {
    const merged = mergeAvailableVendors([vendor("memory"), vendor("memory")]);
    expect(merged.map(v => v.id)).toEqual(["memory"]);
  });
});
