// TASK-107 (Chat-1c): preview harness entry — mounts <ChatShell> against
// the same static fixtures used by the component tests, purely so a
// screenshot can be taken of rendered output for the dossier (spec §2
// "graded on rendered output, not just tests passing"). Not part of the
// shipped app.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ChatShell } from "../ChatShell";
import {
  fixtureBots,
  fixtureMembers,
  fixtureMessages,
  fixtureRoutines,
} from "../fixtures";

const messagesByBotId = fixtureMessages.reduce<Record<string, typeof fixtureMessages>>(
  (acc, message) => {
    (acc[message.threadId] ??= []).push(message);
    return acc;
  },
  {},
);

const container = document.getElementById("root");
if (container === null) {
  throw new Error("#root element not found");
}

createRoot(container).render(
  <StrictMode>
    <ChatShell
      bots={fixtureBots}
      messagesByBotId={messagesByBotId}
      members={fixtureMembers}
      routines={fixtureRoutines}
      activeBotId="bot-research"
      isBotResponding={false}
      draft=""
      onDraftChange={() => {}}
    />
  </StrictMode>,
);
