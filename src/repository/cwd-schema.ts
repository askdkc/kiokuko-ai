import path from 'node:path';
import * as z from 'zod/v4';

/** Validate one explicitly supplied MCP working directory before filesystem access. */
export const absoluteCwdSchema = z.string()
  .min(1)
  .refine(path.isAbsolute, { message: 'cwd must be an absolute path' })
  .refine((value) => !value.includes('\0'), { message: 'cwd must not contain NUL' });
