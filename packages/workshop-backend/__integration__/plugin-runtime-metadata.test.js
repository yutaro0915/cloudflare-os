export default {
  async handshake() {},

  async invoke(context) {
    const metadata = await context.capabilities.workspaceMetadata?.read();
    const state = await context.capabilities.state?.read("missing");
    if (
      metadata?.title !== "Capability Workspace" ||
      metadata?.role !== "build"
    ) {
      throw new Error("workspace metadata capability returned the wrong snapshot");
    }
    if (state !== null) throw new Error("missing plugin state must read as null");
  },
};
