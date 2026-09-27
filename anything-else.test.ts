import { expect, test } from "bun:test"
import { anythingElse, withAnythingElse } from "./anything-else"

const question = { header: "Scope", question: "Which scope?", options: [{ label: "A", description: "a" }] }

test("appends the Anything else question after the model's questions", () => {
  expect(withAnythingElse({ questions: [question] })).toEqual({ questions: [question, anythingElse] })
})

test("does not append twice", () => {
  const input = { questions: [question, anythingElse] }
  expect(withAnythingElse(input)).toBe(input)
})

test("leaves malformed input for the tool's own validation", () => {
  expect(withAnythingElse("nope")).toBe("nope")
  expect(withAnythingElse({ questions: "nope" })).toEqual({ questions: "nope" })
})
