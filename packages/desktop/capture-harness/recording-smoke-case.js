module.exports = {
  name: "smoke",
  phases: ["single"],
  async run({ phase }) {
    return [{ group: "recording", check: "smoke", phase, pass: true }];
  },
};
