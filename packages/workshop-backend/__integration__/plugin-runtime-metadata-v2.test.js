export default {
  async handshake() {
    throw new Error("candidate activation failed");
  },

  async invoke() {},
};
