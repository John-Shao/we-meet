/**
 * Work R0a frontend UI-state contract.
 *
 * The server's TaskSummary.display_state is the single source of truth for the
 * task UI state. The frontend maps it to labels, banners and actions; it must
 * not infer a second state machine from raw Run/Operation fields.
 */

export type DisplayState =
  | 'open'
  | 'queued'
  | 'running'
  | 'awaiting_acceptance'
  | 'completed'
  | 'failed'
  | 'run_canceled'
  | 'reconciling'
  | 'budget_exhausted'
  | 'canceling'
  | 'canceled'
  | 'archived';

// 'canceled' | 'archived' are reserved for R0b; R0a has no API that produces them.
export type TaskState = 'open' | 'awaiting_acceptance' | 'completed' | 'canceled' | 'archived';

export type UiActionId =
  | 'cancel'
  | 'retry'
  | 'accept'
  | 'open_artifact'
  | 'view_artifact_readonly'
  | 'export'
  | 'continue'
  | 'view_error'
  | 'view_timeline'
  | 'view_budget';

export type Tone = 'neutral' | 'active' | 'attention' | 'success' | 'danger' | 'warning';

export interface StateEntry {
  labelKey: string;
  tone: Tone;
  actions: UiActionId[];
  primaryAction: UiActionId | null;
  bannerKey: string | null;
}

export interface ActionEntry {
  labelKey: string;
  destructive: boolean;
  requiresConfirm: boolean;
}

export interface StateMatrix {
  version: string;
  states: Record<DisplayState, StateEntry>;
  actions: Record<UiActionId, ActionEntry>;
  constraints: {
    accept: {
      onlyStates: DisplayState[];
      requiresPendingAcceptance: boolean;
      requiresNoBlockingOperations: boolean;
    };
    retry: { onlyStates: DisplayState[] };
    cancel: { onlyStates: DisplayState[] };
  };
}

export interface RoutesConfig {
  version: string;
  routes: {
    home: string;
    composer: string;
    items: string;
    task: string;
    artifact: string;
    archive: string;
    admin: string;
  };
  views: string[];
  legacy: {
    noticeKey: string;
    rules: Array<{ when: string; to: string }>;
  };
}

export interface TaskSummaryView {
  task_id: string;
  display_state: DisplayState;
  task_state: TaskState;
  pending_acceptance: boolean;
  blocking_operations: number;
}

export interface TaskUiModel {
  displayState: DisplayState;
  labelKey: string;
  tone: Tone;
  actions: UiActionId[];
  primaryAction: UiActionId | null;
  bannerKey: string | null;
  canAccept: boolean;
  canRetry: boolean;
  canCancel: boolean;
  artifactReadOnly: boolean;
}

export interface PrepareGate {
  featureEnabled: boolean;
  workSeat: boolean;
  goal: string;
  maxGoalChars: number;
  busy: boolean;
}

export interface SubmitGate extends PrepareGate {
  hasPreview: boolean;
  previewStale: boolean;
}

export type InboxType = 'acceptance_required' | 'failed' | 'reconciling';
