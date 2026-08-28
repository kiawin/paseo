import { describe, expect, it } from "vitest";

const {
  FDROID_ABI_VERSION_CODE_SUFFIXES,
  getFdroidVersionCodes,
  getNativeReleaseVersion,
} = require("./native-release-version");

describe("native release version", () => {
  it("reserves the final iOS build slot for a stable release", () => {
    expect(getNativeReleaseVersion("0.2.6")).toEqual({
      appVersion: "0.2.6",
      androidVersionCode: 2006,
      iosBuildNumber: "2006999",
    });
  });

  it("gives each beta a unique iOS build slot under the stable app version", () => {
    expect(getNativeReleaseVersion("0.2.6-beta.2")).toEqual({
      appVersion: "0.2.6",
      androidVersionCode: 2006,
      iosBuildNumber: "2006002",
    });
  });

  it("keeps a fork suffix in the marketing version and out of the version codes", () => {
    expect(getNativeReleaseVersion("0.7.0-beta.1.kiawin.gfff20d5")).toEqual({
      appVersion: "0.7.0.kiawin.gfff20d5",
      androidVersionCode: 7000,
      iosBuildNumber: "7000001",
    });
  });

  it("rejects a fork suffix that no release tag could carry", () => {
    // Only beta.N can precede the suffix, so these are unreachable by design.
    expect(() => getNativeReleaseVersion("0.7.0.kiawin.gfff20d5")).toThrow("unsupported version");
    expect(() => getNativeReleaseVersion("0.7.0-beta.1.kiawin")).toThrow("unsupported version");
    expect(() => getNativeReleaseVersion("0.7.0-rc.1")).toThrow("unsupported version");
  });

  it("rejects beta numbers that consume the stable iOS build slot", () => {
    expect(() => getNativeReleaseVersion("0.2.6-beta.999")).toThrow(
      "iOS beta number must be between 1 and 998",
    );
  });

  it("derives one F-Droid version code per published ABI", () => {
    expect(FDROID_ABI_VERSION_CODE_SUFFIXES).toEqual({
      "armeabi-v7a": 1,
      "arm64-v8a": 2,
      x86: 3,
      x86_64: 4,
    });
    expect(getFdroidVersionCodes("0.5.0")).toEqual([
      { abi: "armeabi-v7a", versionCode: 50001 },
      { abi: "arm64-v8a", versionCode: 50002 },
      { abi: "x86", versionCode: 50003 },
      { abi: "x86_64", versionCode: 50004 },
    ]);
  });
});
