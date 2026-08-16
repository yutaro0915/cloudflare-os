export default {
  render() {
    return {
      schemaVersion: 1,
      blocks: [
        {kind: "notice", tone: "info", text: "Focus session ready"},
        {kind: "list", items: [
          "Pick one task",
          "Work for 25 minutes",
          "Share the result",
        ]},
      ],
    };
  },
};
