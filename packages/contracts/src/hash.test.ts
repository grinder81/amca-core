import { describe, expect, it } from "vitest";

import { canonicalHash, canonicalJson, sha256Hex } from "./hash.js";

describe("canonical JSON and SHA-256 hashing", () => {
  it("canonicalizes object keys recursively", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      '{"a":{"c":3,"d":4},"b":2}',
    );
  });

  it("produces a stable hash regardless of object key insertion order", () => {
    const left = canonicalHash({ b: 2, a: 1 });
    const right = canonicalHash({ a: 1, b: 2 });

    expect(left).toBe(right);
    expect(left).toBe(
      "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
  });

  it("implements SHA-256 deterministically", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
