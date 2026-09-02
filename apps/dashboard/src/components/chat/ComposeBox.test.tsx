import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ComposeBox } from "./ComposeBox";

describe("ComposeBox", () => {
  it("sends the trimmed message body and clears the textarea on Enter", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<ComposeBox onSend={onSend} />);

    const textarea = screen.getByLabelText("Message");
    await user.type(textarea, "  hi  {Enter}");

    expect(onSend).toHaveBeenCalledWith("hi");
    expect(textarea).toHaveValue("");
  });

  it("inserts a newline on Shift+Enter instead of sending", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<ComposeBox onSend={onSend} />);

    const textarea = screen.getByLabelText("Message");
    await user.type(textarea, "line one{Shift>}{Enter}{/Shift}line two");

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("line one\nline two");
  });

  it("does not send an empty/whitespace-only message", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<ComposeBox onSend={onSend} />);

    await user.type(screen.getByLabelText("Message"), "   {Enter}");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("disables the textarea and send button while disabled=true", () => {
    render(<ComposeBox disabled onSend={vi.fn()} />);
    expect(screen.getByLabelText("Message")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });
});
