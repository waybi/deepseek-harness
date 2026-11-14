/**
 * Round-age image hydration: resend only the most recent rounds' images.
 *
 * Before each model request, every image produced `retainRounds` or more turns
 * ago becomes a text placeholder naming the image, its encoded size, and the
 * read-only stored copy the model can still read with its file tools. The
 * durable `user/message` and `tool/result` events keep their images, so replay
 * recovers the exact conversation; only the request face changes, through the
 * `image/rehydrate` message projection.
 *
 * This is the standing counterpart of `dsh-compaction-image-offload`, which
 * reacts to a provider's image budget. Both decisions coexist: hydration
 * never touches an occurrence the offload decision already omitted, and the
 * offload recovery keeps working on the images hydration retained.
 *
 * @module @deepseek-ai/dsh-compaction-image-rehydrate
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
// Type-only: the `ctx.sessionProjections` Context merge for the declared injection.
import type {} from '@deepseek-ai/dsh-session-projection'
// Type-only: the `ctx.attachments` merge for the optional attachment store.
import type {} from '@deepseek-ai/dsh-attachment'
// Type-only: the `ctx.fs` merge for the optional filesystem provider.
import type {} from '@deepseek-ai/dsh-fs'
import { DEFAULTS, resolveConfig } from './config.ts'
import { imageRehydrateProjection, imageSurfaceProjection } from './projection.ts'
import type { ImageSurfaceState } from './projection.ts'
import type {
  ImageRehydrateConfig,
  ImageRehydrateTarget,
  RehydrateResult,
  RehydratedImage,
  ResolvedConfig,
} from './types.ts'

export { DEFAULTS, imagePlaceholder, resolveConfig } from './config.ts'
export { imageRehydrateProjection, imageSurfaceProjection, rehydrateMessageImages } from './projection.ts'
export type { ImageSurfaceNode, ImageSurfaceState } from './projection.ts'
export type {
  ImageRehydrateConfig,
  ImageRehydrateTarget,
  RehydrateResult,
  RehydratedImage,
  ResolvedConfig,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    imageRehydrate: ImageRehydrate
  }
}

/** Round-age replacement of old conversation images on the request face. */
export class ImageRehydrate extends Service {
  static inject = ['sessions', 'sessionProjections']

  static Config: z<ImageRehydrateConfig> = z.object({
    retainRounds: z.number().step(1).min(1).default(DEFAULTS.retainRounds),
    enabled: z.boolean().default(DEFAULTS.enabled),
  })

  /** Resolved and immutable hydration policy. */
  readonly config: ResolvedConfig
  /** Awaited registration of the surface index; absent until the service initializes. */
  private handle: ProjectionHandle<ImageSurfaceState> | undefined

  constructor(ctx: Context, config: ImageRehydrateConfig = {}) {
    super(ctx, 'imageRehydrate')
    this.config = resolveConfig(config)
    ctx.sessions.registerMessageProjection(imageRehydrateProjection)
    // Prepended so hydration lands before compacting listeners measure the
    // request; a relieved surface may then avoid summarization.
    ctx.on('agent/pre-step', async ({ agent, turn, signal }, next): Promise<PreStepDecision> => {
      if (!signal.aborted) {
        try {
          const result = this.rehydrateSession(agent.session, turn)
          if (result.replaced.length > 0) {
            ctx.logger.info(
              `image rehydrate (turn ${turn}): replaced ${result.replaced.length} image(s) `
              + `older than ${this.config.retainRounds} rounds (${result.bytesReleased} bytes released)`,
            )
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`image rehydrate failed: ${message}; continuing the turn`)
        }
      }
      return next()
    }, { prepend: true })
  }

  /** Await the surface-index registration before publishing this service. */
  protected async [Service.init](): Promise<void> {
    this.handle = await this.ctx.sessionProjections.register(imageSurfaceProjection)
  }

  /**
   * Whether an image produced in `producedTurn` is older than the retained rounds.
   * @param producedTurn - turn that produced the image.
   * @param currentTurn - turn whose request is being prepared.
   * @returns true once `retainRounds` or more turns have started since `producedTurn`.
   */
  isOld(producedTurn: number, currentTurn: number): boolean {
    return currentTurn - producedTurn >= this.config.retainRounds
  }

  /**
   * Resolve the read-only stored copy of one durable image reference for the
   * current tool execution world. Without an attachment store and a filesystem
   * provider, no path exists and the image stays in the request.
   * @param ref - durable normalized attachment.
   * @returns an absolute read-only path, or undefined when this composition has none.
   */
  imagePath(ref: ImageAttachmentRef): string | undefined {
    const attachments = this.ctx.get('attachments')
    const fs = this.ctx.get('fs')
    if (attachments === undefined || fs === undefined) return undefined
    return resolveImageAttachmentAccess(attachments, path => fs.processPathFromHostPath(path), ref)?.readonlyPath
  }

  /**
   * Replace every image older than the retained rounds with its placeholder on
   * the request face. One durable `image/rehydrate` decision names the exact
   * occurrences; occurrences that are already offloaded, or whose stored copy
   * has no readable path in this composition, keep their images and are
   * reported once per pass.
   * @param session - session whose request face may change.
   * @param currentTurn - turn whose request is being prepared.
   * @returns the landed replacements and the encoded bytes released.
   * @throws when the session rejects the decision; earlier replacements inside
   * the same decision are not durable on their own.
   */
  rehydrateSession(session: Session, currentTurn: number): RehydrateResult {
    const empty: RehydrateResult = { replaced: [], bytesReleased: 0 }
    if (!this.config.enabled || this.handle === undefined) return empty
    const state = this.handle.stateOf(session)
    if (state.nodes.length === 0) return empty
    const projected = new Map(session.deriveMessages().map(message => [message.id, message]))
    const targets: ImageRehydrateTarget[] = []
    const replaced: RehydratedImage[] = []
    let bytesReleased = 0
    let unreadable = 0
    for (const node of state.nodes) {
      if (!this.isOld(node.turn, currentTurn)) continue
      const message = projected.get(node.messageId)
      if (message === undefined) continue
      const images: ImageRehydrateTarget['images'] = []
      let imageIndex = 0
      for (const block of message.content) {
        if (block.type !== 'image') continue
        const occurrence = imageIndex
        imageIndex += 1
        if (block.offloaded === true) continue
        const path = this.imagePath(block.attachment)
        if (path === undefined) {
          unreadable += 1
          continue
        }
        images.push({ imageIndex: occurrence, path })
        replaced.push({ seq: node.seq, imageIndex: occurrence, path, bytes: block.attachment.bytes })
        bytesReleased += block.attachment.bytes
      }
      if (images.length > 0) targets.push({ seq: node.seq, images })
    }
    if (unreadable > 0) {
      this.ctx.logger.warn(
        `image rehydrate: kept ${unreadable} old image(s) without a readable stored path; `
        + 'mount the attachment and filesystem providers to release them',
      )
    }
    if (targets.length === 0) return empty
    session.append('image/rehydrate', { targets })
    return { replaced, bytesReleased }
  }
}

export default ImageRehydrate
