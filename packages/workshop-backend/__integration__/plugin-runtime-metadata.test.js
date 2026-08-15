export default {
  async handshake() {},

  async invoke(context) {
    const metadata = await context.capabilities.workspaceMetadata?.read();
    if (
      metadata?.title !== "Capability Workspace" ||
      metadata?.role !== "build"
    ) {
      throw new Error("workspace metadata capability returned the wrong snapshot");
    }
  },
};
