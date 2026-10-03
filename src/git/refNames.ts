import { Git } from './git';

export type RefKind = 'branch' | 'tag';

/**
 * Why a name cannot be used for a new branch or tag, or undefined when it can.
 *
 * git is asked rather than its rules restated: the hand-written check this
 * replaces missed "@{", a trailing ".", "//" and control characters, and the
 * new-branch-at-a-commit prompts only checked that something had been typed.
 * `check-ref-format` is the rule book git itself enforces.
 *
 * Two of its answers are not taken at its word. With --branch, inside a
 * repository, "@{-1}" is expanded to the previous branch's name and passes,
 * so the name is only accepted when git hands it back unchanged. And a name
 * beginning with "-" is a valid ref but would be read as an option by the
 * `git branch` or `git tag` that follows, as is a lone "@", which --branch
 * also lets through although git reserves it for HEAD.
 */
export async function refNameProblem(
  git: Git,
  cwd: string,
  kind: RefKind,
  raw: string
): Promise<string | undefined> {
  const name = raw.trim();
  if (!name) {
    return 'Enter a name.';
  }
  const invalid = `'${name}' is not a valid ${kind} name.`;
  if (name === '@' || name.startsWith('-')) {
    return invalid;
  }
  const args =
    kind === 'branch'
      ? ['check-ref-format', '--branch', name]
      : ['check-ref-format', `refs/tags/${name}`];
  try {
    const out = await git.exec(cwd, args);
    if (kind === 'branch' && out.trim() !== name) {
      return invalid;
    }
    return undefined;
  } catch {
    return invalid;
  }
}
