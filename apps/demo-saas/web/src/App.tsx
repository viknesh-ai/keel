import { ToastProvider, TooltipProvider } from "@keel/ui";
import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, NavLink, Route, Routes } from "react-router-dom";
import { api, type Staff } from "./api.ts";
import { KeelWidget } from "./KeelWidget.tsx";
import AnalyticsPage from "./pages/Analytics.tsx";
import CustomerDetailPage from "./pages/CustomerDetail.tsx";
import CustomersPage from "./pages/Customers.tsx";
import InvoicesPage from "./pages/Invoices.tsx";
import LoginPage from "./pages/Login.tsx";
import SettingsPage from "./pages/Settings.tsx";

const NAV = [
  { to: "/customers", label: "Customers" },
  { to: "/invoices", label: "Invoices" },
  { to: "/analytics", label: "Analytics" },
  { to: "/settings", label: "Settings" },
] as const;

export function App() {
  const [staff, setStaff] = useState<Staff | null>(null);
  const [checked, setChecked] = useState(false);

  // Ask the server who we are rather than trusting anything in localStorage.
  // The session cookie is httpOnly, so this is the only way to know.
  useEffect(() => {
    api
      .me()
      .then(setStaff)
      .catch(() => setStaff(null))
      .finally(() => setChecked(true));
  }, []);

  if (!checked) return null;
  if (staff === null) return <LoginPage onSignedIn={setStaff} />;

  return (
    <TooltipProvider>
      <ToastProvider>
        <BrowserRouter>
          <div className="nw-shell">
            <a className="nw-skip k-focus" href="#main">
              Skip to content
            </a>
            <header className="nw-header">
              <span className="nw-brand">Northwind Cloud</span>
              <nav className="nw-nav" aria-label="Sections">
                {NAV.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      isActive
                        ? "nw-nav__link nw-nav__link--active k-focus"
                        : "nw-nav__link k-focus"
                    }
                  >
                    {item.label}
                  </NavLink>
                ))}
              </nav>
              <span className="nw-who k-mono">{staff.email}</span>
            </header>

            <main id="main" className="nw-main" tabIndex={-1}>
              <Routes>
                <Route path="/" element={<Navigate to="/customers" replace />} />
                <Route path="/customers" element={<CustomersPage />} />
                <Route path="/customers/:customerId" element={<CustomerDetailPage />} />
                <Route path="/invoices" element={<InvoicesPage />} />
                <Route path="/analytics" element={<AnalyticsPage />} />
                <Route
                  path="/settings"
                  element={
                    <SettingsPage
                      staff={staff}
                      onLogout={() => {
                        void api.logout().finally(() => setStaff(null));
                      }}
                    />
                  }
                />
              </Routes>
            </main>
            <KeelWidget />
          </div>
        </BrowserRouter>
      </ToastProvider>
    </TooltipProvider>
  );
}
