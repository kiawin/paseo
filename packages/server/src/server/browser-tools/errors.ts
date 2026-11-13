import type {
  BrowserAutomationErrorCode,
  BrowserAutomationExecuteResponse,
  BrowserHostTarget,
  BrowserToolsErrorPayload,
  BrowserToolsResponsePayload,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";

export type { BrowserHostTarget, BrowserToolsErrorPayload, BrowserToolsResponsePayload };

type BrowserHostFailure = Extract<BrowserAutomationExecuteResponse["payload"], { ok: false }>;

export class BrowserToolsRequestError extends Error {
  public readonly code: BrowserAutomationErrorCode;
  public readonly retryable: boolean;

  public constructor(error: BrowserHostFailure["error"]) {
    super(error.message);
    this.name = "BrowserToolsRequestError";
    this.code = error.code;
    this.retryable = error.retryable;
  }
}

export function browserToolsFailure(params: {
  requestId: string;
  code: BrowserToolsErrorPayload["code"];
  message: string;
  retryable?: boolean;
  browserHosts?: BrowserHostTarget[];
}): BrowserToolsResponsePayload {
  return {
    requestId: params.requestId,
    ok: false,
    error: {
      code: params.code,
      message: params.message,
      retryable: params.retryable ?? false,
      ...(params.browserHosts ? { browserHosts: params.browserHosts } : {}),
    },
  };
}

export function createBrowserToolsRequestError(params: {
  code: BrowserAutomationErrorCode;
  message: string;
  retryable?: boolean;
}): BrowserToolsRequestError {
  return new BrowserToolsRequestError({
    code: params.code,
    message: params.message,
    retryable: params.retryable ?? false,
  });
}
