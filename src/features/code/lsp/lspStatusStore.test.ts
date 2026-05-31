import { describe, it, expect, beforeEach } from "vitest";
import { setLspStatus, getLspStatus, getAllLspStatus } from "./lspStatusStore";

describe("lspStatusStore", () => {
  beforeEach(() => {
    // reset connu : on remet tous les langs testés à "absent".
    setLspStatus("rust", "absent");
    setLspStatus("typescript", "absent");
  });

  it("defaults to absent for an unknown lang", () => {
    expect(getLspStatus("python")).toBe("absent");
  });

  it("stores and reads a status per language", () => {
    setLspStatus("rust", "ready");
    expect(getLspStatus("rust")).toBe("ready");
    expect(getLspStatus("typescript")).toBe("absent");
  });

  it("getAllLspStatus reflects the latest writes", () => {
    setLspStatus("rust", "starting");
    setLspStatus("typescript", "error");
    const all = getAllLspStatus();
    expect(all.rust).toBe("starting");
    expect(all.typescript).toBe("error");
  });
});
