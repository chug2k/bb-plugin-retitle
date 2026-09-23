import { describe, expect, it } from "vitest";
import { MAX_TITLE_CHARS, buildPrompt, buildTranscript, cleanTitle } from "./title";

const user = (preview: string) => ({ role: "user" as const, preview });
const assistant = (preview: string) => ({ role: "assistant" as const, preview });

describe("buildTranscript", () => {
  it("labels each message with its role", () => {
    expect(buildTranscript([user("Fix the login test"), assistant("It passes now")])).toBe(
      "User: Fix the login test\n\nAssistant: It passes now",
    );
  });

  it("joins whitespace and drops empty messages", () => {
    expect(buildTranscript([user("  Fix\n\nthe   test "), assistant("   ")])).toBe(
      "User: Fix the test",
    );
  });

  it("returns an empty string when there are no messages", () => {
    expect(buildTranscript([])).toBe("");
  });

  it("keeps the first message and the newest messages when the text is too long", () => {
    const items = [user("first"), user("aaaa"), user("bbbb"), user("cccc")];
    // "User: first" is 11 characters and each other line is 10.
    const transcript = buildTranscript(items, 31);

    expect(transcript).toBe(
      "User: first\n\n[… 1 earlier messages omitted …]\n\nUser: bbbb\n\nUser: cccc",
    );
  });
});

describe("buildPrompt", () => {
  it("asks for an emoji, and shows emoji examples, when the setting is on", () => {
    const prompt = buildPrompt({ transcript: "User: hi", currentTitle: null, emoji: true });
    expect(prompt).toContain("- Start with one emoji");
    expect(prompt).toContain("\n🐛 Fix flaky login test\n");
    expect(prompt).not.toContain("- No emoji.");
  });

  it("forbids emoji, and shows plain examples, when the setting is off", () => {
    const prompt = buildPrompt({ transcript: "User: hi", currentTitle: null, emoji: false });
    expect(prompt).toContain("- No emoji.");
    expect(prompt).toContain("\nFix flaky login test\n");
    expect(prompt).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("ends with the answer format", () => {
    const prompt = buildPrompt({ transcript: "User: hi", currentTitle: null, emoji: true });
    expect(prompt.endsWith("Your whole reply is the title, on one line, with nothing before or after it.")).toBe(true);
  });

  it("names the current title only when there is one", () => {
    expect(
      buildPrompt({ transcript: "User: hi", currentTitle: "Old title", emoji: false }),
    ).toContain('- The current title is "Old title".');
    expect(
      buildPrompt({ transcript: "User: hi", currentTitle: null, emoji: false }),
    ).not.toContain("The current title is");
  });

  it("puts the conversation first and the task after it", () => {
    const prompt = buildPrompt({ transcript: "User: hi", currentTitle: null, emoji: false });
    const conversation = prompt.indexOf("<conversation>\nUser: hi\n</conversation>");
    const task = prompt.indexOf("Your task: write a title for the conversation above.");

    expect(conversation).toBeGreaterThan(-1);
    expect(task).toBeGreaterThan(conversation);
  });
});

describe("cleanTitle", () => {
  it.each([
    ["Fix flaky login test", "Fix flaky login test"],
    ['"Fix flaky login test."', "Fix flaky login test"],
    ["Title: Fix flaky login test", "Fix flaky login test"],
    ["**Fix flaky login test**", "Fix flaky login test"],
    ["# Fix flaky login test", "Fix flaky login test"],
    ["“Fix flaky login test”", "Fix flaky login test"],
    ["\n\n  Fix flaky login test  \nSecond line", "Fix flaky login test"],
    ["🐛 Fix flaky login test", "🐛 Fix flaky login test"],
  ])("cleans %j", (raw, expected) => {
    expect(cleanTitle(raw)).toBe(expected);
  });

  it("returns null for an empty answer", () => {
    expect(cleanTitle("")).toBeNull();
    expect(cleanTitle("  \n \n")).toBeNull();
    expect(cleanTitle('""')).toBeNull();
  });

  it("cuts a long answer to the maximum length", () => {
    const title = cleanTitle("x".repeat(200));
    expect(title).toHaveLength(MAX_TITLE_CHARS);
    expect(title?.endsWith("…")).toBe(true);
  });
});

