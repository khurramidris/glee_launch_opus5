// Deliberately small: extensions only need "same major, not newer than the
// host", so a full semver library would be dead weight.

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

const VERSION_PATTERN = /^(\d{1,4})(?:\.(\d{1,4}))?(?:\.(\d{1,4}))?$/;

export function parseVersion(value: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
  };
}

export type CompatResult = { ok: true } | { ok: false; reason: string };

/** Same major, and the extension may not ask for a newer minor than the host. */
export function checkApiCompatibility(extensionApi: string, hostApi: string): CompatResult {
  const wanted = parseVersion(extensionApi);
  const host = parseVersion(hostApi);
  if (!wanted) {
    return { ok: false, reason: `apiVersion "${extensionApi}" is not a valid version.` };
  }
  if (!host) {
    return { ok: false, reason: `Host API version "${hostApi}" is invalid.` };
  }
  if (wanted.major !== host.major) {
    return {
      ok: false,
      reason: `Needs extension API ${wanted.major}.x but this app provides ${host.major}.x.`,
    };
  }
  if (wanted.minor > host.minor) {
    return {
      ok: false,
      reason: `Needs extension API ${wanted.major}.${wanted.minor} but this app provides ${host.major}.${host.minor}.`,
    };
  }
  return { ok: true };
}
