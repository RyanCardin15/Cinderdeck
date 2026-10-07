import * as GitHubWorkspace from "../deckhand/GitHubWorkspace.ts";
import * as AgentAccess from "../deckhand/AgentAccess.ts";
import * as ActorAccess from "../deckhand/ActorAccess.ts";
import * as CurrentCheckout from "../deckhand/CurrentCheckout.ts";
import * as ManagedCheckoutTransfer from "../deckhand/ManagedCheckoutTransfer.ts";
import * as ManagedWorktreeHandoff from "../deckhand/ManagedWorktreeHandoff.ts";
import * as OwnershipTransitions from "../deckhand/OwnershipTransitions.ts";
import * as HistoryImports from "../deckhand/HistoryImports.ts";
import * as OwnedPreviewCapture from "../deckhand/OwnedPreviewCapture.ts";
import * as OwnedPreviewAttestations from "../deckhand/OwnedPreviewAttestations.ts";
import * as VerificationAttempts from "../deckhand/VerificationAttempts.ts";
import * as Builds from "../deckhand/Builds.ts";
import * as ExternalDebug from "../deckhand/ExternalDebug.ts";
import * as ExternalSessions from "../deckhand/ExternalSessions.ts";
import * as Attention from "../deckhand/Attention.ts";
import * as Verification from "../deckhand/Verification.ts";
import * as GitHubPullRequestCli from "../pullRequest/GitHubPullRequestCli.ts";
import * as GitHubGraphQlBudget from "../sourceControl/githubGraphQlBudget.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as LinkedWorkBridge from "../deckhand/LinkedWorkBridge.ts";
import * as PreviewCapture from "../deckhand/PreviewCapture.ts";
import * as DeckhandRuns from "../deckhand/Runs.ts";
import * as ReviewerLaunch from "../deckhand/ReviewerLaunch.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Layer from "effect/Layer";
import * as OrchestrationCommandReceipts from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import * as OrchestrationEventStore from "../persistence/Layers/OrchestrationEventStore.ts";
import { layer as providerSessionRuntimeLayer } from "../persistence/ProviderSessionRuntime.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { ProviderAuthServiceLive } from "../provider/Layers/ProviderAuthService.ts";
import { layer as agentSessionImporterLayer } from "../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../project/AgentSessionScanner.ts";
import { layer as projectServiceLayer } from "../project/ProjectService.ts";
import { layer as projectSetupScriptRunnerLayer } from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import { layer as checkpointCaptureServiceLayer } from "./CheckpointCaptureService.ts";
import { layer as checkpointServiceLayer } from "./CheckpointService.ts";
import { layer as checkpointRollbackServiceLayer } from "./CheckpointRollbackService.ts";
import { layer as commandPolicyLayer } from "./CommandPolicy.ts";
import { layerFromApplicationReceipts as commandReceiptStoreLayer } from "./CommandReceiptStore.ts";
import { layer as contextHandoffServiceLayer } from "./ContextHandoffService.ts";
import { layer as effectOutboxLayer } from "./EffectOutbox.ts";
import {
  executorLayer as effectExecutorLayer,
  layer as effectWorkerLayer,
} from "./EffectWorker.ts";
import { layerFromStores as eventSinkLayer } from "./EventSink.ts";
import { layerFromOrchestrationEventStore as eventStoreLayer } from "./EventStore.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import { layer as orchestratorLayer } from "./Orchestrator.ts";
import { layer as projectionStoreLayer } from "./ProjectionStore.ts";
import { layer as projectionMaintenanceLayer } from "./ProjectionMaintenance.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { layerFromProviderInstanceRegistry as providerAdapterRegistryLayerFromProviderInstances } from "./ProviderAdapterRegistry.ts";
import { layer as providerContinuationRequestsLayer } from "./ProviderContinuationRequests.ts";
import { workerLive as providerContinuationWorkerLive } from "./ProviderContinuationService.ts";
import { layer as threadTitleRegenerationServiceLayer } from "./ThreadTitleRegenerationService.ts";
import { layer as providerEventIngestorLayer } from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { layer as providerSessionManagerLayer } from "./ProviderSessionManager.ts";
import { layer as providerRuntimeRecoveryLayer } from "./ProviderRuntimeRecoveryService.ts";
import { layer as providerSwitchServiceLayer } from "./ProviderSwitchService.ts";
import { layer as providerTurnControlServiceLayer } from "./ProviderTurnControlService.ts";
import { layer as providerTurnStartServiceLayer } from "./ProviderTurnStartService.ts";
import { layer as runExecutionServiceLayer } from "./RunExecutionService.ts";
import { layer as runFinalizationServiceLayer } from "./RunFinalizationService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as DeckhandRecordings from "../deckhand/Recordings.ts";
import * as RecordingTransport from "../deckhand/RecordingTransport.ts";
import * as IntegrationDiscovery from "../deckhand/IntegrationDiscovery.ts";
import * as CinderdeckClient from "../deckhand/CinderdeckClient.ts";
import * as DeckhandThreadContext from "../deckhand/ThreadContext.ts";
import * as ManagedSessions from "../deckhand/ManagedSessions.ts";
import * as ManagedSessionLaunch from "../deckhand/ManagedSessionLaunch.ts";
import * as WorkspaceBackend from "../deckhand/WorkspaceBackend.ts";
import * as ManagedProviderAdapters from "../deckhand/ManagedProviderAdapters.ts";
import * as ManagedCheckoutGuard from "../deckhand/ManagedCheckoutGuard.ts";
import * as CheckoutIdentity from "../deckhand/CheckoutIdentity.ts";
import * as Relationships from "../deckhand/Relationships.ts";
import * as IntegrationHub from "../deckhand/IntegrationHub.ts";
import * as ProcessRunner from "../processRunner.ts";
import { layer as runtimeRequestServiceLayer } from "./RuntimeRequestService.ts";
import { layerWithLegacyImporter as threadManagementServiceLayer } from "./ThreadManagementService.ts";
import { layer as threadLaunchServiceLayer } from "./ThreadLaunchService.ts";
import { layer as threadLifecycleServiceLayer } from "./ThreadLifecycleService.ts";
import { layer as threadForkServiceLayer } from "./ThreadForkService.ts";
import { layer as turnItemPositionStoreLayer } from "./TurnItemPositionStore.ts";
import { layer as scheduledTaskServiceLayer } from "../scheduledTasks/ScheduledTaskService.ts";

/** The shared application event log and its command receipts. */
export const OrchestrationEventInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationEventStore.OrchestrationEventStoreLive,
  OrchestrationCommandReceipts.OrchestrationCommandReceiptRepositoryLive,
);

const runtimePolicyProvided = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provide(ProjectStore.layer),
);

const eventStoreProvided = eventStoreLayer.pipe(
  Layer.provide(OrchestrationEventInfrastructureLayerLive),
);
const commandReceiptStoreProvided = commandReceiptStoreLayer.pipe(
  Layer.provide(OrchestrationEventInfrastructureLayerLive),
);

const storesLayer = Layer.mergeAll(
  OrchestrationEventInfrastructureLayerLive,
  eventStoreProvided,
  projectionStoreLayer,
  ProjectStore.layer,
  commandReceiptStoreProvided,
  effectOutboxLayer,
  turnItemPositionStoreLayer,
);

const currentCheckoutProvided = CurrentCheckout.layer.pipe(Layer.provide(Relationships.layer));
export const OrchestrationV2EventSinkLayerLive = eventSinkLayer.pipe(
  Layer.provide(storesLayer),
  Layer.provide(
    ManagedCheckoutTransfer.layer.pipe(
      Layer.provide(Layer.merge(Relationships.layer, currentCheckoutProvided)),
    ),
  ),
);
const eventSinkProvided = OrchestrationV2EventSinkLayerLive;
const projectionMaintenanceProvided = projectionMaintenanceLayer.pipe(Layer.provide(storesLayer));
const legacyV1ThreadImporterProvided = LegacyV1ThreadImporter.layer.pipe(
  Layer.provide(eventSinkProvided),
);

export const ProjectServiceLayerLive = projectServiceLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectStore.layer,
      projectionStoreLayer,
      eventSinkProvided,
      idAllocatorLayer,
      legacyV1ThreadImporterProvided,
    ),
  ),
);

const providerEventIngestorProvided = providerEventIngestorLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      eventSinkProvided,
      idAllocatorLayer,
      projectionStoreLayer,
      ThreadCommandExecutor.layer,
    ),
  ),
);

const checkpointServiceProvided = checkpointServiceLayer.pipe(Layer.provide(idAllocatorLayer));
const contextHandoffServiceProvided = contextHandoffServiceLayer.pipe(
  Layer.provide(idAllocatorLayer),
);

const managedCheckoutGuardProvided = ManagedCheckoutGuard.layer.pipe(
  Layer.provide(Relationships.layer),
  Layer.provide(CheckoutIdentity.layer.pipe(Layer.provide(ProcessRunner.layer))),
  Layer.provide(IntegrationHub.layerLive),
);
const providerAdapterRegistryProvided = ManagedProviderAdapters.layer.pipe(
  Layer.provide(providerAdapterRegistryLayerFromProviderInstances),
  Layer.provide(managedCheckoutGuardProvided),
);
const providerSwitchServiceProvided = providerSwitchServiceLayer.pipe(
  Layer.provide(providerAdapterRegistryProvided),
);

const providerSessionManagerProvided = providerSessionManagerLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      providerAdapterRegistryProvided,
      eventSinkProvided,
      idAllocatorLayer,
      providerEventIngestorProvided,
      projectionStoreLayer,
    ),
  ),
);

const providerAuthServiceProvided = ProviderAuthServiceLive.pipe(
  Layer.provide(Layer.merge(projectionStoreLayer, providerSessionManagerProvided)),
);

const runExecutionServiceProvided = runExecutionServiceLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      checkpointServiceProvided,
      eventSinkProvided,
      idAllocatorLayer,
      providerEventIngestorProvided,
    ),
  ),
);

const providerTurnStartServiceProvided = providerTurnStartServiceLayer.pipe(
  Layer.provide(managedCheckoutGuardProvided),
  Layer.provide(
    Layer.mergeAll(
      contextHandoffServiceProvided,
      eventSinkProvided,
      idAllocatorLayer,
      projectionStoreLayer,
      providerSessionManagerProvided,
      providerAuthServiceProvided,
      runExecutionServiceProvided,
      runtimePolicyProvided,
    ),
  ),
);

const providerTurnControlServiceProvided = providerTurnControlServiceLayer.pipe(
  Layer.provide(Layer.merge(projectionStoreLayer, providerSessionManagerProvided)),
);
const runtimeRequestServiceProvided = runtimeRequestServiceLayer.pipe(
  Layer.provide(Layer.merge(projectionStoreLayer, providerSessionManagerProvided)),
);
const checkpointRollbackServiceProvided = checkpointRollbackServiceLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectStore.layer,
      checkpointServiceProvided,
      eventSinkProvided,
      idAllocatorLayer,
      projectionStoreLayer,
      providerSessionManagerProvided,
      runtimePolicyProvided,
    ),
  ),
);
const checkpointCaptureServiceProvided = checkpointCaptureServiceLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      checkpointServiceProvided,
      eventSinkProvided,
      idAllocatorLayer,
      projectionStoreLayer,
    ),
  ),
);
const runFinalizationServiceProvided = runFinalizationServiceLayer.pipe(
  Layer.provide(Layer.merge(checkpointCaptureServiceProvided, projectionStoreLayer)),
);

const orchestratorProvided = orchestratorLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      checkpointServiceProvided,
      commandPolicyLayer,
      storesLayer,
      eventSinkProvided,
      commandReceiptStoreProvided,
      contextHandoffServiceProvided,
      idAllocatorLayer,
      ProjectStore.layer,
      providerAdapterRegistryProvided,
      // Same layer reference as the continuation worker and the adapter
      // infrastructure so layer memoization yields one shared request queue.
      providerContinuationRequestsLayer,
      providerEventIngestorProvided,
      runtimePolicyProvided,
      providerSessionManagerProvided,
      providerSwitchServiceProvided,
      runExecutionServiceProvided,
      threadForkServiceLayer,
    ),
  ),
);

const agentSessionImporterProvided = agentSessionImporterLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      AgentSessionScanner.layer,
      ProjectServiceLayerLive,
      orchestratorProvided,
      eventSinkProvided,
      idAllocatorLayer,
      providerSessionRuntimeLayer,
    ),
  ),
);

const threadManagementProvided = threadManagementServiceLayer.pipe(
  Layer.provide(Layer.merge(orchestratorProvided, legacyV1ThreadImporterProvided)),
);
export const ProjectSetupScriptRunnerLayerLive = projectSetupScriptRunnerLayer.pipe(
  Layer.provide(ProjectServiceLayerLive),
);
const managedProjectFoldersProvided = ManagedProjectFolders.layer.pipe(
  Layer.provide(ProjectServiceLayerLive),
);
const threadLaunchProvided = threadLaunchServiceLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectServiceLayerLive,
      ProjectSetupScriptRunnerLayerLive,
      managedProjectFoldersProvided,
      threadManagementProvided,
      commandReceiptStoreProvided,
      idAllocatorLayer,
    ),
  ),
);
const threadLifecycleProvided = threadLifecycleServiceLayer.pipe(
  Layer.provide(threadManagementProvided),
);
const scheduledTaskProvided = scheduledTaskServiceLayer.pipe(
  Layer.provide(Layer.mergeAll(threadLaunchProvided, threadManagementProvided)),
);
const providerContinuationWorkerProvided = providerContinuationWorkerLive.pipe(
  Layer.provide(
    Layer.mergeAll(providerContinuationRequestsLayer, threadManagementProvided, idAllocatorLayer),
  ),
);
const threadTitleRegenerationProvided = threadTitleRegenerationServiceLayer.pipe(
  Layer.provide(Layer.mergeAll(threadManagementProvided, ProjectStore.layer, TextGeneration.layer)),
);
const effectExecutorProvided = effectExecutorLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      runFinalizationServiceProvided,
      checkpointRollbackServiceProvided,
      providerSessionManagerProvided,
      providerTurnControlServiceProvided,
      providerTurnStartServiceProvided,
      runtimeRequestServiceProvided,
      threadTitleRegenerationProvided,
      threadManagementProvided,
    ),
  ),
);
const effectWorkerProvided = effectWorkerLayer.pipe(
  Layer.provide(Layer.merge(storesLayer, effectExecutorProvided)),
);
const providerRuntimeRecoveryProvided = providerRuntimeRecoveryLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      effectWorkerProvided,
      storesLayer,
      eventSinkProvided,
      idAllocatorLayer,
      projectionStoreLayer,
    ),
  ),
);

export const OrchestrationV2LayerLive = Layer.mergeAll(
  orchestratorProvided,
  threadManagementProvided,
  effectWorkerProvided,
  providerSessionManagerProvided,
  providerAuthServiceProvided,
  providerRuntimeRecoveryProvided,
  projectionMaintenanceProvided,
  legacyV1ThreadImporterProvided,
);

const externalSessionsProvided = ExternalSessions.layer.pipe(
  Layer.provide(Layer.mergeAll(Relationships.layer, IntegrationHub.layerLive)),
);
const deckhandTransportProvided = RecordingTransport.layer.pipe(
  Layer.provide(CinderdeckClient.layer),
  Layer.provide(
    IntegrationDiscovery.layer.pipe(
      Layer.provideMerge(IntegrationDiscovery.configLayer),
      Layer.provide(IntegrationDiscovery.hostLayer.pipe(Layer.provide(ProcessRunner.layer))),
    ),
  ),
);
const deckhandRecordingsProvided = DeckhandRecordings.layer.pipe(
  Layer.provide(AuthSessions.layer),
  Layer.provide(deckhandTransportProvided),
);
const managedLaunchDependencies = Layer.mergeAll(
  threadLaunchProvided,
  ProjectServiceLayerLive,
  providerAdapterRegistryProvided,
  Relationships.layer,
  ProcessRunner.layer,
  CheckoutIdentity.layer.pipe(Layer.provide(ProcessRunner.layer)),
  WorkspaceBackend.layerLive,
);
const managedLaunchProvided = ManagedSessionLaunch.layer.pipe(
  Layer.provide(managedLaunchDependencies),
);
const reviewerLaunchProvided = ReviewerLaunch.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      managedLaunchProvided,
      managedLaunchDependencies,
      providerSessionManagerProvided,
      projectionStoreLayer,
    ),
  ),
);
const verificationProvided = Verification.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Relationships.layer,
      deckhandRecordingsProvided,
      GitHubPullRequestCli.layer.pipe(
        Layer.provide(GitHubCli.layer),
        Layer.provide(GitHubGraphQlBudget.layer),
      ),
    ),
  ),
);
const buildsProvided = Builds.layer.pipe(Layer.provide(deckhandTransportProvided));
const managedSessionsProvided = ManagedSessions.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      IntegrationHub.layerLive,
      Relationships.layer,
      projectionStoreLayer,
      eventSinkProvided,
      externalSessionsProvided,
      currentCheckoutProvided,
    ),
  ),
);
const ownershipTransitionsProvided = OwnershipTransitions.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      currentCheckoutProvided,
      Relationships.layer,
      IntegrationHub.layerLive,
      CheckoutIdentity.layer.pipe(Layer.provide(ProcessRunner.layer)),
      projectionStoreLayer,
    ),
  ),
);
const ownedPreviewAttestationsProvided = OwnedPreviewAttestations.layer;
const verificationAttemptsProvided = VerificationAttempts.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      currentCheckoutProvided,
      ownedPreviewAttestationsProvided,
      buildsProvided,
      verificationProvided,
      deckhandRecordingsProvided,
      Relationships.layer,
      WorkspaceBackend.layerLive,
      CheckoutIdentity.layer.pipe(Layer.provide(ProcessRunner.layer)),
      ProcessRunner.layer,
    ),
  ),
);
const ownedPreviewCaptureProvided = OwnedPreviewCapture.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      currentCheckoutProvided,
      ownedPreviewAttestationsProvided,
      verificationAttemptsProvided,
      deckhandTransportProvided,
      buildsProvided,
      deckhandRecordingsProvided,
      Relationships.layer,
    ),
  ),
);
export const OrchestrationV2ProductionLayerLive = Layer.mergeAll(
  ExternalDebug.layerLive,
  ActorAccess.layer,
  HistoryImports.layer,
  currentCheckoutProvided,
  ownershipTransitionsProvided,
  ManagedWorktreeHandoff.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        currentCheckoutProvided,
        Relationships.layer,
        WorkspaceBackend.layerLive,
        CheckoutIdentity.layer.pipe(Layer.provide(ProcessRunner.layer)),
        threadManagementProvided,
      ),
    ),
  ),
  ownedPreviewAttestationsProvided,
  ownedPreviewCaptureProvided,
  OrchestrationV2LayerLive.pipe(Layer.provide(ProjectServiceLayerLive)),
  ProjectServiceLayerLive,
  deckhandRecordingsProvided,
  verificationProvided,
  verificationAttemptsProvided,
  PreviewCapture.layer.pipe(
    Layer.provide(Layer.mergeAll(Relationships.layer, deckhandTransportProvided)),
  ),
  managedProjectFoldersProvided,
  threadLaunchProvided,
  managedSessionsProvided,
  DeckhandThreadContext.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Relationships.layer,
        IntegrationHub.layerLive,
        managedSessionsProvided,
        currentCheckoutProvided,
        projectionStoreLayer,
      ),
    ),
  ),
  managedLaunchProvided,
  reviewerLaunchProvided,
  externalSessionsProvided,
  Attention.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        projectionStoreLayer,
        IntegrationHub.layerLive,
        DeckhandRuns.layer.pipe(Layer.provide(deckhandTransportProvided)),
      ),
    ),
  ),
  LinkedWorkBridge.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Relationships.layer,
        deckhandTransportProvided,
        IntegrationHub.layerLive,
        CheckoutIdentity.layer.pipe(Layer.provide(ProcessRunner.layer)),
        managedSessionsProvided,
        currentCheckoutProvided,
      ),
    ),
  ),
  DeckhandRuns.layer.pipe(Layer.provide(deckhandTransportProvided)),
  threadLifecycleProvided,
  scheduledTaskProvided,
  UsageLimitRecoveryWorker.workerLive.pipe(
    Layer.provide(Layer.mergeAll(projectionStoreLayer, threadManagementProvided)),
  ),
  providerContinuationWorkerProvided,
  agentSessionImporterProvided,
).pipe(
  Layer.provide(Scheduler.layer),
  Layer.provideMerge(OrchestrationEventInfrastructureLayerLive),
  // Export the same memoized native integration services to route registration.
  // The WebSocket and managed contexts must share one connection/cache lifetime.
  Layer.provideMerge(IntegrationHub.layerLive),
  Layer.provideMerge(GitHubWorkspace.layerLive),
  Layer.provideMerge(AgentAccess.layerLive),
  Layer.provideMerge(WorkspaceBackend.layerLive),
);
