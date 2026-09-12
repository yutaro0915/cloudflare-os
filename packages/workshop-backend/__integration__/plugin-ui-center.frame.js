export default {
  render() {
    return {
      schemaVersion: 1,
      blocks: [
        {kind: "notice", tone: "info", text: "Rendered in an isolated Dynamic Worker."},
        {kind: "list", items: ["No host API", "No ambient network", "Bounded output"]},
      ],
    };
  },
};
