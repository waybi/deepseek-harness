/**
 * Deferred tool exposure: the `tool_search` transport and its durable reveal log.
 *
 * A registry may hold many tools the model rarely needs. Declaring every
 * schema on every request costs input tokens and, when the set changes, the
 * provider prompt-cache prefix. A tool whose exposure is `deferred` is left
 * out of the declared list; the model sees it only as one catalog line inside
 * the reserved `tool_search` tool's description. Searching reveals matching
 * tools for the rest of the session: the reveal is a log-only session event,
 * so it survives compaction and process restarts, and the revealed schema is
 * appended at the tail of the declaration list, so the already-cached prefix
 * keeps matching.
 *
 * @module @deepseek-ai/dsh-tools/tool-search
 */

import { z } from 'zod'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition, SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { ToolDefinition } from './index.ts'
import { defineTool } from './schema.ts'

/** Reserved name of the deferred-tool discovery transport. */
export const TOOL_SEARCH_NAME = 'tool_search'

/** Model-visible exposure of one registered tool. */
export type ToolExposure = 'direct' | 'deferred'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Deferred tools the model revealed through `tool_search`. Log-only, no
     * surfaceOp: the revealed set is folded from every such event in the log,
     * so compaction never drops a reveal and a restarted process restores it.
     */
    'tools/reveal': { names: string[] }
  }
}

/** Maximum revealed tools returned by one search. */
const MAX_HITS = 5
/** Characters of a tool description kept for one catalog line. */
const CATALOG_SUMMARY_CHARS = 120

/** MCP tool names are `mcp__<server>__<tool>`; one server's tools reveal together. */
const MCP_SERVER = /^(mcp__[^_]+(?:_[^_]+)*__)/u

/**
 * Compile deferred-name patterns into a reveal-group lookup. A trailing `*`
 * matches any suffix; anything else matches the exact name; a leading `!`
 * excludes matching names even when another pattern matches. A deferred
 * tool's group is its most specific (longest) matching pattern, except that
 * MCP tools group per server, so one search reveals every sibling at once.
 * @param patterns - configured patterns.
 * @returns the group key of a deferred name, or undefined when the name is not deferred.
 */
export function compileDeferredGroups(patterns: readonly string[]): (name: string) => string | undefined {
  const include: string[] = []
  const exclude: string[] = []
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) exclude.push(pattern.slice(1))
    else include.push(pattern)
  }
  const matches = (pattern: string, name: string): boolean =>
    pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern
  return (name) => {
    if (exclude.some(pattern => matches(pattern, name))) return undefined
    let best: string | undefined
    for (const pattern of include) {
      if (matches(pattern, name) && (best === undefined || pattern.length > best.length)) best = pattern
    }
    if (best === undefined) return undefined
    return MCP_SERVER.exec(name)?.[1] ?? best
  }
}

/**
 * Compile deferred-name patterns into a membership predicate.
 * @param patterns - configured patterns; see {@link compileDeferredGroups}.
 * @returns a predicate over tool names.
 */
export function compileDeferredPatterns(patterns: readonly string[]): (name: string) => boolean {
  const group = compileDeferredGroups(patterns)
  return name => group(name) !== undefined
}

/** First sentence of a description, capped, for the catalog line. */
function summarize(description: string): string {
  const firstLine = description.split('\n', 1)[0] ?? ''
  const sentence = /^(.*?[.。!?！？])(\s|$)/u.exec(firstLine)?.[1] ?? firstLine
  const chars = Array.from(sentence)
  return chars.length > CATALOG_SUMMARY_CHARS
    ? `${chars.slice(0, CATALOG_SUMMARY_CHARS - 1).join('')}…`
    : sentence
}

/**
 * Render the `tool_search` description with the catalog of deferred tools
 * the model may reveal in this scope.
 * @param deferred - deferred definitions visible to the scope and not yet revealed.
 * @returns the complete model-facing description.
 */
export function renderToolSearchDescription(deferred: readonly ToolDefinition[]): string {
  const lines = [...deferred]
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
    .map(tool => `- ${tool.name}: ${summarize(tool.description)}`)
  return [
    'Reveal tools that are registered but not declared yet. The tools below exist but their full schemas are',
    'not loaded; when a task needs one of them, call tool_search with a short query (tool name, or words',
    'from its purpose). Matching tools become callable from the next step and stay available for the rest of',
    'the session. Do not call tool_search for a tool that is already declared.',
    '',
    'Available deferred tools:',
    ...lines,
  ].join('\n')
}

/** Tokenize a query or description into lower-case search terms. */
function terms(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(term => term.length > 1)
}

/**
 * Rank deferred tools against a query: exact name, then name substring, then
 * term overlap with name and description.
 * @param query - model query.
 * @param candidates - searchable definitions.
 * @returns best matches, strongest first, at most {@link MAX_HITS}.
 */
export function searchDeferredTools(query: string, candidates: readonly ToolDefinition[]): ToolDefinition[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return []
  const queryTerms = new Set(terms(needle))
  const scored = candidates.map((tool) => {
    const name = tool.name.toLowerCase()
    let score = 0
    if (name === needle) score += 100
    else if (name.includes(needle) || needle.includes(name)) score += 50
    const haystack = new Set(terms(`${tool.name} ${tool.description}`))
    for (const term of queryTerms) {
      if (name.includes(term)) score += 10
      else if (haystack.has(term)) score += 2
    }
    return { tool, score }
  })
  return scored
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name, 'en'))
    .slice(0, MAX_HITS)
    .map(entry => entry.tool)
}

/** Projected state: names revealed so far, in first-reveal order. */
export interface ToolsRevealedState {
  names: string[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Deferred tools the model has revealed through `tool_search`. */
    toolsRevealed: ToolsRevealedState
  }
}

/** Fold one committed event; returns the same reference for unrelated events. */
function foldReveal(state: ToolsRevealedState, event: SessionEvent): ToolsRevealedState {
  if (event.type !== 'tools/reveal') return state
  const fresh = event.data.names.filter(name => !state.names.includes(name))
  return fresh.length === 0 ? state : { names: [...state.names, ...fresh] }
}

/** Host-only projection of `tools/reveal` events, maintained incrementally so no history read is needed. */
export const toolsRevealedProjection = {
  key: 'toolsRevealed',
  stateVersion: 1,
  stateSchema: z.object({ names: z.array(z.string()) }).strict(),
  init: (): ToolsRevealedState => ({ names: [] }),
  apply: foldReveal,
} satisfies Omit<ProjectionDefinition<'toolsRevealed', ToolsRevealedState>, 'wire'>

/**
 * Durable per-session record of revealed deferred tools. Reads the
 * `toolsRevealed` projection when a registry is mounted; without one the
 * reveal is still logged but only remembered in this process.
 */
export class RevealLog {
  private readonly local = new WeakMap<Session, Set<string>>()

  constructor(private readonly projections: () => SessionProjectionRegistry | undefined) {}

  /**
   * Names revealed so far in `session`.
   * @param session - session whose reveals are read.
   * @returns the revealed-name set (do not mutate).
   */
  revealed(session: Session): ReadonlySet<string> {
    const state = this.projections()?.stateOf(session, 'toolsRevealed')
    if (state !== undefined) return new Set(state.names)
    return this.local.get(session) ?? new Set()
  }

  /**
   * Durably reveal `names` in `session`.
   * @param session - session whose log records the reveal.
   * @param names - deferred tool names to reveal; already-revealed names are skipped.
   * @returns the names newly revealed by this call.
   */
  reveal(session: Session, names: readonly string[]): string[] {
    const known = this.revealed(session)
    const fresh = names.filter(name => !known.has(name))
    if (fresh.length === 0) return []
    session.append('tools/reveal', { names: fresh })
    let local = this.local.get(session)
    if (local === undefined) {
      local = new Set()
      this.local.set(session, local)
    }
    for (const name of fresh) local.add(name)
    return fresh
  }
}

/** Registry capabilities the transport closes over. */
export interface ToolSearchBridgeOptions {
  /** Deferred definitions the calling scope may still reveal. */
  searchable(scope: object | undefined): readonly ToolDefinition[]
  /** Record the reveal for the calling agent's session; `undefined` when the call has no agent. */
  reveal(scope: object | undefined, names: readonly string[]): string[] | undefined
}

/**
 * Build the reserved `tool_search` transport. The description is a getter so
 * the catalog reflects the live registry and the caller's remaining deferred
 * tools at schema-emission time.
 * @param options - registry capabilities.
 * @returns the transport definition.
 */
export function createToolSearchTool(options: ToolSearchBridgeOptions): ToolDefinition {
  const definition = defineTool({
    name: TOOL_SEARCH_NAME,
    description: 'placeholder — replaced by the scope-aware getter below',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Tool name or a few words describing what you need (e.g. "broadcast message", "spawn session", "feishu doc").',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          revealed: { type: 'array', required: true, items: { type: 'string' } },
          tools: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render(_args, value) {
        if (value.tools.length === 0) {
          return [{ type: 'text', text: 'No deferred tool matches that query. Check the catalog in the tool_search description and try the tool name or a different phrase.' }]
        }
        const lines = value.tools.map(tool => `## ${tool.name}\n${tool.description}`)
        const head = value.revealed.length > 0
          ? `Revealed ${value.revealed.length} tool(s): ${value.revealed.join(', ')}. They are callable from your next step.`
          : 'These tools were already revealed and are callable now.'
        return [{ type: 'text', text: `${head}\n\n${lines.join('\n\n')}` }]
      },
    },
    isConcurrencySafe: () => true,
    execute(args, exec) {
      const hits = searchDeferredTools(args.query, options.searchable(exec.agent))
      const revealed = options.reveal(exec.agent, hits.map(tool => tool.name)) ?? []
      return Promise.resolve({
        revealed,
        tools: hits.map(tool => ({ name: tool.name, description: tool.description })),
      })
    },
  })
  return definition
}

/** Scope-aware description installer; separate so the registry owns the view. */
export function withSearchDescription(
  definition: ToolDefinition,
  describe: () => string,
): ToolDefinition {
  return Object.defineProperty(definition, 'description', {
    get: describe,
    enumerable: true,
    configurable: true,
  })
}
