// @keel/knowledge-engine
// Ingestion pipeline and retrieval planner.

export {
  checkAddress,
  checkIpv4,
  checkIpv6,
  type IpVerdict,
  parseIpv4,
  parseIpv6,
} from "./fetch/ip-rules.js";
export {
  judgeAddresses,
  type Resolver,
  type SafeFetchDenial,
  type SafeFetchOptions,
  type SafeFetchResult,
  safeFetch,
} from "./fetch/safe-fetch.js";
