/**
 * An append-only record of what the extension was doing, kept so that a hang
 * leaves evidence behind.
 *
 * Three hangs were diagnosed by measuring afterwards and guessing at which
 * measurement mattered, because nothing said what the extension had been doing
 * when the window stopped. VS Code's own tooling does not close the gap: its
 * unresponsive-extension-host profiler names a culprit, but only when the
 * extension host is what wedged - a renderer stuck drawing leaves nothing - and
 * its logs are pruned after about a dozen sessions, which is a few days.
 *
 * The mechanism is deliberately plain. Every risky operation writes a `begin`
 * line before it starts and an `end` line when it finishes, synchronously. A
 * log whose last line is an unmatched `begin` names the operation that never
 * came back, and it says so even if the window was killed outright - which is
 * why this cannot be an OutputChannel, whose contents die with the window.
 *
 * Kept free of vscode imports so it can be tested; the caller supplies the
 * sink and the clock.
 */

export type DiagKind = 'begin' | 'end' | 'note' | 'error';

export interface DiagRecord {
  at: string;
  kind: DiagKind;
  label: string;
  /** Milliseconds the operation took. Only on `end`. */
  ms?: number;
  /** Whatever makes the line actionable: a path, a size, a row count. */
  detail?: Record<string, unknown>;
}

/** Where the log is kept from growing without bound. */
export const MAX_LOG_BYTES = 256 * 1024;

/**
 * One record as a line of JSON.
 *
 * JSON rather than prose because the lines are read by eye when something has
 * gone wrong and by script when comparing runs, and because a detail with a
 * newline in it - a commit message, an error - must not be able to forge a
 * second record.
 */
export function formatRecord(record: DiagRecord): string {
  return JSON.stringify(record);
}

/**
 * Drops whole lines from the front until the text fits.
 *
 * The tail is what matters: the last thing the extension did before it stopped.
 * Trimming to a byte count alone would leave a partial line at the front, which
 * is the one shape a line-based log cannot recover from.
 */
export function trimToLimit(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }
  const lines = text.split('\n');
  let start = 0;
  let size = Buffer.byteLength(text, 'utf8');
  while (start < lines.length - 1 && size > maxBytes) {
    size -= Buffer.byteLength(lines[start]! + '\n', 'utf8');
    start++;
  }
  return lines.slice(start).join('\n');
}

/**
 * Pairs `begin` lines with their `end`s, which is how the log is read.
 *
 * Anything still open when the log runs out was in flight when the extension
 * stopped - the whole point of writing the `begin` before doing the work.
 */
export function unfinished(records: DiagRecord[]): DiagRecord[] {
  const open: DiagRecord[] = [];
  for (const record of records) {
    if (record.kind === 'begin') {
      open.push(record);
      continue;
    }
    if (record.kind === 'end') {
      // The matching begin is the most recent one with this label: operations
      // of the same kind do not overlap, and different kinds nest.
      for (let i = open.length - 1; i >= 0; i--) {
        if (open[i]!.label === record.label) {
          open.splice(i, 1);
          break;
        }
      }
    }
  }
  return open;
}

/** Parses a log back into records, ignoring anything that is not one. */
export function parseLog(text: string): DiagRecord[] {
  const records: DiagRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as DiagRecord;
      if (parsed && typeof parsed.label === 'string' && typeof parsed.kind === 'string') {
        records.push(parsed);
      }
    } catch {
      // A line torn in half by a kill, or by trimming. Skipping it is right:
      // the records either side of it are still good.
    }
  }
  return records;
}

export interface DiagnosticsOptions {
  /** Appends one line. Must be synchronous, or a kill loses the last record. */
  write(line: string): void;
  now?(): number;
  /** Wall clock, for the timestamp a human reads. */
  clock?(): Date;
}

export class Diagnostics {
  private readonly write: (line: string) => void;
  private readonly now: () => number;
  private readonly clock: () => Date;

  constructor(options: DiagnosticsOptions) {
    this.write = options.write;
    this.now = options.now ?? (() => Date.now());
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Marks an operation as started and returns the function that ends it.
   *
   * Call it around anything that could fail to return: a git invocation, a
   * parse over a whole file, a round trip to the webview. The `end` carries how
   * long it took and whatever the operation learned - a row count, a payload
   * size - so a run that completed slowly is as legible as one that never did.
   */
  begin(label: string, detail?: Record<string, unknown>): (extra?: Record<string, unknown>) => void {
    const started = this.now();
    this.record({ kind: 'begin', label, detail });

    let ended = false;
    return (extra?: Record<string, unknown>) => {
      if (ended) {
        return;
      }
      ended = true;
      this.record({
        kind: 'end',
        label,
        ms: this.now() - started,
        detail: extra,
      });
    };
  }

  note(label: string, detail?: Record<string, unknown>): void {
    this.record({ kind: 'note', label, detail });
  }

  error(label: string, err: unknown, detail?: Record<string, unknown>): void {
    this.record({
      kind: 'error',
      label,
      detail: {
        ...detail,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.split('\n').slice(0, 4).join(' | ') : undefined,
      },
    });
  }

  private record(partial: Omit<DiagRecord, 'at'>): void {
    try {
      this.write(formatRecord({ at: this.clock().toISOString(), ...partial }) + '\n');
    } catch {
      // Diagnostics must never be the reason something fails. A full disk or a
      // storage directory that is not there yet is not worth a broken feature.
    }
  }
}
