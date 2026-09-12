import { Link, Navigate, Route, Routes, useParams } from "react-router-dom";

import { RequireAuth } from "./components/RequireAuth";
import { AuthProvider } from "./lib/AuthContext";
import { ApprovalInboxPage } from "./pages/ApprovalInboxPage";
import { ChatPage } from "./pages/ChatPage";
import { EvidenceBrowserPage } from "./pages/EvidenceBrowserPage";
import { LoginPage } from "./pages/LoginPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { RunListPage } from "./pages/RunListPage";

/**
 * TASK-104 — a minimal top nav so the evidence browser (a direct run_id
 * lookup, not reached by clicking through anything) is actually
 * discoverable, alongside the existing runs/approvals routes.
 *
 * TASK-108 (Chat-1d): links moved to `/ops/*` (spec §5 — "existing /runs,
 * /approvals, /evidence routes move under /ops/* ... reachable but out
 * of primary navigation"). `/` is now the chat surface and does not carry
 * this ops-only nav.
 */
function TopNav() {
  return (
    <nav aria-label="Primary">
      <Link to="/ops/runs">Runs</Link> · <Link to="/ops/approvals">Approvals</Link> ·{" "}
      <Link to="/ops/evidence">Evidence browser</Link>
    </nav>
  );
}

/**
 * TASK-108: bare pre-Chat-1 paths (`/runs`, `/runs/:runId`, `/approvals`,
 * `/evidence`, `/evidence/:runId`) now redirect to their `/ops/*`
 * equivalent rather than rendering directly — "moved", per spec §5, not
 * duplicated. Redirecting (rather than deleting the route) keeps any
 * bookmarked/pre-existing link working and keeps this file's own
 * `App.test.tsx` (outside this task's Owned_Paths — not touched here)
 * green unchanged: it still resolves to the same final screen through one
 * extra client-side hop.
 */
function RedirectToOps({ suffix }: { suffix: "runs" | "approvals" | "evidence" }) {
  return <Navigate to={`/ops/${suffix}`} replace />;
}

function RedirectRunDetail() {
  const { runId } = useParams();
  return <Navigate to={`/ops/runs/${runId ?? ""}`} replace />;
}

function RedirectEvidenceDetail() {
  const { runId } = useParams();
  return <Navigate to={`/ops/evidence/${runId ?? ""}`} replace />;
}

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <ChatPage />
            </RequireAuth>
          }
        />
        {/* TASK-236 (spec §2.6): `/workspace/:threadId` selects a specific
            thread; `ChatPage` itself redirects `/` to the most recent
            thread (or renders the empty state) and renders a not-found
            state for an id that doesn't resolve to an owned thread. */}
        <Route
          path="/workspace/:threadId"
          element={
            <RequireAuth>
              <ChatPage />
            </RequireAuth>
          }
        />
        <Route
          path="/ops/runs"
          element={
            <RequireAuth>
              <TopNav />
              <RunListPage />
            </RequireAuth>
          }
        />
        <Route
          path="/ops/runs/:runId"
          element={
            <RequireAuth>
              <TopNav />
              <RunDetailPage />
            </RequireAuth>
          }
        />
        <Route
          path="/ops/approvals"
          element={
            <RequireAuth>
              <TopNav />
              <ApprovalInboxPage />
            </RequireAuth>
          }
        />
        <Route
          path="/ops/evidence"
          element={
            <RequireAuth>
              <TopNav />
              <EvidenceBrowserPage />
            </RequireAuth>
          }
        />
        <Route
          path="/ops/evidence/:runId"
          element={
            <RequireAuth>
              <TopNav />
              <EvidenceBrowserPage />
            </RequireAuth>
          }
        />
        <Route path="/runs" element={<RedirectToOps suffix="runs" />} />
        <Route path="/runs/:runId" element={<RedirectRunDetail />} />
        <Route path="/approvals" element={<RedirectToOps suffix="approvals" />} />
        <Route path="/evidence" element={<RedirectToOps suffix="evidence" />} />
        <Route path="/evidence/:runId" element={<RedirectEvidenceDetail />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
