import { WorkerEntrypoint } from "cloudflare:workers";
import type { CollaboratorRole } from "@gadgets/workshop-shared/api";
import type { PluginRuntimeRealmIdentity } from "./dynamic-worker-plugin-activator.js";

/** Host-minted immutable authority claim captured in one Dynamic Worker Service Binding. */
export interface PluginRuntimeLoopbackProps {
  /** Owning workspace Durable Object ID. */
  readonly overseerId: string;

  /** Authenticated User Durable Object ID. */
  readonly userId: string;

  /** Effective workspace role bound into the runtime policy. */
  readonly role: CollaboratorRole;

  /** Opaque host generation that prevents warm-worker ABA authorization. */
  readonly generation: string;

  /** Package identifier whose gate must be selected. */
  readonly pluginId: string;

  /** Complete activation identity bound into the Dynamic Worker cache key. */
  readonly activationKey: string;

  /** Immutable manifest digest bound to both the gate claim and deployment deny policy. */
  readonly manifestDigest: string;
}

/** Narrow host operations used to enforce one loopback claim without exposing raw namespaces. */
export interface PluginRuntimeLoopbackAuthorityHost {
  /** Checks the central add-only deployment denial before any local authority lookup. */
  isManifestDenied(manifestDigest: string): Promise<boolean>;

  /** Synchronously revokes an exact local claim and may queue physical cleanup. */
  revokeDeniedClaim(props: PluginRuntimeLoopbackProps): void | Promise<void>;

  /** Verifies the exact current-generation local claim for the requested phase. */
  assertGate(
    props: PluginRuntimeLoopbackProps,
    phase: "staged" | "active",
  ): void | Promise<void>;
}

/** Enforces central denial before exact local staged/active authorization. */
export async function assertPluginRuntimeLoopbackClaim(
    props: PluginRuntimeLoopbackProps,
    phase: "staged" | "active",
    host: PluginRuntimeLoopbackAuthorityHost): Promise<void> {
  if (await host.isManifestDenied(props.manifestDigest)) {
    try {
      await host.revokeDeniedClaim(props);
    } catch {
      // The capability call remains denied even if local physical retirement must retry later.
    }
    throw new Error("Plugin manifest is denied.");
  }
  await host.assertGate(props, phase);
}

/** Stable loopback binding that re-enters the owning Overseer for every authority check. */
export class PluginRuntimeLoopback
    extends WorkerEntrypoint<Cloudflare.Env, PluginRuntimeLoopbackProps> {
  /** Allows the fixed host harness to finish only while this exact candidate remains staged. */
  async verifyStaged(): Promise<void> {
    await this.#assert("staged");
  }

  /** Verifies a captured binding still belongs to the currently selected realm activation. */
  async assertActive(): Promise<void> {
    await this.#assert("active");
  }

  async #assert(phase: "staged" | "active"): Promise<void> {
    const identity: PluginRuntimeRealmIdentity = {
      overseerId: this.ctx.props.overseerId,
      userId: this.ctx.props.userId,
      role: this.ctx.props.role,
      generation: this.ctx.props.generation,
    };
    const overseers = this.ctx.exports.OverseerDurableObject;
    const overseer = overseers.get(overseers.idFromString(identity.overseerId));
    await assertPluginRuntimeLoopbackClaim(this.ctx.props, phase, {
      isManifestDenied: manifestDigest => this.ctx.exports.AdminSettings.getByName("")
        .isPluginManifestDeniedForRuntimeHost(manifestDigest),
      revokeDeniedClaim: props => overseer.revokeDeniedPluginRuntimeForHost(
        identity,
        props.pluginId,
        props.activationKey,
        props.manifestDigest,
      ),
      assertGate: (props, claimPhase) => overseer.assertPluginRuntimeGateForHost(
        identity,
        props.pluginId,
        props.activationKey,
        props.manifestDigest,
        claimPhase,
      ),
    });
  }
}
