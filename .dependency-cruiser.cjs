/**
 * Enforces the dependency direction from CLAUDE.md.
 * packages/* are pure and must never import from services/*, apps/*.
 * packages/contracts must import nothing from the workspace at all.
 */
module.exports = {
  forbidden: [
    {
      name: "packages-must-not-import-services-or-apps",
      severity: "error",
      comment:
        "packages/* are pure (ports only). Importing a service or app inverts the dependency direction and makes the runtime untestable without infrastructure.",
      from: { path: "^packages/" },
      to: { path: "^(services|apps)/" },
    },
    {
      name: "contracts-imports-nothing-internal",
      severity: "error",
      comment:
        "packages/contracts is imported by everything and must import nothing from the workspace.",
      from: { path: "^packages/contracts/" },
      to: { path: "^(packages/(?!contracts)|services/|apps/)" },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(dist|node_modules|\\.turbo)" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require"] },
  },
};
