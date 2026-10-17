import { describe, expect, it } from "vitest";
import { describeTransfer, formatBytes, formatDuration, TransferRateMeter } from "./download-progress";

const MB = 1024 * 1024;

describe("download progress formatting", () => {
  it("formats sizes in MB and GB", () => {
    expect(formatBytes(0)).toBe("0 MB");
    expect(formatBytes(25 * MB)).toBe("25 MB");
    expect(formatBytes(1212103520)).toBe("1.1 GB");
  });

  it("formats remaining time in plain words", () => {
    expect(formatDuration(20)).toBe("less than a minute");
    expect(formatDuration(150)).toBe("about 3 minutes");
    expect(formatDuration(3 * 3600)).toBe("about 3 h");
    expect(formatDuration(0)).toBe("");
  });

  it("describes a transfer with speed and estimate", () => {
    expect(describeTransfer(500 * MB, 1000 * MB, 10 * MB)).toBe(
      "500 MB of 1000 MB · 10 MB/s · less than a minute left",
    );
    expect(describeTransfer(0, 1000 * MB, 0)).toBe("0 MB of 1000 MB");
  });

  it("smooths the transfer rate between updates", () => {
    const meter = new TransferRateMeter();
    meter.update(0, 1000);
    expect(meter.update(10 * MB, 2000)).toBe(10 * MB);
    const smoothed = meter.update(30 * MB, 3000);
    expect(smoothed).toBeGreaterThan(10 * MB);
    expect(smoothed).toBeLessThan(20 * MB);
  });
});
