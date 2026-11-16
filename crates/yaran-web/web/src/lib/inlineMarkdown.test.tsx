// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { InlineCode } from "@yaran/ui-kit/inline-code"

import { renderInlineCode } from "@/lib/inlineMarkdown"

afterEach(cleanup)

describe("renderInlineCode", () => {
  it("returns a plain string as-is when there are no backticks", () => {
    const nodes = renderInlineCode("just a plain sentence")
    expect(nodes).toEqual(["just a plain sentence"])
  })

  it("renders a single well-formed span mid-sentence as a code element", () => {
    const { container } = render(<>{renderInlineCode("Requires `gh` to be installed.")}</>)
    const code = container.querySelector("code")
    expect(code).not.toBeNull()
    expect(code?.textContent).toBe("gh")
    expect(container.textContent).toBe("Requires gh to be installed.")
  })

  it("renders multiple spans in one string", () => {
    const { container } = render(
      <>{renderInlineCode("Run `foo` then `bar` to finish.")}</>,
    )
    const codes = container.querySelectorAll("code")
    expect(codes).toHaveLength(2)
    expect(codes[0].textContent).toBe("foo")
    expect(codes[1].textContent).toBe("bar")
    expect(container.textContent).toBe("Run foo then bar to finish.")
  })

  it("renders a dangling trailing backtick literally instead of swallowing it", () => {
    const { container } = render(
      <>{renderInlineCode("Odd count here ` trailing text")}</>,
    )
    expect(container.querySelectorAll("code")).toHaveLength(0)
    expect(container.textContent).toBe("Odd count here ` trailing text")
  })

  it("handles an empty span gracefully without crashing", () => {
    const { container } = render(<>{renderInlineCode("Before `` after")}</>)
    expect(() => container.textContent).not.toThrow()
    const codes = container.querySelectorAll("code")
    expect(codes).toHaveLength(1)
    expect(codes[0].textContent).toBe("")
    expect(container.textContent).toBe("Before  after")
  })

  it("produces unique keys across renders (no duplicate-key warning)", () => {
    // Rendering directly exercises React's duplicate-key detection; if keys
    // collided this would trigger a console warning during render.
    expect(() =>
      render(<>{renderInlineCode("`a` `b` `c` `d`")}</>),
    ).not.toThrow()
  })

  // Moved from the kit's inline-code test, which cannot import app code: the
  // backtick renderer must draw the very chip the kit exports.
  it("draws the same chip as the kit's InlineCode", () => {
    const { container } = render(<>{renderInlineCode("Run `gh` first.")}</>)
    render(<InlineCode>gh-direct</InlineCode>)
    const fromMarkdown = container.querySelector("code")
    expect(fromMarkdown?.className).toBe(screen.getByText("gh-direct").className)
  })
})
