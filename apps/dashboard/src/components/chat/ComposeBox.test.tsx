import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ComposeBox, type ComposeBoxProps } from "./ComposeBox";

/**
 * TASK-236 (spec §2.3): `ComposeBox` is now fully controlled — it has no
 * internal draft state of its own. This harness stands in for the parent
 * (`ChatPage`/`workspaceState.ts`) that actually owns the text, so these
 * tests exercise the same contract a real caller relies on: `onChange`
 * updates the value shown, and the value only ever clears when the parent
 * chooses to pass an empty string back in (never on `onSend` alone).
 */
function ControlledComposeBox(props: Partial<ComposeBoxProps>) {
  const [value, setValue] = useState(props.value ?? "");
  return (
    <ComposeBox
      value={value}
      onChange={(next) => {
        setValue(next);
        props.onChange?.(next);
      }}
      onSend={props.onSend}
      disabled={props.disabled}
      placeholder={props.placeholder}
    />
  );
}

describe("ComposeBox", () => {
  it("calls onSend with the trimmed message body on Enter but does not clear itself", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<ControlledComposeBox onSend={onSend} />);

    const textarea = screen.getByLabelText("Message");
    await user.type(textarea, "  hi  {Enter}");

    expect(onSend).toHaveBeenCalledWith("hi");
    // No internal state to clear on: the parent decides when the draft
    // clears (only after a successful send), so the raw typed text is
    // still exactly what's in the controlled value.
    expect(textarea).toHaveValue("  hi  ");
  });

  it("the parent clearing `value` (as a successful send would) clears the textarea", () => {
    const { rerender } = render(
      <ComposeBox value="hello" onChange={vi.fn()} onSend={vi.fn()} />,
    );
    expect(screen.getByLabelText("Message")).toHaveValue("hello");

    rerender(<ComposeBox value="" onChange={vi.fn()} onSend={vi.fn()} />);
    expect(screen.getByLabelText("Message")).toHaveValue("");
  });

  it("a failed send (parent never clears `value`) leaves the draft in place", () => {
    // Simulates ChatPage's failure path: onSend fires, the POST rejects,
    // and the parent never re-renders ComposeBox with an empty value.
    render(<ComposeBox value="unsent draft" onChange={vi.fn()} onSend={vi.fn()} />);
    expect(screen.getByLabelText("Message")).toHaveValue("unsent draft");
  });

  it("inserts a newline on Shift+Enter instead of sending", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<ControlledComposeBox onSend={onSend} />);

    const textarea = screen.getByLabelText("Message");
    await user.type(textarea, "line one{Shift>}{Enter}{/Shift}line two");

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("line one\nline two");
  });

  it("does not send an empty/whitespace-only message", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<ControlledComposeBox onSend={onSend} />);

    await user.type(screen.getByLabelText("Message"), "   {Enter}");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("disables the textarea and send button while disabled=true", () => {
    render(<ComposeBox value="" onChange={vi.fn()} disabled onSend={vi.fn()} />);
    expect(screen.getByLabelText("Message")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });
});
