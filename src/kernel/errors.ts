export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export const Errors = {
  unauthorized: (detail = 'Credenciais inválidas.', details?: unknown) =>
    new AppError('UNAUTHORIZED', detail, 401, details),
  forbidden: (detail = 'Acesso negado.', details?: unknown) => new AppError('FORBIDDEN', detail, 403, details),
  notFound: (detail = 'Recurso não encontrado.', details?: unknown) =>
    new AppError('NOT_FOUND', detail, 404, details),
  conflict: (detail = 'Conflito de estado.', details?: unknown) => new AppError('CONFLICT', detail, 409, details),
  validation: (detail = 'Requisição inválida.', details?: unknown) =>
    new AppError('VALIDATION_ERROR', detail, 422, details),
  rateLimited: () => new AppError('RATE_LIMITED', 'Limite de requisições excedido.', 429),
  unavailable: (detail = 'Serviço temporariamente indisponível.') =>
    new AppError('SERVICE_UNAVAILABLE', detail, 503),
  internal: (detail = 'Falha interna.') => new AppError('INTERNAL_ERROR', detail, 500),
};
