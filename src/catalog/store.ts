import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseCapability, type Capability } from '../types/capability.js';

/**
 * Capability storage. Deliberately just versioned JSON files on disk: reviewable,
 * git-diffable, and free of any scaling infrastructure (which the brief penalizes).
 * The filename is the capability id; the artifact carries its own version.
 */
export class CapabilityStore {
  constructor(private readonly dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  save(cap: Capability): void {
    writeFileSync(this.path(cap.id), JSON.stringify(cap, null, 2) + '\n', 'utf8');
  }

  load(id: string): Capability {
    const p = this.path(id);
    if (!existsSync(p)) throw new Error(`Capability "${id}" not found at ${p}`);
    return parseCapability(JSON.parse(readFileSync(p, 'utf8')));
  }

  list(): Capability[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return parseCapability(JSON.parse(readFileSync(join(this.dir, f), 'utf8')));
        } catch {
          return null;
        }
      })
      .filter((c): c is Capability => c !== null);
  }
}
