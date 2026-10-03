/**
 * The commit-message request, kept free of vscode so its sizing can be tested.
 */

export const COMMIT_MESSAGE_PROMPT =
  'Write a git commit message for the diff below. Use a short imperative subject ' +
  'line of at most 72 characters. Add a blank line and a brief body only if the ' +
  'change is not self-explanatory. Reply with the message only.\n\n';

/** Said in place of what was cut, so the model does not describe half a change as all of it. */
export const TRUNCATED_NOTE = '\n[diff truncated]\n';

/**
 * A diff cut down to fit a model's token budget.
 *
 * Token counts are only known for whole strings, so the cut is made in
 * proportion - `budget / tokens` of the characters, less a tenth, since a
 * diff's density is not even and an estimate that lands just over the limit
 * fails the request outright. It is made at a line break, so no line reaches
 * the model half-written.
 */
export function fitDiff(diff: string, tokens: number, budget: number): string {
  if (tokens <= budget) {
    return diff;
  }
  if (budget <= 0) {
    return TRUNCATED_NOTE;
  }
  const keep = Math.floor((diff.length * budget * 0.9) / tokens);
  const lineEnd = diff.lastIndexOf('\n', keep);
  return diff.slice(0, lineEnd > 0 ? lineEnd + 1 : keep) + TRUNCATED_NOTE;
}
