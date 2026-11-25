// Directorate path policy: which files are withheld from review, and how stored scopes become git pathspecs.
const LOCKFILES =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|Gemfile\.lock|composer\.lock|flake\.lock)$/u;

// Secrets are data and config files, never source code: `secrets.yaml` is withheld, `secrets.ts` is reviewed.
const SECRETS =
  /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.envrc|[^/]*\.(?:pem|key|p12|pfx|jks|keystore|tfvars|tfstate)|id_(?:rsa|ed25519|ecdsa|dsa)[^/]*|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.git-credentials|master\.key|[^/]*(?:credentials?|secrets?)[^/.]*(?:\.(?:json|ya?ml|toml|ini|env|txt|conf|cfg|properties|xml|enc|plist))?)$/iu;

const ENV_EXAMPLE = /(?:^|\/)\.env\.(?:example|sample|template)$/iu;

/** Git internals: a dependency's own .git/config can hold a remote URL with a token. */
const GIT_DIR = /(?:^|\/)\.git(?:\/|$)/iu;
const GENERATED = /(?:\.min\.(?:js|css)|\.map|\.snap)$/u;

/**
 * Withheld from every tool, not only from the diff. .gitignore cannot decide this: The Directorate already honours it for the live
 * tree, but committed secrets and the files in commit, range, and PR diffs are tracked, which .gitignore never covers.
 */
export const isSecret = (path: string) =>
  GIT_DIR.test(path) || (SECRETS.test(path) && !ENV_EXAMPLE.test(path));

/** Why a changed file's content is left out of the diff: secrets everywhere; lockfiles and generated files only here. */
export const exclusionReason = (path: string): string | undefined => {
  if (isSecret(path)) {
    return "[REDACTED] secret-like path: content withheld";
  }

  if (LOCKFILES.test(path)) {
    return "lockfile: review the manifest change instead";
  }

  if (GENERATED.test(path)) {
    return "generated or minified artifact";
  }

  return undefined;
};

/**
 * Gitignored directories whose files may be read from disk as evidence (installed dependencies). .gitignore alone is not
 * enough: it also covers local config, build output, and secrets, which must stay unreadable.
 */
export const DEPENDENCY_DIRS =
  /(?:^|\/)(?:node_modules|vendor|\.venv|venv|__pypackages__|bower_components|Pods|site-packages|\.bundle)\//u;

/** Stored scopes as git pathspecs; none, or only the root, is the whole repository. Tool inputs arrive as RepoScope. */
export const scopeOf = (paths?: readonly string[]) => {
  const s = (paths ?? [])
    .map((p) => p.replace(/\/+$/u, ""))
    .filter((p) => p !== "" && p !== ".");

  return s.length ? s : undefined;
};

export const inScope = (p: string, scope?: readonly string[]) =>
  !scope?.length || scope.some((d) => p === d || p.startsWith(`${d}/`));
