// @keel/knowledge-engine
// Ingestion pipeline and retrieval planner.

export {
  type CrawlError,
  type CrawledPage,
  type CrawlOptions,
  type CrawlResult,
  crawl,
  extractLinks,
  extractSitemapUrls,
  normalise,
} from "./fetch/crawler.js";
export {
  checkAddress,
  checkIpv4,
  checkIpv6,
  type IpVerdict,
  parseIpv4,
  parseIpv6,
} from "./fetch/ip-rules.js";
export {
  isAllowed,
  PERMISSIVE,
  parseRobots,
  type RobotsRules,
} from "./fetch/robots.js";
export {
  judgeAddresses,
  type Resolver,
  type SafeFetchDenial,
  type SafeFetchOptions,
  type SafeFetchResult,
  safeFetch,
} from "./fetch/safe-fetch.js";
export {
  docxToMarkdown,
  type ParseResult,
  parseCsv,
  parseDocument,
  parseDocx,
  parseHtml,
  parseJson,
  parseMarkdown,
  parsePdf,
  parseText,
} from "./parse/parsers.js";
export {
  type Chunk,
  type ChunkOptions,
  chunkMarkdown,
  countTokens,
  toBlocks,
} from "./pipeline/chunk.js";
export {
  checkArchive,
  checkPdf,
  checkSize,
  checkType,
  checkXml,
  type DocumentCheck,
  type DocumentDenial,
  LIMITS,
  SUPPORTED_TYPES,
  type SupportedType,
  withParseTimeout,
} from "./pipeline/guards.js";
export {
  chunkStage,
  clean,
  cleanStage,
  type EmbeddedChunk,
  type Embedder,
  embedStage,
  isFresh,
  parseStage,
  reindexCost,
  type StageName,
  type StageOutput,
  shaOf,
} from "./pipeline/stages.js";
