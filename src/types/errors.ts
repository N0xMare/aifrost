export interface AifrostError {
  code: string;
  message: string;
  retryable: boolean;
  providerId?: string;
  agentId?: string;
  generationId?: string;
  details?: unknown;
}

export class AifrostException extends Error {
  readonly error: AifrostError;
  readonly httpStatus: number;

  constructor(error: AifrostError, httpStatus: number) {
    super(error.message);
    this.name = "AifrostException";
    this.error = error;
    this.httpStatus = httpStatus;
  }
}

export function err(
  code: string,
  message: string,
  httpStatus: number,
  opts: Partial<AifrostError> & { retryable?: boolean } = {},
): AifrostException {
  return new AifrostException(
    {
      code,
      message,
      retryable: opts.retryable ?? false,
      providerId: opts.providerId,
      agentId: opts.agentId,
      generationId: opts.generationId,
      details: opts.details,
    },
    httpStatus,
  );
}
