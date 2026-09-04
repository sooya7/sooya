/**
 * What actually produced a generated image, and whether that matches what we asked for.
 *
 * Why this exists: an aggregating image endpoint can accept a request for model
 * X, generate with model Y, and return 200. Nothing in the HTTP response says
 * so. Observed in production over three weeks against a single configured
 * model: images came back from `gpt-image`, `fal-ai/gpt-image-2`, a Google
 * generator, `Azure OpenAI ImageGen`, and finally `fal-ai/flux-2-klein` — a 4B
 * model whose output at the same aspect ratio is a quarter of the pixels. The
 * substitution was only noticed by looking at the pictures, days later.
 *
 * Two signals make it detectable without any extra network call, because both
 * travel inside the bytes we already have:
 *
 * 1. **Pixel dimensions** (PNG IHDR) versus the size we requested.
 * 2. **C2PA provenance** (`caBX` chunk) — generators sign their output and
 *    record a `softwareAgent`, which names the model that really ran.
 *
 * The C2PA manifest is JUMBF-wrapped CBOR. Rather than take on a parser for a
 * signal that is advisory, this reads the `softwareAgent` name with a byte
 * pattern verified against real manifests from five different generators. It
 * is deliberately fail-soft: an unparseable or absent manifest yields
 * `provenance: 'unknown'`, never an error and never a false accusation.
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/*
 * Where the model name sits inside a C2PA manifest.
 *
 * The manifest is CBOR, so `dname` (itself a length-prefixed key) is followed
 * by a *header byte* for the value, then the value's bytes. That header must be
 * consumed and used, not guessed at: for short strings it is `0x60 | length`,
 * which lands in printable ASCII (`` ` `` … `w`). A regex that simply grabs
 * printable characters after `dname` therefore captures the header as the first
 * letter — real manifests come out as `igpt-image`, `sfal-ai/flux-2-klein`,
 * `fFLUX.2`. That is not cosmetic: `igptimage` no longer matches the requested
 * `gptimage2`, so every correctly-served image would be reported as a
 * substitution. Read the length instead and slice exactly.
 */
const AGENT_KEY = Buffer.from('msoftwareAgent', 'latin1');
const NAME_KEY = Buffer.from('dname', 'latin1');
/** How far after the softwareAgent key the `dname` entry may appear. */
const NAME_KEY_WINDOW = 16;
const CBOR_TEXT_SHORT_MIN = 0x60;
const CBOR_TEXT_SHORT_MAX = 0x77;
const CBOR_TEXT_LEN_8 = 0x78;

export interface ImageBytesFacts {
  width: number | null;
  height: number | null;
  /** Model/software that signed the image, when it says so. */
  softwareAgent: string | null;
}

/** Reads dimensions and C2PA software agent from PNG bytes. Never throws. */
export function readImageBytesFacts(data: Buffer): ImageBytesFacts {
  const facts: ImageBytesFacts = { width: null, height: null, softwareAgent: null };
  try {
    if (data.byteLength < 8 || !data.subarray(0, 8).equals(PNG_MAGIC)) return facts;
    let offset = 8;
    while (offset + 8 <= data.byteLength) {
      const length = data.readUInt32BE(offset);
      const type = data.subarray(offset + 4, offset + 8).toString('latin1');
      const body = data.subarray(offset + 8, offset + 8 + length);
      if (type === 'IHDR' && body.byteLength >= 8) {
        facts.width = body.readUInt32BE(0);
        facts.height = body.readUInt32BE(4);
      } else if (type === 'caBX' && facts.softwareAgent === null) {
        facts.softwareAgent = readSoftwareAgent(body);
      } else if (type === 'IEND') {
        break;
      }
      // 4-byte length + 4-byte type + payload + 4-byte CRC
      offset += 12 + length;
    }
  } catch {
    /* Truncated or malformed input: report whatever was read before the problem. */
  }
  return facts;
}

function readSoftwareAgent(manifest: Buffer): string | null {
  const agentAt = manifest.indexOf(AGENT_KEY);
  if (agentAt < 0) return null;
  const searchFrom = agentAt + AGENT_KEY.byteLength;
  const nameAt = manifest.indexOf(NAME_KEY, searchFrom);
  if (nameAt < 0 || nameAt > searchFrom + NAME_KEY_WINDOW) return null;

  let cursor = nameAt + NAME_KEY.byteLength;
  const header = manifest[cursor];
  if (header === undefined) return null;
  cursor += 1;

  let length: number;
  if (header >= CBOR_TEXT_SHORT_MIN && header <= CBOR_TEXT_SHORT_MAX) {
    length = header - CBOR_TEXT_SHORT_MIN;
  } else if (header === CBOR_TEXT_LEN_8) {
    const declared = manifest[cursor];
    if (declared === undefined) return null;
    length = declared;
    cursor += 1;
  } else {
    // Not a CBOR text string where one was expected: report unknown rather
    // than guess, so a format change degrades to silence, not to a false alarm.
    return null;
  }
  if (length < 3 || cursor + length > manifest.byteLength) return null;

  const value = manifest.subarray(cursor, cursor + length).toString('utf8').trim();
  return value.length >= 3 ? value : null;
}

/**
 * Comparable form of a model identifier: drop the vendor prefix and every
 * separator, so `anuma/flux-2-pro`, `fal-ai/flux-2-pro` and `FLUX.2 pro` all
 * reduce to something that can be compared by containment.
 */
function normalizeModelId(value: string): string {
  const withoutVendor = value.includes('/') ? value.slice(value.lastIndexOf('/') + 1) : value;
  return withoutVendor.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

/**
 * Does the reported agent plausibly name a model at all? `Google C2PA Core
 * Generator Library` and `OpenAI Media Service API` identify a *signer*, not a
 * model, so they must not be read as evidence of substitution.
 */
function looksLikeModelId(agent: string): boolean {
  if (/\b(library|service|api|generator|toolkit|sdk)\b/iu.test(agent)) return false;
  return /[0-9]/u.test(agent) || agent.includes('/') || agent.includes('-');
}

export type ProvenanceVerdict = 'match' | 'mismatch' | 'unknown';

export interface ImageProvenanceReport {
  requestedModel: string;
  requestedSize: string | null;
  actualSize: string | null;
  softwareAgent: string | null;
  provenance: ProvenanceVerdict;
  sizeMismatch: boolean;
  /** Human-readable summary when something is off, else null. */
  summary: string | null;
}

/**
 * Compares generated bytes against the request. Size disagreement is a fact;
 * model disagreement is only asserted when the signature names a model and
 * that model shares nothing with the one requested.
 */
export function inspectGeneratedImage(input: {
  data: Buffer;
  requestedModel: string;
  requestedSize?: string | null;
}): ImageProvenanceReport {
  const facts = readImageBytesFacts(input.data);
  const requestedSize = input.requestedSize?.trim() || null;
  const actualSize = facts.width !== null && facts.height !== null ? `${facts.width}x${facts.height}` : null;

  const sizeMismatch = Boolean(requestedSize && actualSize && requestedSize !== actualSize);

  let provenance: ProvenanceVerdict = 'unknown';
  if (facts.softwareAgent && looksLikeModelId(facts.softwareAgent)) {
    const wanted = normalizeModelId(input.requestedModel);
    const got = normalizeModelId(facts.softwareAgent);
    const overlaps = wanted.length > 0 && got.length > 0 && (wanted.includes(got) || got.includes(wanted));
    provenance = overlaps ? 'match' : 'mismatch';
  }

  const problems: string[] = [];
  if (provenance === 'mismatch') {
    problems.push(`requested model ${input.requestedModel} but the image is signed by ${facts.softwareAgent}`);
  }
  if (sizeMismatch) {
    problems.push(`requested ${requestedSize} but received ${actualSize}`);
  }

  return {
    requestedModel: input.requestedModel,
    requestedSize,
    actualSize,
    softwareAgent: facts.softwareAgent,
    provenance,
    sizeMismatch,
    summary: problems.length > 0 ? problems.join('; ') : null
  };
}
