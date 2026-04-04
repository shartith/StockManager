import { Request, Response, NextFunction, RequestHandler } from 'express';
import logger from '../logger';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Wraps async route handlers so thrown errors reach the error middleware */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** Global error handler — register as the LAST middleware */
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    logger.warn({ statusCode: err.statusCode, details: err.details }, err.message);
    res.status(err.statusCode).json({ error: err.message, details: err.details });
    return;
  }

  logger.error({ err }, 'Unhandled server error');
  res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
}
