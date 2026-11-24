// Directorate path policy: which files are withheld from review, and how stored scopes become git pathspecs.
const LOCKFILES =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|Gemfile\.lock|composer\.lock|flake\.lock)$/;
// Secrets are data and config files, never source code: `secrets.yaml` is withheld, `secrets.ts` is reviewed.
const SECRETS =
  /(^|\/)(\.env(\.[^/]*)?|\.envrc|[^/]*\.(pem|key|p12|pfx|jks|keystore|tfvars|tfstate)|id_(rsa|ed25519|ecdsa|dsa)[^/]*|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.git-credentials|master\.key|[^/]*(credentials?|secrets?)[^/.]*(\.(json|ya?ml|toml|ini|env|txt|conf|cfg|properties|xml|enc|plist))?)$/i;
const ENV_EXAMPLE = /(^|\/)\.env\.(example|sample|template)$/i;
/** Git internals: a dependency's own .git/config can hold a remote URL with a token. */
const GIT_DIR = /(^|\/)\.git(\/|$)/;
const GENERATED = /(\.min\.(js|css)|\.map|\.snap)$/;

/**
 * Withheld from every tool, not only from the diff. .gitignore cannot decide this: The Directorate already honours it for the live
 * tree, but committed secrets and the files in commit, range, and PR diffs are tracked, which .gitignore never covers.
 */
export const isSecret = (path: string) =>
  GIT_DIR.test(path) || (SECRETS.test(path) && !ENV_EXAMPLE.test(path));
/** Why a changed file's content is left out of the diff: secrets everywhere; lockfiles and generated files only here. */
export function exclusionReason(path: string): string | undefined {
  if (isSecret(path)) return "[REDACTED] secret-like path: content withheld";
  if (LOCKFILES.test(path))
    return "lockfile: review the manifest change instead";
  if (GENERATED.test(path)) return "generated or minified artifact";
  return undefined;
}
/**
 * Gitignored directories whose files may be read from disk as evidence (installed dependencies). .gitignore alone is not
 * enough: it also covers local config, build output, and secrets, which must stay unreadable.
 */
export const DEPENDENCY_DIRS =
  /(^|\/)(node_modules|vendor|\.venv|venv|__pypackages__|bower_components|Pods|site-packages|\.bundle)\//;
/** Stored scopes as git pathspecs; none, or only the root, is the whole repository. Tool inputs arrive as RepoScope. */
export const scopeOf = (paths?: readonly string[]) => {
  const s = (paths ?? []).filter((p) => p !== "" && p !== ".");
  return s.length ? s : undefined;
};
