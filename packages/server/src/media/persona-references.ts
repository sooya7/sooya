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

/**
 * Loads SOOYA's appearance reference images from the assets/references dir so a
 * `[[image-self]]` generation can keep her look consistent. Missing files are
 * skipped: replier then degrades to a normal generation instead of failing.
 */
export class PersonaReferenceLoader {
  constructor(
    private readonly refsDir: string | null,
    private readonly names: () => string[]
  ) {}

  async load(): Promise<PersonaReference[]> {
    if (!this.refsDir) return [];
    const refs: PersonaReference[] = [];
    for (const name of this.names()) {
      try {
        const data = await fsp.readFile(path.join(this.refsDir, name));
        const mime = MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'image/png';
        refs.push({ data, mime, name });
      } catch {
        // skip missing reference; generation falls back to no reference
      }
    }
    return refs;
  }
}
