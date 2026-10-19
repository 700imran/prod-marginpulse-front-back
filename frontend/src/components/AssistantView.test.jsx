// Click-through of the real AssistantView against a mocked API layer:
// ask → reply, confirmation card, confirm / cancel / expiry, 402, plain-text
// rendering, and that the token never leaks into conversation history.
import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import AssistantView from "./AssistantView";
import { assistantMessage, assistantConfirm } from "../api";

jest.mock("../api", () => ({ assistantMessage: jest.fn(), assistantConfirm: jest.fn() }));

const proposal = (over = {}) => ({
  status: 200,
  body: { type: "confirm_action", action: "soft_delete_document", args: { document_id: "d" }, summary: "Move to trash: Acme Traders, invoice INV-204.", confirmation_token: "TOKEN-123", expires_at: Math.floor(Date.now() / 1000) + 300, credits_remaining: 98, ...over },
});
const text = (message, credits = 99) => ({ status: 200, body: { type: "text", message, credits_remaining: credits } });

async function ask(q) {
  fireEvent.change(screen.getByLabelText("Ask the assistant"), { target: { value: q } });
  await act(async () => { fireEvent.click(screen.getByText("Send")); });
}

beforeEach(() => { jest.clearAllMocks(); });

test("suggestion click sends the question with empty history and shows the reply and credits", async () => {
  assistantMessage.mockResolvedValue(text("About ₹4,200 of ITC is at risk."));
  render(<AssistantView />);
  await act(async () => { fireEvent.click(screen.getByText("How much ITC is at risk right now?")); });
  expect(assistantMessage).toHaveBeenCalledWith("How much ITC is at risk right now?", []);
  expect(await screen.findByText("About ₹4,200 of ITC is at risk.")).toBeTruthy();
  expect(screen.getByText("99 credits left")).toBeTruthy();
});

test("assistant text and summaries render as plain text, never HTML", async () => {
  assistantMessage.mockResolvedValueOnce(text('<img src=x onerror="window.__pwned=1"> <b>bold</b>'));
  const { container } = render(<AssistantView />);
  await ask("hi");
  expect(await screen.findByText(/<img src=x/)).toBeTruthy();
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("b")).toBeNull();
  assistantMessage.mockResolvedValueOnce(proposal({ summary: "Move to trash: <script>alert(1)</script>" }));
  await ask("delete it");
  expect(await screen.findByText(/<script>alert\(1\)<\/script>/)).toBeTruthy();
  expect(container.querySelector("script")).toBeNull();
});

test("confirm sends the token exactly once (double-click safe), shows the result, removes the card", async () => {
  assistantMessage.mockResolvedValue(proposal());
  let release;
  assistantConfirm.mockImplementation(() => new Promise((r) => { release = r; }));
  render(<AssistantView />);
  await ask("delete the acme invoice");
  expect(await screen.findByText("CONFIRMATION NEEDED")).toBeTruthy();
  expect(screen.getByText("Move to trash: Acme Traders, invoice INV-204.")).toBeTruthy();
  const btn = screen.getByText("Confirm");
  fireEvent.click(btn); fireEvent.click(btn);
  expect(assistantConfirm).toHaveBeenCalledTimes(1);
  expect(assistantConfirm).toHaveBeenCalledWith("TOKEN-123");
  expect(screen.getByText("Working…")).toBeTruthy();
  await act(async () => { release({ status: 200, body: { type: "action_result", message: "Moved to trash." } }); });
  expect(await screen.findByText("Moved to trash.")).toBeTruthy();
  expect(screen.queryByText("CONFIRMATION NEEDED")).toBeNull();
});

test("cancel never calls the confirm endpoint", async () => {
  assistantMessage.mockResolvedValue(proposal());
  render(<AssistantView />);
  await ask("delete it");
  await screen.findByText("CONFIRMATION NEEDED");
  fireEvent.click(screen.getByText("Cancel"));
  expect(assistantConfirm).not.toHaveBeenCalled();
  expect(await screen.findByText("Okay — nothing was changed.")).toBeTruthy();
  expect(screen.queryByText("CONFIRMATION NEEDED")).toBeNull();
});

test("an expired proposal can't be confirmed", async () => {
  assistantMessage.mockResolvedValue(proposal({ expires_at: Math.floor(Date.now() / 1000) - 10 }));
  render(<AssistantView />);
  await ask("delete it");
  await screen.findByText("CONFIRMATION NEEDED");
  expect(screen.getByText("Confirm").disabled).toBe(true);
  expect(screen.getByText(/expired/)).toBeTruthy();
  fireEvent.click(screen.getByText("Confirm"));
  expect(assistantConfirm).not.toHaveBeenCalled();
});

test("asking something new supersedes an unconfirmed proposal; the token never enters history", async () => {
  assistantMessage.mockResolvedValueOnce(proposal());
  render(<AssistantView />);
  await ask("delete it");
  await screen.findByText("CONFIRMATION NEEDED");
  assistantMessage.mockResolvedValueOnce(text("Two invoices are mismatched."));
  await ask("which are mismatched?");
  await screen.findByText("Two invoices are mismatched.");
  expect(screen.queryByText("CONFIRMATION NEEDED")).toBeNull();
  assistantMessage.mockResolvedValueOnce(text("ok"));
  await ask("and now?");
  const history = assistantMessage.mock.calls[2][1];
  expect(JSON.stringify(history)).not.toContain("TOKEN-123");
  expect(history.every((m) => m.role === "user" || m.role === "assistant")).toBe(true);
});

test("402 shows the out-of-credits message with a working Billing link", async () => {
  assistantMessage.mockResolvedValue({ status: 402, body: { error: { code: "INSUFFICIENT_CREDITS", message: "x" } } });
  const onNavigate = jest.fn();
  render(<AssistantView onNavigate={onNavigate} />);
  await ask("hi");
  expect(await screen.findByText(/out of usage credits/)).toBeTruthy();
  fireEvent.click(screen.getByText("Go to Billing"));
  expect(onNavigate).toHaveBeenCalledWith("billing");
});

test("a failed confirm (409) shows the reason and spends the token client-side", async () => {
  assistantMessage.mockResolvedValue(proposal());
  assistantConfirm.mockResolvedValue({ status: 409, body: { error: { code: "CONFLICT", message: "That document is already in the trash." } } });
  render(<AssistantView />);
  await ask("delete it");
  await screen.findByText("CONFIRMATION NEEDED");
  await act(async () => { fireEvent.click(screen.getByText("Confirm")); });
  expect(await screen.findByText("That document is already in the trash.")).toBeTruthy();
  expect(screen.queryByText("CONFIRMATION NEEDED")).toBeNull();
});

test("network failure is reported and input is usable again", async () => {
  assistantMessage.mockResolvedValue({ status: 0, body: null });
  render(<AssistantView />);
  await ask("hi");
  expect(await screen.findByText(/reach the server/)).toBeTruthy();
  await waitFor(() => expect(screen.getByLabelText("Ask the assistant").disabled).toBe(false));
});
