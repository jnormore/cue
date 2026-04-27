import { describe, expect, it } from "vitest";
import { detectHttpResponse } from "../../../src/server/routes/webhooks.js";

describe("detectHttpResponse", () => {
  it("recognizes the Express-shaped {status, body, headers}", () => {
    expect(
      detectHttpResponse({
        status: 200,
        headers: { "content-type": "application/json" },
        body: { ok: true },
      }),
    ).toEqual({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { ok: true },
    });
  });

  it("recognizes the Lambda-shaped {statusCode, body}", () => {
    expect(detectHttpResponse({ statusCode: 201, body: { id: "x" } })).toEqual(
      { status: 201, body: { id: "x" }, headers: undefined },
    );
  });

  it("prefers status over statusCode if both are present", () => {
    expect(
      detectHttpResponse({ status: 200, statusCode: 500, body: null }),
    ).toMatchObject({ status: 200 });
  });

  it("returns null for non-object output", () => {
    expect(detectHttpResponse(null)).toBeNull();
    expect(detectHttpResponse(undefined)).toBeNull();
    expect(detectHttpResponse("hello")).toBeNull();
    expect(detectHttpResponse(42)).toBeNull();
    expect(detectHttpResponse([1, 2, 3])).toBeNull();
  });

  it("returns null when status is missing", () => {
    expect(detectHttpResponse({ body: "hi" })).toBeNull();
  });

  it("returns null when status is non-numeric", () => {
    expect(detectHttpResponse({ status: "200", body: "hi" })).toBeNull();
  });

  it("returns null when status is out of HTTP range", () => {
    expect(detectHttpResponse({ status: 99, body: null })).toBeNull();
    expect(detectHttpResponse({ status: 600, body: null })).toBeNull();
  });

  it("returns null when status is a non-integer number", () => {
    expect(detectHttpResponse({ status: 200.5, body: null })).toBeNull();
  });

  it("returns null when body key is absent", () => {
    // The body key MUST be present (even if its value is null) — it's
    // the deliberate signal that this is meant as an HTTP response. An
    // action returning `{status: 1}` for non-HTTP reasons shouldn't be
    // mistaken for an HTTP response.
    expect(detectHttpResponse({ status: 200 })).toBeNull();
  });

  it("treats body: null as a valid declaration of an HTTP response", () => {
    expect(detectHttpResponse({ status: 204, body: null })).toMatchObject({
      status: 204,
      body: null,
    });
  });

  it("returns null when headers is malformed (array, primitive, etc.)", () => {
    expect(
      detectHttpResponse({ status: 200, body: null, headers: [1, 2] }),
    ).toBeNull();
    expect(
      detectHttpResponse({ status: 200, body: null, headers: "x" }),
    ).toBeNull();
  });

  it("strips non-primitive header values rather than failing", () => {
    const result = detectHttpResponse({
      status: 200,
      body: null,
      headers: {
        "content-type": "text/plain",
        "x-num": 42,
        "x-bool": true,
        "x-bad-array": [1, 2],
        "x-bad-obj": { nested: "no" },
      },
    });
    expect(result?.headers).toEqual({
      "content-type": "text/plain",
      "x-num": 42,
      "x-bool": true,
    });
  });
});
