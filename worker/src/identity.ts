import { base64Url } from "./crypto";

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

const ADJECTIVES = [
  "amber",
  "brave",
  "bright",
  "calm",
  "clever",
  "cosmic",
  "crisp",
  "dapper",
  "eager",
  "fair",
  "fast",
  "fierce",
  "gentle",
  "glad",
  "golden",
  "grand",
  "happy",
  "hazy",
  "honest",
  "jolly",
  "keen",
  "kind",
  "lively",
  "lucky",
  "merry",
  "mighty",
  "misty",
  "neat",
  "nimble",
  "noble",
  "peppy",
  "plucky",
  "proud",
  "quick",
  "quiet",
  "rapid",
  "ready",
  "rosy",
  "royal",
  "sharp",
  "shiny",
  "silent",
  "silver",
  "smart",
  "snappy",
  "solar",
  "steady",
  "sunny",
  "swift",
  "tidy",
  "tiny",
  "true",
  "vivid",
  "warm",
  "wavy",
  "wild",
  "wise",
  "witty",
  "young",
  "zany",
  "zesty",
  "bold",
  "fresh",
  "loyal",
] as const;

const ANIMALS = [
  "badger",
  "beaver",
  "bison",
  "bobcat",
  "canary",
  "caribou",
  "condor",
  "coral",
  "coyote",
  "crane",
  "dingo",
  "dolphin",
  "dragon",
  "eagle",
  "falcon",
  "ferret",
  "finch",
  "fox",
  "gecko",
  "gibbon",
  "heron",
  "ibis",
  "iguana",
  "jaguar",
  "koala",
  "lemur",
  "lion",
  "lynx",
  "marmot",
  "moose",
  "narwhal",
  "ocelot",
  "orca",
  "otter",
  "owl",
  "panda",
  "parrot",
  "pika",
  "puffin",
  "quail",
  "rabbit",
  "raven",
  "salmon",
  "seal",
  "shark",
  "skink",
  "sloth",
  "sparrow",
  "stoat",
  "swan",
  "tahr",
  "tapir",
  "tern",
  "tiger",
  "toucan",
  "turtle",
  "vicuna",
  "walrus",
  "weasel",
  "whale",
  "wolf",
  "wombat",
  "yak",
  "zebra",
] as const;

export const INBOX_ID_PATTERN = /^[a-z]+-[a-z]+-[a-z2-7]{10}$/;

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let result = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      result += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    result += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return result;
}

function randomIndex(length: number): number {
  const bytes = crypto.getRandomValues(new Uint8Array(1));
  return (bytes[0] ?? 0) % length;
}

export function randomInboxId(): string {
  const adjective = ADJECTIVES[randomIndex(ADJECTIVES.length)];
  const animal = ANIMALS[randomIndex(ANIMALS.length)];
  const suffix = base32(crypto.getRandomValues(new Uint8Array(7))).slice(0, 10);
  return `${adjective}-${animal}-${suffix}`;
}

export function randomCapability(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `ibl_${base64Url(bytes)}`;
}

export function inboxIdFromAddress(address: string, domain: string): string | null {
  const normalized = address.trim().toLowerCase();
  const suffix = `@${domain.trim().toLowerCase()}`;
  if (!normalized.endsWith(suffix)) {
    return null;
  }

  const id = normalized.slice(0, -suffix.length);
  return INBOX_ID_PATTERN.test(id) ? id : null;
}
