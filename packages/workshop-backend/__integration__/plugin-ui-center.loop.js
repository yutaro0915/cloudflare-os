export default {
  render() {
    // The host wall-clock deadline must release the caller even when code never settles.
    return new Promise(() => {});
  },
};
