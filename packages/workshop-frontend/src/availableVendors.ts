// The Gatekeepers "Available" section is the union of two independent RPCs: listGatekeeperVendors
// (connectable vendors) and listAddableGatekeepers (opt-in ambient ones). The two sets are not
// disjoint — an ambient gatekeeper that also advertises resources is returned by both — so the union
// must be deduped by vendor id or the same gatekeeper renders twice.
export function mergeAvailableVendors<T extends { id: string }>(
  ...lists: readonly (readonly T[])[]
): T[] {
  const byId = new Map<string, T>();
  for (const list of lists) {
    for (const vendor of list) {
      // First entry wins: listGatekeeperVendors carries the supported resources that the ambient
      // response omits.
      if (!byId.has(vendor.id)) byId.set(vendor.id, vendor);
    }
  }
  return [...byId.values()];
}
