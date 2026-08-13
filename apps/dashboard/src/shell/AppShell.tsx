import { IconButton, Tooltip } from "@keel/ui";
import { NavLink, Outlet } from "react-router-dom";
import { useTheme } from "./theme.ts";

/** The sections from doc 05 §D. Screens land under these as slices ship. */
const NAV = [
  { to: "/agents", label: "Agents" },
  { to: "/tools", label: "Tools" },
  { to: "/knowledge", label: "Knowledge" },
  { to: "/activity", label: "Activity" },
  { to: "/policy", label: "Policy" },
  { to: "/settings", label: "Settings" },
] as const;

export function AppShell() {
  const { theme, toggle } = useTheme();

  return (
    <div className="d-shell">
      {/* Every page needs a way past the nav for keyboard and screen-reader users. */}
      <a className="d-skip k-focus" href="#main">
        Skip to content
      </a>

      <header className="d-header">
        <span className="d-brand">keel</span>
        <div className="d-header__spacer" />
        <Tooltip content={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}>
          <IconButton label="Toggle theme" variant="ghost" size="sm" onClick={toggle}>
            {theme === "dark" ? "☾" : "☀"}
          </IconButton>
        </Tooltip>
      </header>

      <div className="d-body">
        <nav className="d-nav" aria-label="Sections">
          <ul className="d-nav__list">
            {NAV.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  className={({ isActive }) =>
                    isActive ? "d-nav__link d-nav__link--active k-focus" : "d-nav__link k-focus"
                  }
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
          <div className="d-nav__foot">
            <NavLink to="/styleguide" className="d-nav__link k-focus">
              Styleguide
            </NavLink>
          </div>
        </nav>

        <main id="main" className="d-main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
