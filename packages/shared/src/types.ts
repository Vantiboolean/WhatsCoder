export type JsonRpcRequest = {
  method: string;
  id: number;
  params?: Record<string, unknown>;
};

export type JsonRpcNotification = {
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type JsonRpcServerRequest = {
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

export type ServerMessage = JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest;

export type ThreadStatus = {
  type: 'notLoaded' | 'idle' | 'active' | 'systemError';
  activeFlags?: string[];
};

export type GitInfo = {
  sha?: string | null;
  branch?: string | null;
  originUrl?: string | null;
};

export type ThreadSummary = {
  id: string;
  preview: string;
  name?: string | null;
  ephemeral: boolean;
  modelProvider?: string;
  cwd?: string;
  path?: string | null;
  cliVersion?: string;
  source?: string;
  agentNickname?: string | null;
  agentRole?: string | null;
  gitInfo?: GitInfo | null;
  createdAt: number;
  updatedAt?: number;
  status?: ThreadStatus;
};

export type TurnError = {
  message: string;
  codexErrorInfo?: Record<string, unknown> | null;
  additionalDetails?: string | null;
};

export type Turn = {
  id: string;
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  items: ThreadItem[];
  error?: TurnError | null;
};

export type ThreadDetail = ThreadSummary & {
  turns?: Turn[];
};

export type ThreadItemType =
  | 'userMessage'
  | 'agentMessage'
  | 'plan'
  | 'reasoning'
  | 'commandExecution'
  | 'fileChange'
  | 'mcpToolCall'
  | 'dynamicToolCall'
  | 'hook'
  | 'collabAgentToolCall'
  | 'rawResponseItem'
  | 'realtimeAudio'
  | 'webSearch'
  | 'imageView'
  | 'imageGeneration'
  | 'enteredReviewMode'
  | 'exitedReviewMode'
  | 'contextCompaction';

export type ThreadUserContentItem = {
  type: string;
  text?: string;
  text_elements?: unknown[];
  url?: string;
  path?: string;
  imageUrl?: string;
};

export type ToolContentItem = {
  type: string;
  text?: string;
  imageUrl?: string;
};

export type DynamicToolCallContentItem =
  | { type: 'inputText'; text: string }
  | { type: 'inputImage'; imageUrl: string };

export type ChatgptAuthTokensRefreshReason = 'unauthorized';

export type ChatgptAuthTokensRefreshResponse = {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType: string | null;
};

export type WebSearchAction =
  | { type: 'search'; query?: string; queries?: string[] }
  | { type: 'open_page'; url?: string }
  | { type: 'find_in_page'; url?: string; pattern?: string }
  | { type: 'other' };

export type FileUpdateChange = {
  path: string;
  kind: string;
  diff?: string;
};

export type ThreadItem = {
  type: ThreadItemType | string;
  id: string;
  content?: ThreadUserContentItem[] | string[];
  contentItems?: ToolContentItem[] | null;
  text?: string;
  summary?: string | string[];
  phase?: 'commentary' | 'final_answer' | string | null;
  command?: string | string[];
  cwd?: string;
  processId?: string | null;
  status?: string;
  commandActions?: Array<Record<string, unknown>>;
  changes?: FileUpdateChange[];
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: {
    content?: unknown[];
    structuredContent?: unknown | null;
  } | null;
  error?: { message: string } | null;
  progressMessages?: string[];
  success?: boolean | null;
  senderThreadId?: string;
  receiverThreadIds?: string[];
  prompt?: string | null;
  agentsStates?: Record<string, unknown>;
  query?: string;
  action?: WebSearchAction | null;
  path?: string;
  review?: string;
  revisedPrompt?: string | null;
  stdin?: string;
};

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export type ModelInfo = {
  id: string;
  displayName: string;
  isDefault: boolean;
  hidden?: boolean;
  supportsPersonality?: boolean;
  defaultReasoningEffort?: string;
  inputModalities?: string[];
};

export type AccountInfo =
  | {
      type: 'apiKey' | 'chatgpt' | 'chatgptAuthTokens';
      email?: string;
      planType?: string;
    }
  | null;

export type SavedConnection = {
  id: string;
  label: string;
  host: string;
  port: number;
  isDefault: boolean;
};

export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';
