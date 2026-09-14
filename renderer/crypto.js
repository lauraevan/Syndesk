const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded =
    base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(
    binary,
    (character) => character.charCodeAt(0),
  );
}

export function normalizeKey(value) {
  let normalized = String(value)
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "");
  if (normalized.startsWith("SYN")) {
    normalized = normalized.slice(3);
  }
  normalized = normalized
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (
    normalized.length !== 32 ||
    [...normalized].some(
      (character) => !BASE32.includes(character),
    )
  ) {
    throw new Error("The stored Syndesk key is invalid.");
  }
  return normalized;
}

async function deriveBits(material, label) {
  const encoder = new TextEncoder();
  return crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("Syndesk secure pairing v1"),
      info: encoder.encode(label),
    },
    material,
    256,
  );
}

export async function deriveSecrets(key) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(normalizeKey(key)),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const [locatorBits, tokenBits, signalBits] =
    await Promise.all([
      deriveBits(material, "device locator"),
      deriveBits(material, "authorization token"),
      deriveBits(material, "signaling encryption"),
    ]);
  return {
    locator: bytesToBase64Url(
      new Uint8Array(locatorBits),
    ),
    token: bytesToBase64Url(new Uint8Array(tokenBits)),
    signalKey: await crypto.subtle.importKey(
      "raw",
      signalBits,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    ),
  };
}

export async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function encryptSignal(
  key,
  locator,
  payload,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(
    JSON.stringify(payload),
  );
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(locator),
    },
    key,
    data,
  );
  return (
    bytesToBase64Url(iv) +
    "." +
    bytesToBase64Url(new Uint8Array(encrypted))
  );
}

export async function decryptSignal(
  key,
  locator,
  payload,
) {
  const [ivValue, cipherValue] = payload.split(".");
  if (!ivValue || !cipherValue) {
    throw new Error("The encrypted offer is invalid.");
  }
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(ivValue),
      additionalData: new TextEncoder().encode(locator),
    },
    key,
    base64UrlToBytes(cipherValue),
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
}

export function waitForIceGathering(
  connection,
  timeoutMs = 10000,
) {
  if (connection.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = window.setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timeout);
      connection.removeEventListener(
        "icegatheringstatechange",
        check,
      );
      resolve();
    }
    function check() {
      if (connection.iceGatheringState === "complete") {
        done();
      }
    }
    connection.addEventListener(
      "icegatheringstatechange",
      check,
    );
  });
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
