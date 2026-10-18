import type { PullRequestCheck, PullRequestComment } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  AI_REVIEW_IN_PROGRESS_LIMIT_MS,
  type AiReviewInput,
  resolveAiReview,
} from "./pullRequestAiReview.ts";

const NOW = Date.parse("2026-10-02T12:00:00.000Z");

const check = (name: string, status: PullRequestCheck["status"]): PullRequestCheck => ({
  name,
  status,
  description: null,
  url: null,
});

const comment = (login: string, body: string, minutesAgo = 1): PullRequestComment => ({
  id: `${login}-${minutesAgo}`,
  kind: "issue-comment",
  author: { login, name: null, avatarUrl: null, isBot: true },
  body,
  createdAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
  url: null,
  path: null,
  reviewState: null,
});

const input = (overrides: Partial<AiReviewInput> = {}): AiReviewInput => ({
  checks: [],
  requestedReviewers: [],
  comments: [],
  customReviewers: [],
  now: NOW,
  ...overrides,
});

describe("resolveAiReview", () => {
  it("is absent when no review bot has touched the pull request", () => {
    assert.strictEqual(
      resolveAiReview(
        input({ checks: [check("test", "pending")], comments: [comment("octocat", "LGTM")] }),
      ),
      undefined,
    );
  });

  it("reads a bot's check on the head commit first", () => {
    assert.deepStrictEqual(resolveAiReview(input({ checks: [check("CodeRabbit", "pending")] })), {
      state: "reviewing",
      reviewers: [{ name: "CodeRabbit", state: "reviewing" }],
    });
    // A finished check outranks an older "in progress" comment from the same bot.
    assert.deepStrictEqual(
      resolveAiReview(
        input({
          checks: [check("Greptile Review", "success")],
          comments: [comment("greptile-apps[bot]", "Review in progress")],
        }),
      ),
      { state: "reviewed", reviewers: [{ name: "Greptile", state: "reviewed" }] },
    );
  });

  it("falls back to a pending review request for bots without a check", () => {
    assert.deepStrictEqual(
      resolveAiReview(
        input({
          requestedReviewers: [
            { login: "copilot-pull-request-reviewer", name: null, avatarUrl: null },
          ],
        }),
      ),
      { state: "reviewing", reviewers: [{ name: "Copilot", state: "reviewing" }] },
    );
  });

  it("falls back to the bot's latest comment, and stops trusting a stale placeholder", () => {
    assert.strictEqual(
      resolveAiReview(
        input({ comments: [comment("coderabbitai", "Currently processing new changes")] }),
      )?.state,
      "reviewing",
    );
    assert.strictEqual(
      resolveAiReview(
        input({
          comments: [
            comment("coderabbitai", "Currently processing new changes", 5),
            comment("coderabbitai", "Walkthrough: renames the parser", 1),
          ],
        }),
      )?.state,
      "reviewed",
    );
    const staleMinutes = AI_REVIEW_IN_PROGRESS_LIMIT_MS / 60_000 + 1;
    assert.strictEqual(
      resolveAiReview(
        input({ comments: [comment("coderabbitai", "Review in progress", staleMinutes)] }),
      )?.state,
      "reviewed",
    );
  });

  it("stays reviewing until every reviewer has finished", () => {
    const review = resolveAiReview(
      input({
        checks: [check("CodeRabbit", "success"), check("Cursor Bugbot", "pending")],
        comments: [comment("gemini-code-assist[bot]", "Summary of changes")],
      }),
    );
    assert.deepStrictEqual(review, {
      state: "reviewing",
      reviewers: [
        { name: "CodeRabbit", state: "reviewed" },
        { name: "Cursor Bugbot", state: "reviewing" },
        { name: "Gemini", state: "reviewed" },
      ],
    });
  });

  it("recognizes a custom reviewer by login or check name", () => {
    assert.deepStrictEqual(
      resolveAiReview(
        input({
          customReviewers: ["acme-reviewer[bot]", "Internal Review"],
          checks: [check("Internal Review / lint", "pending")],
          comments: [comment("acme-reviewer", "Looks fine")],
        }),
      ),
      {
        state: "reviewing",
        reviewers: [
          { name: "acme-reviewer[bot]", state: "reviewed" },
          { name: "Internal Review", state: "reviewing" },
        ],
      },
    );
  });
});
