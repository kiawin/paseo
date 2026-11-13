module.exports = {
  name: "limitation-smoke",
  phases: ["single"],
  async run({ phase }) {
    return [
      {
        group: "recording",
        check: "limitation-smoke",
        phase,
        pass: true,
        limitation: "example unavailable capability",
      },
    ];
  },
};
