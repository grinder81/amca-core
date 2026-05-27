import type { JsonObject, JsonValue, Sha256Hash } from "@amca/protocol";

const SHA256_INITIAL_HASH = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
]);

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function canonicalJson(value: JsonValue): string {
  return serializeJsonValue(value);
}

export function canonicalHash(value: JsonValue): Sha256Hash {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

export function canonicalObjectHash(value: JsonObject): Sha256Hash {
  return canonicalHash(value);
}

export function sha256Hex(input: string): string {
  const bytes = utf8Bytes(input);
  const bitLength = bytes.length * 8;
  const totalLength = paddedSha256Length(bytes.length);
  const data = new Uint8Array(totalLength);
  data.set(bytes);
  data[bytes.length] = 0x80;
  writeUint64BigEndian(data, totalLength - 8, bitLength);

  const state = new Uint32Array(SHA256_INITIAL_HASH);
  const words = new Uint32Array(64);

  for (let blockOffset = 0; blockOffset < data.length; blockOffset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const offset = blockOffset + index * 4;
      words[index] =
        (byteAt(data, offset) << 24) |
        (byteAt(data, offset + 1) << 16) |
        (byteAt(data, offset + 2) << 8) |
        byteAt(data, offset + 3);
    }

    for (let index = 16; index < 64; index += 1) {
      const s0 =
        rotateRight(wordAt(words, index - 15), 7) ^
        rotateRight(wordAt(words, index - 15), 18) ^
        (wordAt(words, index - 15) >>> 3);
      const s1 =
        rotateRight(wordAt(words, index - 2), 17) ^
        rotateRight(wordAt(words, index - 2), 19) ^
        (wordAt(words, index - 2) >>> 10);
      words[index] =
        (wordAt(words, index - 16) + s0 + wordAt(words, index - 7) + s1) >>> 0;
    }

    let a = wordAt(state, 0);
    let b = wordAt(state, 1);
    let c = wordAt(state, 2);
    let d = wordAt(state, 3);
    let e = wordAt(state, 4);
    let f = wordAt(state, 5);
    let g = wordAt(state, 6);
    let h = wordAt(state, 7);

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 =
        (h + sum1 + choice + wordAt(SHA256_K, index) + wordAt(words, index)) >>>
        0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    state[0] = (wordAt(state, 0) + a) >>> 0;
    state[1] = (wordAt(state, 1) + b) >>> 0;
    state[2] = (wordAt(state, 2) + c) >>> 0;
    state[3] = (wordAt(state, 3) + d) >>> 0;
    state[4] = (wordAt(state, 4) + e) >>> 0;
    state[5] = (wordAt(state, 5) + f) >>> 0;
    state[6] = (wordAt(state, 6) + g) >>> 0;
    state[7] = (wordAt(state, 7) + h) >>> 0;
  }

  return Array.from(state, (word) => word.toString(16).padStart(8, "0")).join(
    "",
  );
}

function serializeJsonValue(value: JsonValue): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return stringifyJson(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON only supports finite numbers");
    }

    return stringifyJson(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeJsonValue(item)).join(",")}]`;
  }

  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const serializedEntries = entries.map(
    ([key, entryValue]) =>
      `${JSON.stringify(key)}:${serializeJsonValue(entryValue)}`,
  );

  return `{${serializedEntries.join(",")}}`;
}

function paddedSha256Length(byteLength: number): number {
  const lengthWithOneBit = byteLength + 1;
  const paddingLength = (64 - ((lengthWithOneBit + 8) % 64)) % 64;

  return lengthWithOneBit + paddingLength + 8;
}

function writeUint64BigEndian(
  data: Uint8Array,
  offset: number,
  value: number,
): void {
  const high = Math.floor(value / 0x100000000);
  const low = value >>> 0;

  data[offset] = (high >>> 24) & 0xff;
  data[offset + 1] = (high >>> 16) & 0xff;
  data[offset + 2] = (high >>> 8) & 0xff;
  data[offset + 3] = high & 0xff;
  data[offset + 4] = (low >>> 24) & 0xff;
  data[offset + 5] = (low >>> 16) & 0xff;
  data[offset + 6] = (low >>> 8) & 0xff;
  data[offset + 7] = low & 0xff;
}

function rotateRight(value: number, shift: number): number {
  return ((value >>> shift) | (value << (32 - shift))) >>> 0;
}

function byteAt(data: Uint8Array, index: number): number {
  return data[index] ?? 0;
}

function wordAt(data: Uint32Array, index: number): number {
  return data[index] ?? 0;
}

function stringifyJson(value: string | number): string {
  return JSON.stringify(value);
}

function utf8Bytes(input: string): Uint8Array {
  const bytes: number[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const codePoint = input.codePointAt(index);

    if (codePoint === undefined) {
      continue;
    }

    if (codePoint > 0xffff) {
      index += 1;
    }

    appendUtf8CodePoint(bytes, codePoint);
  }

  return Uint8Array.from(bytes);
}

function appendUtf8CodePoint(bytes: number[], codePoint: number): void {
  if (codePoint <= 0x7f) {
    bytes.push(codePoint);
    return;
  }

  if (codePoint <= 0x7ff) {
    bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
    return;
  }

  if (codePoint <= 0xffff) {
    bytes.push(
      0xe0 | (codePoint >>> 12),
      0x80 | ((codePoint >>> 6) & 0x3f),
      0x80 | (codePoint & 0x3f),
    );
    return;
  }

  bytes.push(
    0xf0 | (codePoint >>> 18),
    0x80 | ((codePoint >>> 12) & 0x3f),
    0x80 | ((codePoint >>> 6) & 0x3f),
    0x80 | (codePoint & 0x3f),
  );
}
