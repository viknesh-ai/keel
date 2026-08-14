import { ToastProvider, TooltipProvider } from "@keel/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { AppShell } from "./shell/AppShell.tsx";
import { ErrorBoundary } from "./shell/ErrorBoundary.tsx";
import { RouteFallback } from "./shell/RouteFallback.tsx";

// Route-level code splitting: each section is its own chunk, so opening the
// dashboard does not download the styleguide or every feature screen.
const Agents = lazy(() => import("./routes/Agents.tsx"));
const Tools = lazy(() => import("./routes/Tools.tsx"));
const Knowledge = lazy(() => import("./routes/Knowledge.tsx"));
const Activity = lazy(() => import("./routes/Activity.tsx"));
const Policy = lazy(() => import("./routes/Policy.tsx"));
const Settings = lazy(() => import("./routes/Settings.tsx"));
const Styleguide = lazy(() => import("./routes/Styleguide.tsx"));
const RunDetail = lazy(() => import("./routes/RunDetail.tsx"));
const NotFound = lazy(() => import("./routes/NotFound.tsx"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // An operator watching a run wants fresh data; an operator reading a
      // six-week-old trace does not need a refetch on every window focus.
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const page = (element: React.ReactNode) => (
  <Suspense fallback={<RouteFallback />}>{element}</Suspense>
);

const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/agents" replace /> },
      { path: "agents", element: page(<Agents />) },
      { path: "tools", element: page(<Tools />) },
      { path: "knowledge", element: page(<Knowledge />) },
      { path: "activity", element: page(<Activity />) },
      { path: "policy", element: page(<Policy />) },
      { path: "settings", element: page(<Settings />) },
      { path: "activity/runs/:runId", element: page(<RunDetail />) },
      { path: "styleguide", element: page(<Styleguide />) },
      { path: "*", element: page(<NotFound />) },
    ],
  },
]);

export function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
