/**
 * Wire types for the Tavily search API (`POST https://api.tavily.com/search`).
 * Types only — no runtime code.
 * @module @deepseek-ai/dsh-web-search-tavily/types
 */

/** Retrieval depth Tavily accepts on `search_depth`. */
export type TavilySearchDepth = 'basic' | 'advanced'

/** Request body sent to Tavily's search endpoint. */
export interface TavilySearchRequest {
  query: string
  max_results?: number
  search_depth: TavilySearchDepth
  include_answer: false
}

/** One entry of Tavily's `results[]`. */
export interface TavilyResult {
  url?: string | null
  title?: string | null
  content?: string | null
  published_date?: string | null
}

/** Tavily's search response envelope. */
export interface TavilySearchResponse {
  results?: TavilyResult[]
}

/** Tavily's error response envelope (best-effort; fields vary by failure). */
export interface TavilyError {
  error?: string
  message?: string
  detail?: { error?: string } | string
}
