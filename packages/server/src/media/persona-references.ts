import path from 'node:path';
import fsp from 'node:fs/promises';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
};

export interface PersonaReference {
  data: Buffer;
  mime: string;
  name: string;
}

type LogFn = (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;

/**
 * Loads SOOYA's appearance reference images from the assets/references dir so a
 * `[[image-self]]` generation can keep her look consistent. The image provider
 * only consumes a single reference, so this picks the ONE configured image that
 * best fits what the generation is showing: a side-profile shot uses the side
 * reference, a full-body shot the standing one, and everything else the default
 * front/half-body one. Selection matches framing keywords in the prompt against
 * framing keywords in the file names, falling back to the first readable file
 * when nothing fits or the chosen file cannot be read. Missing files are
 * skipped so the generation degrades to no reference instead of failing — but
 * each skip is logged as a warning, because a misconfigured file name would
 * otherwise silently disable reference-based generation forever.
 */
export class PersonaReferenceLoader {
  constructor(
    private readonly refsDir: string | null,
    private readonly names: () => string[],
    private readonly onLog?: LogFn
  ) {}

  async load(hint?: string): Promise<PersonaReference[]> {
    const configured = this.names();
    if (!this.refsDir) {
      if (configured.length > 0) {
        this.onLog?.('warn', 'persona reference images configured but references dir not found', { names: configured });
      }
      return [];
    }
    const wanted = hint ? classifyFraming(hint) : null;
    const order = wanted
      ? [...configured.filter((name) => classifyFraming(name) === wanted), ...configured.filter((name) => classifyFraming(name) !== wanted)]
      : configured;
    if (wanted && order.length > 0 && order[0] !== configured[0]) {
      this.onLog?.('info', 'persona reference auto-selected from prompt framing', { framing: wanted, picked: order[0], hint: hint?.slice(0, 120) });
    }
    for (const name of order) {
      try {
        const data = await fsp.readFile(path.join(this.refsDir, name));
        const mime = MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'image/png';
        return [{ data, mime, name }];
      } catch (err) {
        // Missing/unreadable reference: try the next candidate, but surface
        // the skip so a wrong file name (e.g. bad extension) never fails silently.
        this.onLog?.('warn', 'persona reference image missing, generation will run without it', { name, refsDir: this.refsDir, err: (err as Error).message });
      }
    }
    if (configured.length > 0) {
      this.onLog?.('warn', 'all persona reference images failed to load', { refsDir: this.refsDir, names: configured });
    }
    return [];
  }
}

type Framing = 'side' | 'full-body' | 'front';

const SIDE_WORDS = /侧脸|侧面|侧颜|侧身|侧着|side|profile/i;
const FULL_BODY_WORDS = /全身|站立|站着|站姿|从头到脚|全身照|full[\s_-]?body|standing|whole body|head to toe/i;

/**
 * Classifies a prompt or file name by framing. Side wins over full-body because
 * a profile shot is the most reference-dependent framing; the plain front /
 * half-body reference is the default when nothing more specific shows up.
 */
export function classifyFraming(text: string): Framing {
  if (SIDE_WORDS.test(text)) return 'side';
  if (FULL_BODY_WORDS.test(text)) return 'full-body';
  return 'front';
}
