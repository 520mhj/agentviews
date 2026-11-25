import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const ROOT_DIRECTORY = fileURLToPath(new URL('../../', import.meta.url));
export const resourcePath = (...segments) => join(ROOT_DIRECTORY, ...segments);
