// No inherited vendor legal policy applies to Cinderdeck. This screen opens
// the licenses for incorporated source; optional product policies are supplied
// by the maintainer through explicit URLs.
export const LEGAL_URL = "https://github.com/RyanCardin15/Cinderdeck/blob/main/NOTICE";
const SECURITY_POLICY_URL = "https://github.com/RyanCardin15/Cinderdeck/blob/main/SECURITY.md";
const configuredDocument = (value: string | undefined): string | undefined => {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};
const PRIVACY_POLICY_URL = configuredDocument(process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL);
const TERMS_OF_SERVICE_URL = configuredDocument(process.env.EXPO_PUBLIC_TERMS_OF_SERVICE_URL);

const ALLOWED_LEGAL_DOCUMENT_URLS = [
  LEGAL_URL,
  PRIVACY_POLICY_URL,
  TERMS_OF_SERVICE_URL,
  SECURITY_POLICY_URL,
] as const;

function webDocumentIdentity(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;

    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

const ALLOWED_LEGAL_DOCUMENT_IDENTITIES = new Set(
  ALLOWED_LEGAL_DOCUMENT_URLS.filter((value): value is string => typeof value === "string").map(webDocumentIdentity).filter(
    (value): value is string => value !== null,
  ),
);

export function isLegalDocumentUrl(value: string): boolean {
  const identity = webDocumentIdentity(value);
  return identity !== null && ALLOWED_LEGAL_DOCUMENT_IDENTITIES.has(identity);
}
