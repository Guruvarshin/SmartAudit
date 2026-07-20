/**
 * Minimal parser for `--key=value` and `--flag` style arguments.
 *
 * Shared by the seed script and (from Day 3) the model-migration CLI so both
 * accept arguments the same way.
 */
export class CliArguments {
  constructor(argv = process.argv.slice(2)) {
    this.values = new Map();
    for (const token of argv) {
      if (!token.startsWith('--')) continue;
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq === -1) {
        this.values.set(body, 'true');
      } else {
        this.values.set(body.slice(0, eq), body.slice(eq + 1));
      }
    }
  }

  has(name) {
    return this.values.has(name);
  }

  string(name, fallback = null) {
    return this.values.has(name) ? this.values.get(name) : fallback;
  }

  int(name, fallback) {
    if (!this.values.has(name)) return fallback;
    const parsed = Number.parseInt(this.values.get(name), 10);
    if (!Number.isFinite(parsed)) {
      throw new Error(`--${name} must be an integer, got "${this.values.get(name)}".`);
    }
    return parsed;
  }

  bool(name, fallback = false) {
    if (!this.values.has(name)) return fallback;
    return this.values.get(name) !== 'false';
  }
}
