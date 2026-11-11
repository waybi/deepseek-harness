/**
 * Durable session skill catalog and model-facing `skill` loader tool.
 *
 * @module @deepseek-ai/dsh-tool-skill
 */

import type {} from '@deepseek-ai/dsh-working-directory'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type UserMessage } from '@deepseek-ai/dsh-session'
import {
  escapeText,
  isModelInvocable,
  isSkillName,
  isUserInvocable,
  renderSkillContent,
  type SkillInvocationSource,
  type SkillSummary,
} from '@deepseek-ai/dsh-skill'

export const name = 'tool-skill'
export const inject = ['agents', 'tools', 'skills', 'workingDirectory']

const DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH = 500
/**
 * Character budget for a catalog delta notice. A change that would exceed it
 * republishes the whole catalog instead: past that point the notice is no longer
 * smaller than the list it replaces, and a long chain of deltas is easier for a
 * reader to mis-handle than one complete list. `0` disables deltas.
 */
const DEFAULT_CATALOG_DELTA_MAX_CHARS = 1200
/**
 * Durable provider and item records for one published session skill catalog. The catalog is a
 * `catalog`-form context, so it records the entries it published beside the
 * model-facing prose: a consumer presenting the list must not re-parse the
 * `<available_skills>` block, whose framing exists for the model.
 */
export interface SkillCatalogSource {
  readonly kind: 'skill-catalog'
  readonly form: 'catalog'
  /** Marks a replacement catalog rather than this session's first publication. */
  readonly update?: true
  /**
   * This replacement lists only the entries that changed against the previous
   * visible catalog; `entries` still carries the complete result.
   */
  readonly delta?: true
  /** Some discovery failed; entries contain only skills found in this observation. Absence means complete. */
  readonly incomplete?: true
  /** Exactly the entries this message published, in catalog order. */
  readonly entries: readonly { readonly name: string; readonly description: string }[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'skill-catalog': SkillCatalogSource
  }
}

/** Durable entry list mirroring the rendered catalog lines, for non-model consumers. */
function catalogSourceEntries(
  skills: SkillSummary[],
  descriptionMaxLength: number,
): SkillCatalogSource['entries'] {
  return skills.map(skill => ({
    name: skill.name,
    description: catalogDescription(skill.description, descriptionMaxLength),
  }))
}

/** Model-facing skill catalog configuration. */
export interface Config {
  /** Maximum normalized description length rendered in the session catalog; minimum 3. */
  catalogDescriptionMaxLength?: number
  /**
   * Maximum characters in a catalog delta notice; minimum 0. A change that would
   * exceed it republishes the whole catalog. `0` always republishes.
   */
  catalogDeltaMaxChars?: number
}

/** Validate and default the model-facing skill catalog configuration. */
export const Config: z<Config> = z.object({
  catalogDescriptionMaxLength: z.number().default(DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH),
  catalogDeltaMaxChars: z.number().default(DEFAULT_CATALOG_DELTA_MAX_CHARS),
})

/**
 * Register the model-facing skill loader and its visibility-matched
 * durable session catalog. The catalog is emitted only when the calling agent
 * resolves this plugin's exact tool registration; a restriction or scoped
 * same-name shadow therefore removes both the schema and its call guidance.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const catalogDescriptionMaxLength = config.catalogDescriptionMaxLength ?? DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH
  assertPositiveInteger('catalogDescriptionMaxLength', catalogDescriptionMaxLength, 3)
  const catalogDeltaMaxChars = config.catalogDeltaMaxChars ?? DEFAULT_CATALOG_DELTA_MAX_CHARS
  assertPositiveInteger('catalogDeltaMaxChars', catalogDeltaMaxChars, 0)

  const skillTool = defineTool({
    name: 'skill',
    description: 'Load the full instructions for a skill. Call it before acting on a task that names or clearly matches a skill in the session skill catalog.',
    parameters: {
      name: { type: 'string', required: true, description: 'The exact skill name from the available skills list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          resourceBase: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'directory' },
                  path: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'url' },
                  url: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'opaque' },
                  description: { type: 'string', required: true },
                },
              },
            ],
          },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSkillContent(value) }],
    },
    async execute(args, exec) {
      if (!isSkillName(args.name)) {
        throw new Error(`invalid skill name "${args.name}"`)
      }
      // The agent is its own scope key, so the lookup resolves the layered
      // registry exactly as this agent's composition sees it.
      const cwd = exec.agent === undefined ? undefined : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      const lookup = { cwd, signal: exec.signal, scope: exec.agent }
      const summary = (await ctx.skills.list(lookup)).find(skill => skill.name === args.name)
      if (!summary) {
        throw new Error(`skill "${args.name}" is unknown or no longer available`)
      }
      if (!isModelInvocable(summary)) {
        throw new Error(`skill "${args.name}" is not available for model invocation`)
      }
      const skill = await ctx.skills.get(args.name, lookup)
      if (!skill) {
        throw new Error(`skill "${args.name}" is unknown or no longer available`)
      }
      if (!isModelInvocable(skill)) {
        throw new Error(`skill "${args.name}" is not available for model invocation`)
      }
      return {
        name: skill.name,
        provider: skill.provider,
        ...skill.resourceBase !== undefined ? {
          resourceBase: { ...skill.resourceBase },
        } : {},
        content: skill.content,
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Load skill ${args.name}`, kind: 'read', rawInput: args.name }
    },
  })
  ctx.tools.register(skillTool)

  // User-explicit skill invocation: a claimed user message whose first line
  // starts with `/<name>` naming a user-invocable skill is a deterministic
  // load gesture. The rendered body enters this step as injected
  // instructions context appended after every other injection — background
  // first (workspace rules, runtime policy, the catalog), the material the
  // model must act on last, closest to its answer. Registration order makes
  // that placement deterministic: this listener registers before the catalog
  // listener, so the waterfall hands it the catalog-bearing list to extend.
  // Only `source.kind === 'user'` messages are scanned — external text
  // cannot forge the gesture — and a token naming no user-invocable skill
  // stays ordinary prose (the command registry is a different closed
  // namespace, resolved client-side before a line ever becomes a prompt).
  // This is the only entry point for `disable-model-invocation` skills; the
  // catalog and the `skill` tool below never see them.
  ctx.on('agent/pre-step', async (
    { agent, messages, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const names = invokedSkillNames(messages)
    if (names.length === 0) return decision
    signal.throwIfAborted()
    const lookup = { cwd: await ctx.workingDirectory.ensure(agent, signal), signal, scope: agent }
    const injections: UserMessage[] = []
    for (const name of names) {
      const skill = await ctx.skills.get(name, lookup)
      signal.throwIfAborted()
      // Unknown names and user-disabled skills stay plain prose: the
      // gesture was never a claim this boundary recognizes. The check sits
      // on the loaded definition — the single lookup that produces what is
      // actually injected.
      if (skill === undefined || !isUserInvocable(skill)) continue
      const source: SkillInvocationSource = { kind: 'skill-invocation', name, form: 'instructions' }
      injections.push(createUserMessage({
        content: [{ type: 'text', text: renderSkillContent(skill) }],
        source,
      }))
    }
    if (injections.length === 0) return decision
    return { ...decision, messages: [...decision.messages, ...injections] }
  })

  // Register after the tool so reverse teardown removes guidance first. Exact definition
  // identity prevents a scoped shadow merely named `skill` from inheriting this catalog.
  //
  // The comparison is against the definition this plugin registered, not against
  // a lookup of its own name: `register()` files into the CALLING context's
  // scope, so a plugin mounted inside an agent preset registers for that agent
  // alone and an unscoped lookup correctly finds nothing.
  ctx.on('agent/pre-step', async (
    { agent, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal.throwIfAborted()
    const toolVisible = ctx.tools.get(skillTool.name, agent) === skillTool
    const snapshot = toolVisible
      ? await ctx.skills.snapshot({ cwd: await ctx.workingDirectory.ensure(agent, signal), signal, scope: agent })
      : { skills: [], complete: true }
    signal.throwIfAborted()
    const skills = snapshot.skills.filter(isModelInvocable)
    const entries = catalogSourceEntries(skills, catalogDescriptionMaxLength)
    const incomplete = !snapshot.complete
    const digest = digestCatalogEntries(entries, incomplete)
    const history = catalogHistory(agent)
    const existing = catalogMessage(decision.messages)
    if (history.visibleDigest === digest) {
      return existing === undefined
        ? decision
        : { ...decision, messages: decision.messages.filter(message => message.id !== existing.message.id) }
    }
    if (existing !== undefined && digestCatalogEntries(existing.entries, existing.incomplete) === digest) return decision
    if (!history.published && skills.length === 0 && !incomplete) {
      return existing === undefined
        ? decision
        : { ...decision, messages: decision.messages.filter(message => message.id !== existing.message.id) }
    }
    const catalog = selectCatalog(entries, incomplete, existing, history, catalogDeltaMaxChars)
    return {
      ...decision,
      messages: existing === undefined
        ? [...decision.messages, catalog]
        : decision.messages.map(message => message.id === existing.message.id ? catalog : message),
    }
  })
}

function renderCatalogMessage(entries: SkillCatalogSource['entries'], incomplete: boolean): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        entries.length === 0
          ? 'No skills could be confirmed in this discovery attempt.'
          : 'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
        '',
        '<available_skills>',
        ...renderCatalogEntries(entries),
        '</available_skills>',
        '',
        ...incomplete ? [incompleteCatalogNotice(), ''] : [],
        entries.length === 0
          ? 'Wait for an updated catalog before calling the `skill` tool. Do not infer skill instructions from an empty catalog.'
          : "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
        'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
        '</system-reminder>',
      ].join('\n'),
    }],
    source: {
      kind: 'skill-catalog',
      form: 'catalog',
      entries,
      ...incomplete ? { incomplete: true } : {},
    },
  })
}

function renderCatalogUpdate(entries: SkillCatalogSource['entries'], incomplete: boolean): UserMessage {
  const availability = entries.length === 0
    ? [
      incomplete
        ? 'No skills could be confirmed in this discovery attempt. Do not use names from earlier skill catalogs.'
        : 'No skills are currently available through the `skill` tool. Do not use names from earlier skill catalogs.',
      'A user may still invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool for it.',
    ]
    : [
      'Use only names in this replacement catalog. If the user names a listed skill, or the task clearly matches its description, call the `skill` tool with the exact name before acting.',
      'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
    ]
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        incomplete
          ? 'Skill discovery is incomplete. This catalog of currently available skills replaces every earlier available-skills list in this session:'
          : 'The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:',
        '',
        '<available_skills>',
        ...renderCatalogEntries(entries),
        '</available_skills>',
        '',
        ...incomplete ? [incompleteCatalogNotice(), ''] : [],
        ...availability,
        '</system-reminder>',
      ].join('\n'),
    }],
    source: {
      kind: 'skill-catalog',
      form: 'catalog',
      update: true,
      entries,
      ...incomplete ? { incomplete: true } : {},
    },
  })
}

function incompleteCatalogNotice(): string {
  return 'Some skills could not be checked. Only confirmed skills are listed; a lower-priority definition of the same name may be selected when a preferred source is unavailable. Discovery will be retried on the next request.'
}

/**
 * Model-facing catalog lines, projected from the same entries the source records.
 * The pseudo-XML escaping belongs to this frame, not to the published fact, so it
 * is applied here and never stored. Names are `isSkillName`-validated and carry
 * no escapable character.
 */
function renderCatalogEntries(entries: SkillCatalogSource['entries']): string[] {
  return entries.map(entry => `- \`${entry.name}\`: ${escapeText(entry.description)}`)
}

/**
 * Catalog identity includes durable entries and completeness so recovery clears
 * a discovery warning even when the entries are unchanged.
 */
function digestCatalogEntries(entries: SkillCatalogSource['entries'], incomplete = false): string {
  // JSON per entry rather than a separator character: every separator is itself
  // a legal description character, so only quoting makes the boundary exact.
  const canonical = entries.map(entry => JSON.stringify([entry.name, entry.description])).join('\n')
  return createHash('sha256')
    .update(incomplete ? 'incomplete\n' : '')
    .update(canonical)
    .digest('hex')
}

/**
 * Entries of one durable catalog message, or undefined when the record is not a
 * usable catalog.
 *
 * `agent.session.snapshotEvents()` may contain a resumed, forked, or externally written seed,
 * and seed validation only guarantees a source object with a non-empty `kind`;
 * no per-kind field is checked there. An unreadable record is therefore treated
 * as "not this plugin's catalog" — the posture the replaced content digest had —
 * rather than throwing inside the step listener, which would fail every
 * subsequent turn of that session.
 */
function readCatalogEntries(source: unknown): SkillCatalogSource['entries'] | undefined {
  const entries = (source as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return undefined
  const readable: { name: string; description: string }[] = []
  for (const entry of entries as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const { name, description } = entry as { name?: unknown; description?: unknown }
    if (typeof name !== 'string' || name === '' || typeof description !== 'string') return undefined
    readable.push({ name, description })
  }
  return readable
}

/** The newest catalog the session still shows, and whether any catalog was published. */
interface CatalogHistory {
  /** Digest of the newest catalog on the current surface; absent when none is visible. */
  readonly visibleDigest?: string
  /** Entries of that same catalog, for a delta against it. */
  readonly visibleEntries?: SkillCatalogSource['entries']
  /** Some catalog was published in this session, visible now or not. */
  readonly published: boolean
}

function catalogHistory(agent: Agent): CatalogHistory {
  const visible = new Set(agent.session.surface.nodes)
  let published = false
  for (let index = agent.session.seq - 1; index >= 0; index -= 1) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = agent.session.eventAt(SessionSeq(index))
    if (event === undefined) {
      throw new Error(`skill catalog cannot read seq ${String(index)} below the current Session length`)
    }
    if (event.type !== 'user/message' || event.data.source.kind !== 'skill-catalog') continue
    const entries = readCatalogEntries(event.data.source)
    if (entries === undefined) continue
    const digest = digestCatalogEntries(entries, event.data.source.incomplete === true)
    published = true
    if (visible.has(event.seq)) return { visibleDigest: digest, visibleEntries: entries, published }
  }
  return { published }
}

/** A catalog message this step already carries, with the entries it published. */
interface CatalogMessage {
  readonly message: UserMessage
  readonly entries: SkillCatalogSource['entries']
  readonly incomplete: boolean
}

function catalogMessage(messages: readonly UserMessage[]): CatalogMessage | undefined {
  for (const message of messages) {
    if (message.source.kind !== 'skill-catalog') continue
    const entries = readCatalogEntries(message.source)
    if (entries !== undefined) return { message, entries, incomplete: message.source.incomplete === true }
  }
  return undefined
}

/** Which published entries a later observation adds, rewrites, or no longer confirms. */
interface CatalogDelta {
  readonly added: ReadonlySet<string>
  readonly changed: ReadonlySet<string>
  readonly removed: readonly string[]
}

function catalogDelta(
  previous: SkillCatalogSource['entries'],
  next: SkillCatalogSource['entries'],
): CatalogDelta {
  const before = new Map(previous.map(entry => [entry.name, entry.description]))
  const after = new Set(next.map(entry => entry.name))
  const added = new Set<string>()
  const changed = new Set<string>()
  for (const entry of next) {
    const description = before.get(entry.name)
    if (description === undefined) added.add(entry.name)
    else if (description !== entry.description) changed.add(entry.name)
  }
  const removed = previous.filter(entry => !after.has(entry.name)).map(entry => entry.name)
  return { added, changed, removed }
}

/**
 * Model-facing prose for a delta: only the entries this observation added or
 * rewrote, plus the names it dropped. Everything else stays as published.
 * @param entries - the complete catalog after this observation.
 * @param delta - the change against the previous visible catalog.
 * @returns the notice text.
 */
function renderCatalogDeltaText(entries: SkillCatalogSource['entries'], delta: CatalogDelta): string {
  const listed = entries.filter(entry => delta.added.has(entry.name) || delta.changed.has(entry.name))
  const lines: string[] = ['<system-reminder>']
  if (listed.length > 0) {
    lines.push(
      'The available skill catalog changed. Only the entries below changed; every other skill from the catalog published earlier in this session is unchanged:',
      '',
      '<available_skills_update>',
      ...renderCatalogEntries(listed),
      '</available_skills_update>',
    )
  } else if (delta.removed.length > 0) {
    lines.push('The available skill catalog changed. Only the removals are listed; every other skill from the catalog published earlier in this session is unchanged:')
  } else {
    lines.push('The available skill catalog changed only in completeness. Every skill from the catalog published earlier in this session is unchanged and still available.')
  }
  if (delta.removed.length > 0) {
    const names = delta.removed.map(name => `\`${name}\``).join(', ')
    lines.push('', `Removed (no longer available; do not call \`skill\` with these names): ${names}.`)
  }
  lines.push(
    '',
    'For any skill not listed above, use its name exactly as it appears in the earlier catalog.',
    '</system-reminder>',
  )
  return lines.join('\n')
}

/**
 * Choose the message that publishes this observation. A delta is used only when
 * it is unambiguous and small: a visible earlier catalog exists, discovery is
 * complete (so a missing entry is a real removal), nothing was proposed for this
 * step yet, and the notice fits the budget. Each of those is a reason a complete
 * list is safer, and a complete list is always correct.
 * @param entries - the complete catalog for this observation.
 * @param incomplete - some discovery failed.
 * @param existing - a catalog this step already carries.
 * @param history - the session's published and visible catalog.
 * @param deltaMaxChars - delta budget; `0` disables deltas.
 * @returns the catalog message.
 */
function selectCatalog(
  entries: SkillCatalogSource['entries'],
  incomplete: boolean,
  existing: CatalogMessage | undefined,
  history: CatalogHistory,
  deltaMaxChars: number,
): UserMessage {
  const previous = history.visibleEntries
  if (existing === undefined && !incomplete && deltaMaxChars > 0 && entries.length > 0 && previous !== undefined) {
    const delta = catalogDelta(previous, entries)
    const text = renderCatalogDeltaText(entries, delta)
    if (text.length <= deltaMaxChars) {
      return createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'skill-catalog', form: 'catalog', update: true, delta: true, entries },
      })
    }
  }
  return history.published
    ? renderCatalogUpdate(entries, incomplete)
    : renderCatalogMessage(entries, incomplete)
}

function catalogDescription(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`
}

function assertPositiveInteger(name: string, value: number, minimum = 1): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`tool-skill: ${name} must be an integer greater than or equal to ${minimum}`)
  }
}

/**
 * A whitespace-bounded `/name` token (the public skill-name grammar) anywhere
 * in the text — the same word-boundary shape the transcript chip decoration
 * uses, so a gesture reads as one wherever it sits in the sentence. A second
 * `/` or any non-boundary character breaks the match, which keeps file paths
 * (`/usr/bin`) and fractions (`5/8`) out.
 */
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g

/**
 * `/name` gesture tokens from the claimed user messages, deduplicated in
 * first-seen order. Every text block of direct user input is scanned; no
 * other source can forge a gesture.
 * @param messages - the step's claimed batch.
 * @returns candidate skill names, unvalidated against the registry.
 */
function invokedSkillNames(messages: readonly UserMessage[]): string[] {
  const names: string[] = []
  for (const message of messages) {
    if ((message.source as { kind?: unknown }).kind !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      for (const match of block.text.matchAll(SKILL_GESTURE)) {
        const name = match[2]
        if (name !== undefined && !names.includes(name)) names.push(name)
      }
    }
  }
  return names
}
