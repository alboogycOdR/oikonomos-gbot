import { Link, Navigate, Route, Routes } from "react-router-dom";

import { RequireAuth } from "./components/RequireAuth";
import { AuthProvider } from "./lib/AuthContext";
import { ApprovalInboxPage } from "./pages/ApprovalInboxPage";
import { EvidenceBrowserPage } from "./pages/EvidenceBrowserPage";
import { LoginPage } from "./pages/LoginPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { RunListPage } from "./pages/RunListPage";

/**
 * TASK-104 — a minimal top nav so the evidence browser (a direct run_id
 * lookup, not reached by clicking through anything) is actually
 * discoverable, alongside the existing runs/approvals routes.
 */
function TopNav() {
  return (
    <nav aria-label="Primary">
      <Link to="/runs">Runs</Link> · <Link to="/approvals">Approvals</Link> ·{" "}
      <Link to="/evidence">Evidence browser</Link>
    </nav>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/runs"
          element={
            <RequireAuth>
              <TopNav />
              <RunListPage />
            </RequireAuth>
          }
        />
        <Route
          path="/runs/:runId"
          element={
            <RequireAuth>
              <TopNav />
              <RunDetailPage />
            </RequireAuth>
          }
        />
        <Route
          path="/approvals"
          element={
            <RequireAuth>
              <TopNav />
              <ApprovalInboxPage />
            </RequireAuth>
          }
        />
        <Route
          path="/evidence"
          element={
            <RequireAuth>
              <TopNav />
              <EvidenceBrowserPage />
            </RequireAuth>
          }
        />
        <Route
          path="/evidence/:runId"
          element={
            <RequireAuth>
              <TopNav />
              <EvidenceBrowserPage />
            </RequireAuth>
          }
        />
        <Route path="/" element={<Navigate to="/runs" replace />} />
        <Route path="*" element={<Navigate to="/runs" replace />} />
      </Routes>
    </AuthProvider>
  );
}
