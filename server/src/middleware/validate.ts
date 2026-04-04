import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';

export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const issues = result.error.issues.map((e) => ({
        path: e.path.map(String).join('.'),
        message: e.message,
      }));
      res.status(400).json({ error: '입력 데이터가 유효하지 않습니다.', details: issues });
      return;
    }
    req.body = result.data;
    next();
  };
}
