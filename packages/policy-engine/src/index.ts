// @keel/policy-engine
// Deterministic authorization decisions. Pure functions over data, no I/O.

export {
  type Comparison,
  EFFECTS,
  INTEGRITY_LEVELS,
  type PolicyDocument,
  type PolicyParseIssue,
  type PolicyParseResult,
  parsePolicyDocument,
  policyDocumentSchema,
  RISK_LEVELS,
  type Rule,
  ruleSchema,
  SIDE_EFFECTS,
} from "./document.js";
export {
  BUILTIN_RULES,
  type Decision,
  type EvaluationInput,
  type Explanation,
  evaluate,
  explain,
  filterCatalogue,
  type RuleTrace,
  type ToolFacts,
} from "./evaluate.js";
export { interpolate, matches, matchesAll, type Principal, readPath } from "./match.js";
