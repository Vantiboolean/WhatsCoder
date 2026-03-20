import WebSocketPkg from 'ws';

const WebSocketServer = WebSocketPkg.Server;

const port = Number(process.env.MOCK_APP_SERVER_PORT ?? '4500');
const enabledScenarios = (process.env.MOCK_APP_SERVER_SCENARIOS
  ?? 'elicitation-form,elicitation-url,auth-refresh,dynamic-success,dynamic-failure,dynamic-empty,dynamic-multi')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

const threadId = 'thr-live-debug';
const thread = {
  id: threadId,
  preview: 'Live debug thread for desktop request handling',
  name: 'Live Debug Requests',
  ephemeral: false,
  modelProvider: 'mock',
  createdAt: Math.floor(Date.now() / 1000),
  updatedAt: Math.floor(Date.now() / 1000),
  status: { type: 'idle' },
  path: null,
  cwd: 'C:\\Users\\Vantiboolean\\Desktop\\codex-mobile',
  cliVersion: 'mock-live-debug',
  source: 'appServer',
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
};

const knownScenarios = new Set([
  'elicitation-form',
  'elicitation-url',
  'auth-refresh',
  'dynamic-success',
  'dynamic-failure',
  'dynamic-empty',
  'dynamic-multi',
]);

const scenarioQueue = enabledScenarios.filter((name) => knownScenarios.has(name));

const state = {
  ws: null,
  queueStarted: false,
  activeScenarioIndex: -1,
  activeRequestId: null,
  completedTurns: [],
  account: null,
  followUpsSent: false,
};

function log(prefix, payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  process.stdout.write(`[mock-app-server] ${prefix} ${text}\n`);
}

function send(payload) {
  if (!state.ws || state.ws.readyState !== 1) {
    return;
  }
  log('->', payload);
  state.ws.send(JSON.stringify(payload));
}

function threadDetail() {
  return {
    ...thread,
    updatedAt: Math.floor(Date.now() / 1000),
    turns: state.completedTurns,
  };
}

function sendFollowUpNotifications() {
  if (state.followUpsSent || state.completedTurns.length === 0) {
    return;
  }

  state.followUpsSent = true;
  const targetTurn = state.completedTurns.find((turn) => turn.id === 'turn-live-debug-success') ?? state.completedTurns[0];
  const targetTurnId = targetTurn?.id;
  if (!targetTurnId) {
    return;
  }

  send({
    method: 'hook/started',
    params: {
      threadId,
      turnId: targetTurnId,
      run: {
        id: 'hook-run-live-debug',
        eventName: 'sessionStart',
        handlerType: 'command',
        executionMode: 'sync',
        scope: 'project',
        sourcePath: 'C:\\Users\\Vantiboolean\\Desktop\\codex-mobile\\.codex\\hooks\\session-start.ps1',
        displayOrder: 1,
        status: 'running',
        statusMessage: null,
        startedAt: Date.now(),
        completedAt: null,
        durationMs: null,
        entries: [
          { kind: 'context', text: 'Preparing desktop live-debug session context.' },
        ],
      },
    },
  });

  send({
    method: 'hook/completed',
    params: {
      threadId,
      turnId: targetTurnId,
      run: {
        id: 'hook-run-live-debug',
        eventName: 'sessionStart',
        handlerType: 'command',
        executionMode: 'sync',
        scope: 'project',
        sourcePath: 'C:\\Users\\Vantiboolean\\Desktop\\codex-mobile\\.codex\\hooks\\session-start.ps1',
        displayOrder: 1,
        status: 'completed',
        statusMessage: null,
        startedAt: Date.now() - 1200,
        completedAt: Date.now(),
        durationMs: 1200,
        entries: [
          { kind: 'context', text: 'Preparing desktop live-debug session context.' },
          { kind: 'feedback', text: 'Session hook completed successfully.' },
        ],
      },
    },
  });

  send({
    method: 'turn/diff/updated',
    params: {
      threadId,
      turnId: targetTurnId,
      diff: 'diff --git a/apps/desktop/src/App.tsx b/apps/desktop/src/App.tsx\n--- a/apps/desktop/src/App.tsx\n+++ b/apps/desktop/src/App.tsx\n@@ -1,1 +1,2 @@\n-console.log(\"before\");\n+console.log(\"before\");\n+console.log(\"after\");',
    },
  });

  send({
    method: 'rawResponseItem/completed',
    params: {
      threadId,
      turnId: targetTurnId,
      item: {
        type: 'function_call_output',
        call_id: 'raw-live-debug-1',
        output: {
          content: [
            {
              type: 'output_text',
              text: 'desktop-live-debug raw payload',
            },
          ],
        },
      },
    },
  });

  send({
    method: 'fuzzyFileSearch/sessionUpdated',
    params: {
      sessionId: 'ffs-live-debug',
      query: 'desktop auth',
      files: [
        {
          root: 'C:\\Users\\Vantiboolean\\Desktop\\codex-mobile',
          path: 'apps\\desktop\\src\\App.tsx',
          file_name: 'App.tsx',
          score: 0.91,
          indices: [0, 1, 2],
        },
      ],
    },
  });

  send({
    method: 'fuzzyFileSearch/sessionCompleted',
    params: {
      sessionId: 'ffs-live-debug',
    },
  });

  send({
    method: 'thread/realtime/started',
    params: {
      threadId,
      sessionId: 'realtime-live-debug',
    },
  });

  send({
    method: 'thread/realtime/outputAudio/delta',
    params: {
      threadId,
      audio: {
        data: 'AQID',
        sampleRate: 24000,
        numChannels: 1,
        samplesPerChannel: 512,
        itemId: 'realtime-msg-live-debug',
      },
    },
  });

  send({
    method: 'thread/realtime/outputAudio/delta',
    params: {
      threadId,
      audio: {
        data: 'BAUG',
        sampleRate: 24000,
        numChannels: 1,
        samplesPerChannel: 512,
        itemId: 'realtime-msg-live-debug',
      },
    },
  });

  send({
    method: 'thread/realtime/itemAdded',
    params: {
      threadId,
      item: {
        id: 'realtime-msg-live-debug',
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'Realtime desktop live debug message.',
          },
        ],
      },
    },
  });

  send({
    method: 'thread/realtime/itemAdded',
    params: {
      threadId,
      item: {
        type: 'response.cancelled',
        response_id: 'resp-live-debug',
      },
    },
  });

  send({
    method: 'thread/realtime/error',
    params: {
      threadId,
      message: 'Mock realtime transport dropped during desktop live debug.',
    },
  });

  send({
    method: 'thread/realtime/closed',
    params: {
      threadId,
      reason: 'mock-close',
    },
  });

  send({
    method: 'windows/worldWritableWarning',
    params: {
      samplePaths: [
        'C:\\Users\\Vantiboolean\\Desktop\\codex-mobile\\tmp\\world-writable',
      ],
      extraCount: 2,
      failedScan: false,
    },
  });

  send({
    method: 'windowsSandbox/setupCompleted',
    params: {
      mode: 'reuse_existing',
      success: true,
      error: null,
    },
  });

  send({
    method: 'app/list/updated',
    params: {
      data: [
        {
          id: 'mock-desktop-tool',
          name: 'Mock Desktop Tool',
          description: 'Mock app list update for desktop live debug.',
          logoUrl: null,
          logoUrlDark: null,
          distributionChannel: 'local',
          branding: null,
          appMetadata: null,
          labels: { category: 'debug' },
          installUrl: null,
          isAccessible: true,
          isEnabled: true,
          pluginDisplayNames: [],
        },
      ],
    },
  });
}

function buildScenario(index, name) {
  const requestId = 7000 + index + 1;

  switch (name) {
    case 'elicitation-form':
      return {
        name,
        requestId,
        request: {
          id: requestId,
          method: 'mcpServer/elicitation/request',
          params: {
            threadId,
            turnId: null,
            serverName: 'mock-mcp',
            mode: 'form',
            message: 'Mock MCP server needs structured input for live debugging.',
            requestedSchema: {
              type: 'object',
              properties: {
                workspace: {
                  type: 'string',
                  title: 'Workspace',
                  description: 'Name of the workspace to use for this mock request.',
                  minLength: 3,
                },
                priority: {
                  type: 'string',
                  title: 'Priority',
                  description: 'Select the priority to return.',
                  enum: ['low', 'high'],
                  enumNames: ['Low', 'High'],
                  default: 'high',
                },
                shareDiagnostics: {
                  type: 'boolean',
                  title: 'Share diagnostics',
                  description: 'Whether the desktop client agrees to share diagnostics.',
                  default: true,
                },
              },
              required: ['workspace', 'priority'],
            },
            _meta: {
              source: 'mock-live-debug',
              scenario: name,
            },
          },
        },
      };
    case 'elicitation-url':
      return {
        name,
        requestId,
        request: {
          id: requestId,
          method: 'mcpServer/elicitation/request',
          params: {
            threadId,
            turnId: null,
            serverName: 'mock-mcp',
            mode: 'url',
            message: 'Mock MCP server needs you to complete an external URL flow.',
            url: 'https://example.com/mock-mcp-oauth',
            elicitationId: 'mock-oauth-flow',
            _meta: {
              source: 'mock-live-debug',
              scenario: name,
            },
          },
        },
      };
    case 'auth-refresh':
      return {
        name,
        requestId,
        request: {
          id: requestId,
          method: 'account/chatgptAuthTokens/refresh',
          params: {
            reason: 'unauthorized',
            previousAccountId: 'acc-desktop-live-debug',
          },
        },
      };
    case 'dynamic-success':
    case 'dynamic-failure':
    case 'dynamic-empty':
    case 'dynamic-multi': {
      const suffix = name.replace('dynamic-', '');
      const turnId = `turn-live-debug-${suffix}`;
      const itemId = `item-live-dynamic-${suffix}`;
      const tool =
        name === 'dynamic-failure' ? 'lookup_ticket_failure'
        : name === 'dynamic-empty' ? 'lookup_ticket_empty'
        : name === 'dynamic-multi' ? 'lookup_ticket_multi'
        : 'lookup_ticket_success';
      return {
        name,
        requestId,
        turnId,
        itemId,
        tool,
        arguments: {
          ticket: 'ABC-123',
          expectedMode: suffix,
          includeScreenshot: name !== 'dynamic-empty',
        },
      };
    }
    default:
      return null;
  }
}

function runNextScenario() {
  if (state.activeRequestId != null) {
    return;
  }

  const nextIndex = state.activeScenarioIndex + 1;
  if (nextIndex >= scenarioQueue.length) {
    log('done', 'no more scenarios to send');
    setTimeout(sendFollowUpNotifications, 200);
    return;
  }

  const scenarioName = scenarioQueue[nextIndex];
  const scenario = buildScenario(nextIndex, scenarioName);
  if (!scenario) {
    state.activeScenarioIndex = nextIndex;
    setTimeout(runNextScenario, 100);
    return;
  }

  state.activeScenarioIndex = nextIndex;
  state.activeRequestId = scenario.requestId;

  if (scenario.request) {
    send(scenario.request);
    return;
  }

  send({
    method: 'turn/started',
    params: {
      threadId,
      turn: {
        id: scenario.turnId,
        status: 'inProgress',
        items: [],
        error: null,
      },
    },
  });

  send({
    method: 'item/started',
    params: {
      threadId,
      turnId: scenario.turnId,
      item: {
        type: 'dynamicToolCall',
        id: scenario.itemId,
        tool: scenario.tool,
        arguments: scenario.arguments,
        status: 'inProgress',
      },
    },
  });

  send({
    id: scenario.requestId,
    method: 'item/tool/call',
    params: {
      threadId,
      turnId: scenario.turnId,
      callId: scenario.itemId,
      tool: scenario.tool,
      arguments: scenario.arguments,
    },
  });
}

function completeActiveScenario(message) {
  const scenarioName = scenarioQueue[state.activeScenarioIndex];
  const scenario = buildScenario(state.activeScenarioIndex, scenarioName);
  if (!scenario) {
    state.activeRequestId = null;
    return;
  }

  if (scenarioName === 'auth-refresh' && message.result) {
    state.account = {
      type: 'chatgptAuthTokens',
      planType: typeof message.result.chatgptPlanType === 'string' ? message.result.chatgptPlanType : undefined,
    };
  }

  send({
    method: 'serverRequest/resolved',
    params: {
      threadId,
      requestId: scenario.requestId,
    },
  });

  if (scenario.request) {
    if (scenarioName === 'auth-refresh' && state.account) {
      send({
        method: 'account/updated',
        params: {
          authMode: 'chatgptAuthTokens',
          planType: state.account.planType ?? null,
        },
      });
      send({
        method: 'account/rateLimits/updated',
        params: {
          rateLimits: {
            limitId: 'mock-plus',
            limitName: 'Mock Plus',
            planType: state.account.planType ?? null,
            primary: {
              usedPercent: 12.5,
              windowDurationMins: 60,
              resetsAt: Math.floor(Date.now() / 1000) + 3600,
            },
            secondary: {
              usedPercent: 48.2,
              windowDurationMins: 1440,
              resetsAt: Math.floor(Date.now() / 1000) + 86400,
            },
            credits: {
              hasCredits: true,
              unlimited: false,
              balance: '42.00',
            },
          },
        },
      });
    }

    state.activeRequestId = null;
    setTimeout(runNextScenario, 400);
    return;
  }

  const resultPayload = message.result ?? {};
  const success = message.error ? false : resultPayload.success !== false;
  const item = {
    type: 'dynamicToolCall',
    id: scenario.itemId,
    tool: scenario.tool,
    arguments: scenario.arguments,
    status: success ? 'completed' : 'failed',
    contentItems: Array.isArray(resultPayload.contentItems) ? resultPayload.contentItems : [],
    success,
    error: message.error ? { message: message.error.message } : null,
  };
  const turn = {
    id: scenario.turnId,
    status: success ? 'completed' : 'failed',
    items: [
      {
        type: 'userMessage',
        id: `user-${scenario.turnId}`,
        content: [`Please run the ${scenarioName} live debug scenario.`],
      },
      item,
    ],
    error: message.error ? { message: message.error.message } : null,
  };

  state.completedTurns.push(turn);

  send({
    method: 'item/completed',
    params: {
      threadId,
      turnId: scenario.turnId,
      item,
    },
  });

  send({
    method: 'turn/completed',
    params: {
      threadId,
      turn,
    },
  });

  log('scenario-complete', {
    scenario: scenarioName,
    success,
    contentItems: item.contentItems,
  });

  state.activeRequestId = null;
  setTimeout(runNextScenario, 400);
}

function handleRequest(message) {
  switch (message.method) {
    case 'initialize':
      send({
        id: message.id,
        result: {
          serverInfo: {
            name: 'mock-app-server',
            version: '0.0.2',
          },
        },
      });
      break;
    case 'thread/list':
      send({
        id: message.id,
        result: {
          data: [thread],
          nextCursor: null,
        },
      });
      break;
    case 'thread/read':
      send({
        id: message.id,
        result: {
          thread: threadDetail(),
        },
      });
      if (!state.queueStarted) {
        state.queueStarted = true;
        setTimeout(runNextScenario, 300);
      }
      break;
    case 'model/list':
      send({
        id: message.id,
        result: {
          data: [
            {
              id: 'gpt-5',
              displayName: 'GPT-5 Mock',
              isDefault: true,
            },
          ],
        },
      });
      break;
    case 'account/read':
      send({
        id: message.id,
        result: {
          account: state.account,
          requiresOpenaiAuth: state.account == null,
        },
      });
      break;
    case 'mcpServerStatus/list':
      send({
        id: message.id,
        result: {
          data: [
            {
              name: 'mock-mcp',
              status: 'connected',
            },
          ],
        },
      });
      break;
    case 'config/read':
      send({
        id: message.id,
        result: {},
      });
      break;
    default:
      send({
        id: message.id,
        error: {
          code: -32601,
          message: `Method not implemented in mock server: ${message.method}`,
        },
      });
      break;
  }
}

const server = new WebSocketServer({ port });

server.on('listening', () => {
  log('listening on', `ws://127.0.0.1:${port}`);
  log('scenarios', scenarioQueue);
});

server.on('connection', (ws) => {
  state.ws = ws;
  log('connection', 'desktop client connected');

  ws.on('message', (raw) => {
    const text = raw.toString();
    log('<-', text);

    let message;
    try {
      message = JSON.parse(text);
    } catch (error) {
      log('parse error', String(error));
      return;
    }

    if (message && typeof message.method === 'string') {
      if (typeof message.id !== 'number') {
        log('notification', message.method);
        return;
      }
      handleRequest(message);
      return;
    }

    if (message && typeof message.id === 'number') {
      completeActiveScenario(message);
    }
  });

  ws.on('close', () => {
    log('connection', 'desktop client disconnected');
    state.ws = null;
  });
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
