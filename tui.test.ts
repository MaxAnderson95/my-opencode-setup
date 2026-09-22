import { describe, expect, test } from "bun:test"
import { formNode } from "./tui"

const node = (name: string, visible: boolean) => ({ name, visible })

describe("formNode", () => {
  test("picks the last visible child, skipping the closed composer and placeholders", () => {
    const anchor = node("anchor", false)
    const form = node("form", true)
    const children = [node("dock", false), anchor, node("composer", false), form, node("placeholder", false)]
    expect(formNode(children, anchor)).toBe(form)
  })

  test("returns nothing when the anchor is the last visible child", () => {
    const anchor = node("anchor", true)
    expect(formNode([node("composer", false), anchor, node("placeholder", false)], anchor)).toBeUndefined()
  })
})
