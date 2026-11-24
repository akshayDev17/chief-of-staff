// AWS Signature Version 4 and the two STS calls the Bedrock plug-in makes,
// in the Worker with Web Crypto and no AWS SDK.
//
// SigV4 follows AWS's "Create a signed AWS API request" (IAM User Guide,
// read 2026-11-25, no page date):
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
// and is tested against AWS's published signing test suite (get-vanilla,
// get-vanilla-query-order-key-case, post-vanilla, post-x-www-form-urlencoded;
// awslabs/aws-c-auth tests/aws-signing-test-suite/v4, read 2026-11-25).
//
// STS, read 2026-11-25 (no page dates):
// - AssumeRoleWithWebIdentity: "Calling `AssumeRoleWithWebIdentity` does not
//   require the use of AWS security credentials"; DurationSeconds 900 to
//   43200, default 3600.
//   https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html
// - AssumeRole, with ExternalId (2 to 1224 characters): "Role chaining limits
//   your AWS CLI or AWS API role session to a maximum of one hour."
//   https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html
// - A Query API refusal is an `ErrorResponse` holding `Error` with `Type`,
//   `Code` and `Message` (the shape AWS documents for its Query APIs, read
//   on https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-api-responses.html).

import { ProviderRefusal } from "../proxy/plugin";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: string;
}

const encoder = new TextEncoder();
const hex = (buffer: ArrayBuffer): string => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const sha256Hex = async (text: string): Promise<string> => hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, encoder.encode(data));
}

// RFC 3986 percent-encoding: everything but A-Z a-z 0-9 - . _ ~.
export const uriEncode = (text: string): string =>
  encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// "Each path segment must be URI-encoded twice" for every service but S3:
// the path as sent is already encoded once, so it is encoded once more here.
const canonicalPath = (path: string): string => (path === "" ? "/" : path.split("/").map(uriEncode).join("/"));

function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

// `20150830T123600Z`, the X-Amz-Date form.
export const amzDate = (now: Date): string => now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export interface SignInput {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  now: Date;
  // Also send and sign `x-amz-content-sha256` (the post-x-www-form-urlencoded vector does).
  contentSha256Header?: boolean;
}

// The headers to send: the given ones plus host, x-amz-date, the session
// token when there is one, and the Authorization header.
export async function signV4(input: SignInput): Promise<Record<string, string>> {
  const url = new URL(input.url);
  const date = amzDate(input.now);
  const day = date.slice(0, 8);
  const payloadHash = await sha256Hex(input.body ?? "");
  const headers: Record<string, string> = { ...input.headers, host: url.host, "x-amz-date": date };
  if (input.credentials.sessionToken) headers["x-amz-security-token"] = input.credentials.sessionToken;
  if (input.contentSha256Header) headers["x-amz-content-sha256"] = payloadHash;

  const canonical = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const signedHeaders = canonical.map(([name]) => name).join(";");
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    canonical.map(([name, value]) => `${name}:${value}\n`).join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, await sha256Hex(canonicalRequest)].join("\n");

  let key: ArrayBuffer = await hmac(encoder.encode(`AWS4${input.credentials.secretAccessKey}`), day);
  for (const part of [input.region, input.service, "aws4_request"]) key = await hmac(key, part);
  const signature = hex(await hmac(key, stringToSign));

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

// The signed headers as fetch sends them: the runtime sets Host itself from
// the URL, to the same value that was signed.
export const withoutHost = (headers: Record<string, string>): Record<string, string> => {
  const { host: _host, ...rest } = headers;
  return rest;
};

// The text of the first <tag>…</tag> in an STS reply, entities decoded.
export function xmlText(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  if (!match) return undefined;
  return match[1]!
    .trim()
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export const stsEndpoint = (region: string): string => `https://sts.${region}.amazonaws.com/`;
const STS_VERSION = "2011-06-15";

async function readCredentials(response: Response, step: string): Promise<AwsCredentials> {
  const text = await response.text();
  if (!response.ok) {
    throw new ProviderRefusal({
      step,
      status: response.status,
      errorName: xmlText(text, "Code") ?? `HTTP ${response.status}`,
      message: xmlText(text, "Message") ?? "",
    });
  }
  const accessKeyId = xmlText(text, "AccessKeyId");
  const secretAccessKey = xmlText(text, "SecretAccessKey");
  const sessionToken = xmlText(text, "SessionToken");
  if (!accessKeyId || !secretAccessKey || !sessionToken) throw new Error(`${step}: AWS answered without credentials`);
  return { accessKeyId, secretAccessKey, sessionToken, expiration: xmlText(text, "Expiration") };
}

const form = (params: Record<string, string>): string => new URLSearchParams(params).toString();
const FORM = { "content-type": "application/x-www-form-urlencoded; charset=utf-8" };

// The app's own role in the owner's account, from the issuer's ID token.
export async function assumeRoleWithWebIdentity(
  fetcher: typeof fetch,
  input: { region: string; roleArn: string; sessionName: string; webIdentityToken: string },
): Promise<AwsCredentials> {
  const response = await fetcher(stsEndpoint(input.region), {
    method: "POST",
    headers: FORM,
    body: form({
      Action: "AssumeRoleWithWebIdentity",
      Version: STS_VERSION,
      RoleArn: input.roleArn,
      RoleSessionName: input.sessionName,
      WebIdentityToken: input.webIdentityToken,
      DurationSeconds: "3600",
    }),
  });
  return readCredentials(response, "AssumeRoleWithWebIdentity");
}

// The user's invoke-only role, chained from the app's role with the user's
// external ID: at most one hour.
export async function assumeRole(
  fetcher: typeof fetch,
  input: { region: string; roleArn: string; externalId: string; sessionName: string; credentials: AwsCredentials; now: Date },
): Promise<AwsCredentials> {
  const url = stsEndpoint(input.region);
  const body = form({
    Action: "AssumeRole",
    Version: STS_VERSION,
    RoleArn: input.roleArn,
    RoleSessionName: input.sessionName,
    ExternalId: input.externalId,
    DurationSeconds: "3600",
  });
  const headers = await signV4({ method: "POST", url, headers: FORM, body, region: input.region, service: "sts", credentials: input.credentials, now: input.now });
  return readCredentials(await fetcher(url, { method: "POST", headers: withoutHost(headers), body }), "AssumeRole");
}
