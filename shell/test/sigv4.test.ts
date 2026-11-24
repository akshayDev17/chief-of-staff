// AWS's published Signature Version 4 test suite (awslabs/aws-c-auth,
// tests/aws-signing-test-suite/v4, read 2026-11-25): access key AKIDEXAMPLE,
// its documented example secret, region us-east-1, service "service", at
// 2015-08-30T12:36:00Z. Each expected Authorization header is copied from the
// suite's header-signed-request.txt.
import { describe, expect, it } from "vitest";
import { amzDate, signV4, uriEncode, xmlText } from "../src/providers/aws";

const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const now = new Date("2015-08-30T12:36:00Z");
const base = { region: "us-east-1", service: "service", credentials, now };
const scope = "Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request";

describe("SigV4 against AWS's test suite", () => {
  it("get-vanilla", async () => {
    const h = await signV4({ ...base, method: "GET", url: "https://example.amazonaws.com/" });
    expect(h["x-amz-date"]).toBe("20150830T123600Z");
    expect(h.authorization).toBe(`AWS4-HMAC-SHA256 ${scope}, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31`);
  });

  it("get-vanilla-query-order-key-case: query parameters sorted", async () => {
    const h = await signV4({ ...base, method: "GET", url: "https://example.amazonaws.com/?Param2=value2&Param1=value1" });
    expect(h.authorization).toBe(`AWS4-HMAC-SHA256 ${scope}, SignedHeaders=host;x-amz-date, Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500`);
  });

  it("post-vanilla", async () => {
    const h = await signV4({ ...base, method: "POST", url: "https://example.amazonaws.com/" });
    expect(h.authorization).toBe(`AWS4-HMAC-SHA256 ${scope}, SignedHeaders=host;x-amz-date, Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b`);
  });

  it("post-x-www-form-urlencoded: the body hashed and signed", async () => {
    const h = await signV4({
      ...base, method: "POST", url: "https://example.amazonaws.com/", body: "Param1=value1", contentSha256Header: true,
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": "13" },
    });
    expect(h["x-amz-content-sha256"]).toBe("9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e");
    expect(h.authorization).toBe(
      `AWS4-HMAC-SHA256 ${scope}, SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b`,
    );
  });

  it("signs the session token of temporary credentials", async () => {
    const h = await signV4({ ...base, credentials: { ...credentials, sessionToken: "token-1" }, method: "GET", url: "https://example.amazonaws.com/" });
    expect(h["x-amz-security-token"]).toBe("token-1");
    expect(h.authorization).toContain("SignedHeaders=host;x-amz-date;x-amz-security-token");
  });

  it("encodes a path segment once more for the canonical request, as every service but S3 wants", async () => {
    // A model ID with a colon: sent encoded once, canonicalised encoded twice.
    const once = `/model/${encodeURIComponent("anthropic.claude-haiku-4-5-20251001-v1:0")}/converse`;
    expect(once).toBe("/model/anthropic.claude-haiku-4-5-20251001-v1%3A0/converse");
    expect(uriEncode("v1%3A0")).toBe("v1%253A0");
    const a = await signV4({ ...base, method: "POST", url: `https://example.amazonaws.com${once}` });
    const b = await signV4({ ...base, method: "POST", url: "https://example.amazonaws.com/model/other/converse" });
    expect(a.authorization).not.toBe(b.authorization);
  });

  it("formats X-Amz-Date and reads STS's XML", () => {
    expect(amzDate(new Date("2026-11-25T10:00:00.123Z"))).toBe("20261125T100000Z");
    expect(xmlText("<Error><Code>AccessDenied</Code><Message>a &amp; b &lt;c&gt;</Message></Error>", "Message")).toBe("a & b <c>");
    expect(xmlText("<x/>", "Code")).toBeUndefined();
  });
});
