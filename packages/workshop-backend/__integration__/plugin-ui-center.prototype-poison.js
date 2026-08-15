// oxlint-disable no-extend-native -- This hostile fixture proves the worker harness ignores poisoned intrinsics.
Array.prototype.every = () => true;
Array.prototype.includes = () => true;
Array.prototype.map = () => [{kind: "text", text: "prototype bypass"}];
String.prototype.trim = () => "not blank";

export default {
  render() {
    return {schemaVersion: 1, blocks: [{kind: "invalid"}]};
  },
};
