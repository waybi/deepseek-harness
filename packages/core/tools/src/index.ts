/**
 * Tool definitions and scoped dispatch to plugin-owned executors.
 *
 * Declared definitions are ordered by name, never by registration order: the
 * declarations are the head of every request, and a provider that caches a
 * request prefix byte for byte (the DeepSeek KV cache) must see the same tool
 * set serialize identically however its plugins registered.
 *
 * @module @deepseek-ai/dsh-tools
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AnonymousEntries, NamedEntries, ScopedLayers, scopeOf, scopeChainOf } from '@deepseek-ai/dsh-scope'
import type { ScopeKey, ScopeLayer } from '@deepseek-ai/dsh-scope'
import { ToolExecutorUnavailableError } from './executor.ts'
import type { ToolExecutor, ToolBatchInput, ToolBatchResult } from './executor.ts'
import './events.ts'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { projectToolSchema } from './schema.ts'
import { assertSupportedJsonSchema } from './json-schema.ts'
import { RUN_CODE_NAME, ToolActivationError } from './contracts.ts'
import {
  compareToolNames,
  compileDeferredGroups,
  createToolSearchTool,
  renderToolSearchDescription,
  RevealLog,
  TOOL_SEARCH_NAME,
  toolsRevealedProjection,
} from './tool-search.ts'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: the optional `ctx.sessionProjections` service for durable reveals.
import type {} from '@deepseek-ai/dsh-session-projection'
import type {
  ToolDefinition, ToolRestriction, ToolExecution, ToolGuard,
  ResolvedToolSet, ToolActivationContext, ToolRegistrationOptions,
} from './contracts.ts'

declare module '@deepseek-ai/dsh-system-prompt' {
  interface AssembleContext {
    /** Step-owned tool selection; absent when inspecting registered definitions. */
    toolSet?: ResolvedToolSet
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Tool availability changes supplied by the tool registry. */
    'tool-registry': { kind: 'tool-registry' }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolsService
  }
}

/** One restriction compiled at registration for repeated live-global lookup. */
interface CompiledToolRestriction {
  readonly allow?: ReadonlySet<string>
  readonly deny?: ReadonlySet<string>
}

/** One registered definition and its step-time activation condition. */
interface ToolRegistration {
  readonly definition: ToolDefinition
  readonly when: ToolRegistrationOptions['when']
}

/** One scope's complete registry view, derived in a single layer traversal. */
interface ToolView {
  /** Visible definitions after restrictions, scoped shadowing, and inherited restrictions. */
  readonly visible: ReadonlyMap<string, ToolDefinition>
  /** Registrations behind {@link visible}, keyed by the same names. */
  readonly registrations: ReadonlyMap<string, ToolRegistration>
  /** Pre-restriction capability names used by prompt-order validation. */
  readonly knownNames: ReadonlySet<string>
  /** Current global names that a scoped restriction may name. */
  readonly restrictableNames: ReadonlySet<string>
}

/** One scope's complete tool-registry contribution. */
class ToolLayer implements ScopeLayer {
  readonly tools: NamedEntries<ToolRegistration>
  readonly restrictions = new AnonymousEntries<CompiledToolRestriction>()

  constructor(scope: ScopeKey | undefined) {
    this.tools = new NamedEntries(name => new Error(scope === undefined
      ? `tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`
      : `tool "${name}" is already registered in this scope`))
  }

  /** Whether every contribution table in this aggregate layer is empty. */
  isEmpty(): boolean {
    return this.tools.isEmpty() && this.restrictions.isEmpty()
  }

  /** Whether every compiled restriction in this layer admits a global tool name. */
  admits(name: string): boolean {
    for (const filter of this.restrictions.values()) {
      if ((filter.allow !== undefined && !filter.allow.has(name))
        || (filter.deny !== undefined && filter.deny.has(name))) return false
    }
    return true
  }

}

interface Registration {
  executor: ToolExecutor | undefined
}

class GuardLayer {
  readonly guards = new AnonymousEntries<ToolGuard>()
  isEmpty(): boolean { return this.guards.isEmpty() }
}

/** Plugin config for the tool registry. */
export interface Config {
  /** Removed. Mount a native or PTC tool executor instead. */
  mode?: never
  /** Moved to the PTC tool executor configuration. */
  maxParallelSubCalls?: never
  /**
   * Tool names (exact, or a prefix ending in `*`) whose schemas are declared
   * to the model only after it reveals them through the reserved
   * `tool_search` tool. A leading `!` excludes matching names. A definition's
   * own `exposure: 'direct'` overrides a matching pattern. Empty (default)
   * declares every visible tool directly.
   *
   * Each pattern is a reveal group: a search that hits one member reveals
   * every hidden member of its most specific pattern (MCP tools group per
   * server). A reveal changes the declared tool list, which invalidates the
   * provider's cached prompt prefix once, so grouping keeps that cost to one
   * invalidation per family.
   */
  deferred?: string[]
}

/** The live session an agent-keyed scope carries, when it carries one. */
function sessionOf(scope: ScopeKey | undefined): Session | undefined {
  if (scope === undefined || !('session' in scope)) return undefined
  const { session } = scope as { session?: unknown }
  return typeof session === 'object' && session !== null && 'append' in session ? session as Session : undefined
}

/** Concrete tool registry and scoped executor dispatcher. */
export class ToolsService extends Service {
  static inject = ['systemPrompt']
  static Config = z.object({
    mode: z.never().description('Removed. Mount a native or PTC tool executor instead.'),
    maxParallelSubCalls: z.never().description('Moved to the PTC tool executor configuration.'),
    deferred: z.array(z.string()).default([]),
  })

  private readonly layers = new ScopedLayers(scope => new ToolLayer(scope), () => { this.ctx.emit('tools/change') })
  private readonly scoped = new WeakMap<ScopeKey, Registration>()
  private root: Registration | undefined
  private readonly guards = new ScopedLayers(() => new GuardLayer(), () => {})
  /** Configured deferred-name lookup: the reveal group of a deferred name, or undefined. */
  private readonly deferredGroup: (name: string) => string | undefined
  /** Durable per-session record of revealed deferred tools. */
  private readonly reveals = new RevealLog()
  /** Reserved discovery transport executor, built on first need. */
  private searchTransport: ToolDefinition | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'tools')
    this.deferredGroup = compileDeferredGroups(config.deferred ?? [])
    ctx.systemPrompt.tools(({ scope, toolSet }) => {
      const executor = this.selectExecutor(scope)
      const description = executor.describe(this.definitions(scope, toolSet))
      return { ...description, knownNames: description.knownNames ?? [...this.view(scope).knownNames, TOOL_SEARCH_NAME] }
    })
    ctx.systemPrompt.section({
      name: 'tools:search',
      order: ctx.systemPrompt.getSectionOrder('TOOLS_SEARCH'),
      text: ({ scope, toolSet }) => this.partition(scope, toolSet).hidden.length > 0
        ? `Some tools are registered but not declared to save context. If no declared tool fits a task, call \`${TOOL_SEARCH_NAME}\` with a short description of what you need; its description lists every hidden tool by name. A revealed tool stays available for the rest of the session.`
        : '',
    })
  }

  /**
   * Durable reveals need the projection registry; a composition without one
   * (minimal test mounts) still logs reveals but remembers them per process.
   */
  protected async [Service.init](): Promise<void> {
    const projections = this.ctx.get('sessionProjections')
    if (projections !== undefined) this.reveals.attach(await projections.register(toolsRevealedProjection))
  }

  /**
   * Whether a visible definition is declared only after a `tool_search` reveal.
   * @param definition - visible definition.
   * @returns true when the definition is deferred for every scope.
   */
  private isDeferred(definition: ToolDefinition): boolean {
    if (definition.exposure !== undefined) return definition.exposure === 'deferred'
    return this.deferredGroup(definition.name) !== undefined
  }

  /**
   * Reveal group of a deferred name: its configured pattern group, or the name
   * itself for a definition deferred only through its own `exposure`.
   * @param name - deferred tool name.
   * @returns the group key shared by tools that reveal together.
   */
  private revealGroupOf(name: string): string {
    return this.deferredGroup(name) ?? name
  }

  /** Revealed names for a scope, or an empty set when the scope carries no session. */
  private revealedFor(scope: ScopeKey | undefined): ReadonlySet<string> {
    const session = sessionOf(scope)
    return session === undefined ? new Set() : this.reveals.revealed(session)
  }

  /**
   * Split one scope's visible definitions into declared and still-hidden
   * deferred ones. A reveal is read from the scope's session log; a scope
   * without a session (the global view) never reveals. When any tool stays
   * hidden, the declared list carries one `tool_search` definition whose
   * description catalogs exactly the hidden ones.
   * @param scope - the viewing scope (the agent), or undefined for the global view.
   * @param toolSet - step admission; omit only to inspect registered definitions.
   * @returns the declared definitions in name order and the hidden deferred ones.
   */
  private partition(scope?: ScopeKey, toolSet?: ResolvedToolSet): { declared: ToolDefinition[]; hidden: ToolDefinition[] } {
    const visible = toolSet === undefined ? this.view(scope).visible : toolSet.view(scope)
    const revealed = this.revealedFor(scope)
    const declared: ToolDefinition[] = []
    const hidden: ToolDefinition[] = []
    for (const definition of visible.values()) {
      if (!this.isDeferred(definition) || revealed.has(definition.name)) declared.push(definition)
      else hidden.push(definition)
    }
    if (hidden.length > 0) {
      declared.push({ ...this.requireSearchTransport(), description: renderToolSearchDescription(hidden) })
    }
    // Declarations are a request prefix the provider's KV cache matches byte
    // for byte, so the same tool set must serialize identically however its
    // plugins registered.
    declared.sort(compareToolNames)
    return { declared, hidden }
  }

  /** Reserved `tool_search` transport; {@link partition} renders its description per scope. */
  private requireSearchTransport(): ToolDefinition {
    this.searchTransport ??= createToolSearchTool({
      searchable: scope => this.partition(scope as ScopeKey | undefined).hidden,
      reveal: (scope, names) => {
        const key = scope as ScopeKey | undefined
        const session = sessionOf(key)
        if (session === undefined) return undefined
        // Each reveal changes the declared tool list and so invalidates the
        // provider's cached prompt prefix once; revealing a whole group per
        // search keeps that to one invalidation per tool family.
        const groups = new Set(names.map(name => this.revealGroupOf(name)))
        const expanded = this.partition(key).hidden
          .filter(definition => groups.has(this.revealGroupOf(definition.name)))
          .map(definition => definition.name)
        const fresh = this.reveals.reveal(session, expanded)
        if (fresh.length > 0) this.ctx.emit('tools/change')
        return fresh
      },
    })
    return this.searchTransport
  }


  /**
   * Register globally or in the calling agent scope. Scoped tools shadow
   * globals; duplicates within one layer and the reserved `run_code` name fail.
   * @param definition - tool schema, execution, and optional finalization/presentation callbacks.
   * @param options - optional step-time activation condition.
   * @returns the exact disposer that unregisters the tool.
   */
  register(definition: ToolDefinition, options: ToolRegistrationOptions = {}): () => void {
    const name = definition.name
    const output = (definition as Partial<ToolDefinition>).output
    if (output === undefined || typeof output !== 'object'
      || typeof output.render !== 'function'
      || (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function')) {
      throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`)
    }
    assertSupportedJsonSchema(output.schema)
    const timeoutMs = definition.timeoutMs
    if (timeoutMs !== undefined
      && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`)
    }
    // Reserved unconditionally: any agent may select a code mode for itself,
    // so a name free to take under the deployment default would become a
    // collision the moment a preset mounted.
    if (name === RUN_CODE_NAME) {
      throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the PTC mode presentation transport and cannot be registered or shadowed`)
    }
    if (name === TOOL_SEARCH_NAME) {
      throw new Error(`tool name "${TOOL_SEARCH_NAME}" is reserved for the deferred-tool discovery transport and cannot be registered or shadowed`)
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.tools.insert(name, { definition, when: options.when }),
      { label: 'tools.register()' },
    )
  }

  /**
   * Restrict global tools for the calling agent scope. Empty filters, unknown
   * names, scope-local names, and reserved transport names fail. Restrictions
   * intersect; scoped registrations remain visible.
   * @param filter - global-tool mask: `allow` (keep only) and/or `deny` (remove).
   * @returns the exact disposer that lifts this restriction.
   */
  restrict(filter: ToolRestriction): () => void {
    const scope = scopeOf(this.ctx)
    if (scope === undefined) {
      throw new Error('tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead')
    }
    const allow = filter.allow
    const deny = filter.deny
    if (allow === undefined && deny === undefined) {
      throw new Error('tools.restrict({}) is a no-op: pass `allow` and/or `deny` (an empty filter is almost always a materialized-empty-config bug)')
    }
    const compiled: CompiledToolRestriction = {
      ...allow !== undefined ? { allow: new Set(allow) } : {},
      ...deny !== undefined ? { deny: new Set(deny) } : {},
    }
    if ([...allow ?? [], ...deny ?? []].includes(RUN_CODE_NAME)) {
      throw new Error(`tools.restrict() cannot name reserved PTC mode presentation transport "${RUN_CODE_NAME}"; restrict end-capability tools instead`)
    }
    if ([...allow ?? [], ...deny ?? []].includes(TOOL_SEARCH_NAME)) {
      throw new Error(`tools.restrict() cannot name reserved discovery transport "${TOOL_SEARCH_NAME}"; defer or deny end-capability tools instead`)
    }
    const known = this.view(scope).restrictableNames
    const unknown = [...allow ?? [], ...deny ?? []].filter(name => !known.has(name))
    if (unknown.length > 0) {
      throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ${unknown.map(n => `"${n}"`).join(', ')}; known global tools: ${[...known].sort().join(', ') || '(none)'}`)
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.restrictions.append(compiled),
      { label: 'tools.restrict()' },
    )
  }

  /**
   * Resolve visible tools and pre-restriction names. Restrictions across the
   * scope chain intersect over inherited global and ancestor tools; the viewing
   * scope's own registrations remain exempt. Nearer registrations shadow
   * farther ones. Pre-restriction names support restriction and prompt-order validation.
   * @param scope - the viewing scope (the agent), or undefined for the global view.
   * @returns the complete derived view for that scope.
   */
  private view(scope?: ScopeKey): ToolView {
    const layers = this.layers.chainLayers(scope)
    const own = this.layers.peek(scope)
    const inherited = new Map(this.layers.global.tools.entries())
    for (const layer of layers) {
      if (layer === own) continue
      for (const [name, registration] of layer.tools.entries()) inherited.set(name, registration)
    }
    const visible = new Map<string, ToolDefinition>()
    const registrations = new Map<string, ToolRegistration>()
    const knownNames = new Set<string>()
    const restrictableNames = new Set<string>()
    for (const [name, registration] of inherited) {
      knownNames.add(name)
      restrictableNames.add(name)
      if (layers.every(layer => layer.admits(name))) {
        visible.set(name, registration.definition)
        registrations.set(name, registration)
      }
    }
    if (own !== undefined) {
      for (const [name, registration] of own.tools.entries()) {
        knownNames.add(name)
        visible.set(name, registration.definition)
        registrations.set(name, registration)
      }
    }
    return { visible, registrations, knownNames, restrictableNames }
  }

  /**
   * Look up a tool as one scope sees it (scoped
   * shadows global; a restricted-away global reads as absent). Presenters pass
   * the calling agent so the rendered card matches the definition that
   * actually executed.
   * @param name - the tool name as registered.
   * @param scope - the viewing scope (the agent); omitted = the global view.
   * @param toolSet - step admission; omit only to inspect registered definitions.
   * @returns the definition the scope resolves, or undefined when none is visible.
   */
  get(name: string, scope?: ScopeKey, toolSet?: ResolvedToolSet): ToolDefinition | undefined {
    return toolSet === undefined ? this.view(scope).visible.get(name) : toolSet.view(scope).get(name)
  }

  /**
   * Resolve the definition a call may execute. With a step's admitted set, the
   * set decides; without one, conditional registrations are unavailable.
   * @param name - the tool name as registered.
   * @param scope - the calling agent; omitted = the global view.
   * @param toolSet - step admission, or omitted for a call outside a model step.
   * @returns the executable definition, or undefined when the call must fail as `UNKNOWN_TOOL`.
   */
  executable(name: string, scope?: ScopeKey, toolSet?: ResolvedToolSet): ToolDefinition | undefined {
    // The discovery transport is callable exactly when it is declared: some
    // deferred tool is still hidden for this scope. A hidden deferred tool is
    // not callable until revealed, so the prompt and the executor agree.
    if (name === TOOL_SEARCH_NAME) {
      return this.partition(scope, toolSet).hidden.length > 0 ? this.requireSearchTransport() : undefined
    }
    let tool: ToolDefinition | undefined
    if (toolSet !== undefined) tool = toolSet.view(scope).get(name)
    else {
      const view = this.view(scope)
      tool = view.registrations.get(name)?.when === undefined ? view.visible.get(name) : undefined
    }
    if (tool !== undefined && this.isDeferred(tool) && !this.revealedFor(scope).has(name)) return undefined
    return tool
  }

  /**
   * Resolve conditions once for this step without changing shared registrations.
   * Cancellation or a rejected condition publishes no partial selection. Removed
   * registrations cannot be restored by a late condition result.
   * @param context - preparing agent, captured model selection, and cancellation.
   * @returns the complete selection; the caller disposes it after its tool batch settles.
   */
  async resolve(context: ToolActivationContext): Promise<ResolvedToolSet> {
    const { agent, signal } = context
    signal.throwIfAborted()
    const view = this.view(agent)
    const admitted = new Map<string, ToolDefinition>()
    for (const [name, definition] of view.visible) {
      const registration = view.registrations.get(name)
      let enabled: boolean
      try {
        enabled = registration?.when === undefined || await registration.when(context)
      } catch (cause: unknown) {
        signal.throwIfAborted()
        throw new ToolActivationError(name, cause)
      }
      signal.throwIfAborted()
      if (enabled) admitted.set(name, definition)
    }
    let closed = false
    return Object.freeze({
      dispose: () => { closed = true },
      view: (scope: ScopeKey | undefined): ReadonlyMap<string, ToolDefinition> => {
        const visible = new Map<string, ToolDefinition>()
        if (closed || scope !== agent) return visible
        const current = this.view(agent)
        for (const [name, definition] of admitted) {
          if (current.visible.get(name) === definition
            && current.registrations.get(name) === view.registrations.get(name)) {
            visible.set(name, definition)
          }
        }
        return visible
      },
    })
  }

  /**
   * Read the declared capability definitions for descriptions and program bindings.
   * Deferred tools not yet revealed for the scope are replaced by one trailing
   * `tool_search` definition that catalogs them.
   * @param scope - viewing Agent or preset; omitted selects the global view.
   * @param toolSet - step admission; omit only to inspect registered definitions.
   * @returns definitions after scoped shadowing, restrictions, and deferral, limited to the step's admission when given.
   */
  definitions(scope?: ScopeKey, toolSet?: ResolvedToolSet): readonly ToolDefinition[] {
    return this.partition(scope, toolSet).declared
  }

  /**
   * Project visible definitions onto the allowlisted model-facing schema fields,
   * excluding execution and presentation callbacks.
   * @param scope - the viewing scope (the agent); omitted = the global view.
   * @param toolSet - step admission, or omitted for registered-definition inspection.
   * @returns one deep-cloned schema per visible tool.
   */
  schemas(scope?: ScopeKey, toolSet?: ResolvedToolSet): ToolSchema[] {
    return this.definitions(scope, toolSet).map(definition => projectToolSchema(definition, true))
  }
  /**
   * Provide the executor for the calling scope; an unscoped contribution is the deployment default.
   * Rendering any executor-owned section requires the viewing scope's selection to remain available.
   * @param executor - initialized provider owned by the contributing plugin.
   * @returns the effect disposer. Unloading leaves the selection unavailable until it is replaced.
   */
  setExecutor(executor: ToolExecutor): () => void {
    const scope = scopeOf(this.ctx)
    const existing = scope === undefined ? this.root : this.scoped.get(scope)
    if (existing?.executor !== undefined) throw new Error('Only one tool executor may be registered in each scope')
    const record: Registration = { executor }
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; preserve the Cordis disposer identity
    return this.ctx.effect(function* (this: ToolsService) {
      for (const section of executor.sections ?? []) {
        yield this.ctx.systemPrompt.section({
          name: section.name,
          order: section.order,
          ...section.interpolate === undefined ? {} : { interpolate: section.interpolate },
          text: ({ scope, toolSet }) => {
            if (this.selectExecutor(scope) !== executor) return ''
            return typeof section.text === 'function' ? section.text(this.definitions(scope, toolSet)) : section.text
          },
        })
      }
      if (scope === undefined) this.root = record
      else this.scoped.set(scope, record)
      yield () => {
        // Keep an unavailable selection so a program cannot fall through to a different executor.
        record.executor = undefined
      }
    }.bind(this), 'tools.setExecutor()')
  }

  /**
   * Resolve the nearest scoped provider, or the deployment default.
   * @param scope - Agent or preset scope; omitted selects only the root contribution.
   * @returns the selected executor; throws when it is missing or unloaded.
   */
  private selectExecutor(scope?: ScopeKey): ToolExecutor {
    let record: Registration | undefined
    for (const key of scopeChainOf(scope)) {
      record = this.scoped.get(key)
      if (record !== undefined) break
    }
    record ??= this.root
    const executor = record?.executor
    if (executor === undefined) throw new ToolExecutorUnavailableError()
    return executor
  }

  /**
   * Delegate a raw call batch to its Agent's provider or the deployment default.
   * Select at dispatch; accepted batches settle through that provider even if it unloads.
   * @param input - original calls, optional owning Agent, and optional logging step.
   * @returns the selected executor's settled batch; unavailable selections reject.
   */
  async execute(input: ToolBatchInput): Promise<ToolBatchResult> {
    return this.selectExecutor(input.agent).execute(input)
  }

  /**
   * Register a monotonic denial in the calling scope.
   * @param guard - evaluated after extensible pre-execute policy by the shared pipeline.
   * @returns the effect disposer that removes this guard.
   */
  guard(guard: ToolGuard): () => void {
    return this.guards.effect(this.ctx, layer => layer.guards.append(guard), { label: 'tools.guard()' })
  }

  /**
   * Check global and inherited guards after pre-execute policy and approval resolve.
   * @param exec - invocation whose guards are checked before dispatch.
   * @returns the first denial reason, or undefined when no guard denies.
   */
  checkGuards(exec: ToolExecution): string | undefined {
    for (const layer of [this.guards.global, ...this.guards.chainLayers(exec.agent)]) {
      for (const guard of layer.guards.values()) {
        const reason = guard(exec)
        if (reason !== undefined) return reason
      }
    }
    return undefined
  }

}

export default ToolsService

export * from './contracts.ts'
export * from './executor.ts'
export * from './schema.ts'
export * from './json-schema.ts'
export * from './presentation.ts'
export { compareToolNames, compileDeferredGroups, compileDeferredPatterns, searchDeferredTools, TOOL_SEARCH_NAME, toolsRevealedProjection } from './tool-search.ts'
export type { ToolExposure, ToolsRevealedState } from './tool-search.ts'
export { ToolsService as ToolRuntime }
