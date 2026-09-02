import { Navigate, Route, Routes } from "react-router-dom";

import { RequireAuth } from "./components/RequireAuth";
import { AuthProvider } from "./lib/AuthContext";
import { LoginPage } from "./pages/LoginPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { RunListPage } from "./pages/RunListPage";

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/runs"
          element={
            <RequireAuth>
              <RunListPage />
            </RequireAuth>
          }
        />
        <Route
          path="/runs/:runId"
          element={
            <RequireAuth>
              <RunDetailPage />
            </RequireAuth>
          }
        />
        <Route path="/" element={<Navigate to="/runs" replace />} />
        <Route path="*" element={<Navigate to="/runs" replace />} />
      </Routes>
    </AuthProvider>
  );
}
