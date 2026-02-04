import { describe, expect, it } from "vitest";
import { splitShellArgs } from "./shell-argv.js";

describe("splitShellArgs", () => {
  it("splits simple space-separated arguments", () => {
    expect(splitShellArgs("foo bar baz")).toEqual(["foo", "bar", "baz"]);
  });

  it("handles multiple spaces between arguments", () => {
    expect(splitShellArgs("foo   bar    baz")).toEqual(["foo", "bar", "baz"]);
  });

  it("handles leading and trailing spaces", () => {
    expect(splitShellArgs("  foo bar  ")).toEqual(["foo", "bar"]);
  });

  it("handles single-quoted strings", () => {
    expect(splitShellArgs("foo 'bar baz' qux")).toEqual(["foo", "bar baz", "qux"]);
  });

  it("handles double-quoted strings", () => {
    expect(splitShellArgs('foo "bar baz" qux')).toEqual(["foo", "bar baz", "qux"]);
  });

  it("handles escaped spaces outside quotes", () => {
    expect(splitShellArgs("foo bar\\ baz qux")).toEqual(["foo", "bar baz", "qux"]);
  });

  it("handles escaped characters", () => {
    expect(splitShellArgs("foo \\n bar")).toEqual(["foo", "n", "bar"]);
  });

  it("handles mixed quote styles", () => {
    expect(splitShellArgs(`foo 'single' "double" plain`)).toEqual([
      "foo",
      "single",
      "double",
      "plain",
    ]);
  });

  it("handles adjacent quoted and unquoted parts", () => {
    expect(splitShellArgs('pre"quoted"post')).toEqual(["prequotedpost"]);
  });

  it("handles empty string", () => {
    expect(splitShellArgs("")).toEqual([]);
  });

  it("handles whitespace-only string", () => {
    expect(splitShellArgs("   ")).toEqual([]);
  });

  it("handles single argument", () => {
    expect(splitShellArgs("foo")).toEqual(["foo"]);
  });

  it("handles empty quoted strings (empty strings are not preserved)", () => {
    // Empty quoted strings don't produce tokens (standard shell behavior)
    expect(splitShellArgs("foo '' bar")).toEqual(["foo", "bar"]);
    expect(splitShellArgs('foo "" bar')).toEqual(["foo", "bar"]);
  });

  it("returns null for unterminated single quote", () => {
    expect(splitShellArgs("foo 'bar")).toBeNull();
  });

  it("returns null for unterminated double quote", () => {
    expect(splitShellArgs('foo "bar')).toBeNull();
  });

  it("returns null for trailing escape", () => {
    expect(splitShellArgs("foo bar\\")).toBeNull();
  });

  it("handles quotes inside quotes (different type)", () => {
    expect(splitShellArgs(`foo "it's working" bar`)).toEqual(["foo", "it's working", "bar"]);
    expect(splitShellArgs(`foo 'he said "hello"' bar`)).toEqual(["foo", 'he said "hello"', "bar"]);
  });

  it("handles command with flags", () => {
    expect(splitShellArgs("qmd --verbose --output /path/to/file")).toEqual([
      "qmd",
      "--verbose",
      "--output",
      "/path/to/file",
    ]);
  });

  it("handles paths with spaces in quotes", () => {
    expect(splitShellArgs('cmd "/path/with spaces/file.txt"')).toEqual([
      "cmd",
      "/path/with spaces/file.txt",
    ]);
  });

  it("handles unicode characters", () => {
    expect(splitShellArgs("echo 'héllo wörld' 日本語")).toEqual(["echo", "héllo wörld", "日本語"]);
  });

  it("handles tabs as whitespace", () => {
    expect(splitShellArgs("foo\tbar\tbaz")).toEqual(["foo", "bar", "baz"]);
  });

  it("handles newlines as whitespace", () => {
    expect(splitShellArgs("foo\nbar")).toEqual(["foo", "bar"]);
  });
});
