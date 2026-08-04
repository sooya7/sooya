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
 * only consumes a single reference, so this stops at the first readable file
 * instead of reading every configured image into memory on each generation.
 * Missing files are skipped so the generation degrades to no reference instead
 * of failing — but each skip is logged as a warning, because a misconfigured
 * file name would otherwise silently disable reference-based generation forever.
 */
export class PersonaReferenceLoader {
  constructor(
    private readonly refsDir: string | null,
    private readonly names: () => string[],
    private readonly onLog?: LogFn
  ) {}

  async load(): Promise<PersonaReference[]> {
    const configured = this.names();
    if (!this.refsDir) {
      if (configured.length > 0) {
        this.onLog?.('warn', 'persona reference images configured but references dir not found', { names: configured });
      }
      return [];
    }
    for (const name of configured) {
      try {
        const data = await fsp.readFile(path.join(this.refsDir, name));
        const mime = MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'image/png';
        return [{ data, mime, name }];
      } catch (err) {
        // Missing/unreadable reference: try the next configured file, but surface
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
